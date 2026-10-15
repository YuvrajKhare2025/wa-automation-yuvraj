const fs = require('fs');
const {
    getChatbotRules, incrementRuleHitCount, getSetting, getConversation,
    logMessage, getUserById, getMonthlyOutgoingCount
} = require('./database');
const { generateReply } = require('./ai');
const { scheduleAutoAnalysis } = require('./lead-analyzer');
const { safeRegexTest } = require('../utils/validate');
const { conversationQueue } = require('../utils/conversation-queue');
const { getImageFilePath, restoreProductImageIfMissing } = require('./product-storage');

// ─── Anti-Ban Rate Limiting ─────────────────────────────────
const userRateLimits = new Map();

// Without this, every distinct (userId, phone) pair that ever messages in
// stays in memory forever — a slow leak on a long-running server with many
// contacts. Sweep out anything whose 60s window is long over.
const _rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of userRateLimits) {
        if (now - data.firstMsgTime > 5 * 60 * 1000) userRateLimits.delete(key);
    }
}, 10 * 60 * 1000);
_rateLimitCleanup.unref?.();

// Hard bound on the map itself. An attacker who can send from many numbers
// (or a spam wave) would otherwise create one entry per sender between
// sweeps; 100k entries is far past any legitimate volume for one server.
const MAX_RATE_LIMIT_KEYS = 100000;

// How much conversation history to load for AI context. The unbounded
// version loaded the *entire* conversation on every inbound message just to
// take the last 10 — so a customer with a 40k-message history caused 40k
// rows to be materialised per message received, on the shared event loop.
const AI_CONTEXT_MESSAGES = 10;

function isRateLimited(userId, phone) {
    const key = `${userId}:${phone}`;
    const now = Date.now();
    const limitData = userRateLimits.get(key) || { count: 0, firstMsgTime: now };

    // Reset window every 60 seconds
    if (now - limitData.firstMsgTime > 60000) {
        limitData.count = 1;
        limitData.firstMsgTime = now;
    } else {
        limitData.count++;
    }

    if (userRateLimits.size >= MAX_RATE_LIMIT_KEYS && !userRateLimits.has(key)) {
        // Fail closed: refusing to auto-reply is the safe direction when
        // we're already tracking an implausible number of senders.
        return true;
    }
    userRateLimits.set(key, limitData);

    // Allow max 10 messages per minute
    return limitData.count > 10;
}

/** True if this account has hit its plan's monthly outgoing-message cap (0 = unlimited). */
async function isOverPlanLimit(userId) {
    const account = await getUserById(userId);
    if (!account || !account.message_limit) return false;
    return (await getMonthlyOutgoingCount(userId)) >= account.message_limit;
}

/**
 * Matches one rule against incoming text.
 *
 * Extracted so the live path and the /chatbot/test preview cannot drift
 * apart — a preview that says "this matches" while the real path disagrees
 * is worse than no preview. The regex case goes through safeRegexTest,
 * which bounds input length; the pattern itself was already vetted against
 * catastrophic backtracking when the rule was saved (see
 * validate.assertSafeRegexSource). Rules stored before that check existed
 * still run through the same bounded matcher here.
 */
function ruleMatches(rule, text) {
    const keyword = String(rule.trigger_keyword || '').toLowerCase();
    if (keyword === '') return false;

    switch (rule.match_type) {
        case 'exact':      return text === keyword;
        case 'contains':   return text.includes(keyword);
        case 'startswith': return text.startsWith(keyword);
        case 'regex':      return safeRegexTest(rule.trigger_keyword, text);
        default:           return false;
    }
}

// ─── Human Simulation (Delay & Typing) ──────────────────────
async function safeReply(client, phone, responseText, msg, productToSend = null) {
    // Show typing indicator
    if (msg && client) {
        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch (e) {
            // Typing state is cosmetic only — don't fail the reply over it
            console.log('   ⚠️ Could not send typing state (non-fatal):', e.message?.split('\n')[0]);
        }
    }

    // Random human-like delay between 1.5–3 seconds
    const delayMs = Math.floor(Math.random() * 1500) + 1500;
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Extract text and product if responseText is an AI response object
    let textToSend = responseText;
    if (responseText && typeof responseText === 'object') {
        if (!productToSend && responseText.product) {
            productToSend = responseText.product;
        }
        textToSend = responseText.text !== undefined ? responseText.text : String(responseText);
    } else {
        textToSend = String(responseText || '');
    }

    // If a product with an image was selected, deliver media message
    let mediaSent = false;
    if (productToSend && productToSend.image_path) {
        let filePath = getImageFilePath(productToSend.image_path);
        if (!filePath || !fs.existsSync(filePath)) {
            filePath = await restoreProductImageIfMissing(productToSend.image_path);
        }
        if (filePath && fs.existsSync(filePath)) {
            try {
                const { MessageMedia } = require('whatsapp-web.js');
                const media = MessageMedia.fromFilePath(filePath);

                let caption = textToSend;
                let followUp = null;
                // WhatsApp media caption limit is ~1024 characters
                if (caption.length > 1024) {
                    followUp = caption.slice(1000);
                    caption = caption.slice(0, 1000);
                }

                let sent = false;
                if (msg) {
                    try {
                        await msg.reply(media, undefined, { caption });
                        sent = true;
                    } catch (replyErr) {
                        console.warn('   ⚠️ msg.reply(media) failed, falling back to client.sendMessage:', replyErr.message?.split('\n')[0]);
                        if (client) {
                            const target = msg.from || (phone.includes('@') ? phone : `${phone}@c.us`);
                            await client.sendMessage(target, media, { caption });
                            sent = true;
                        } else {
                            throw replyErr;
                        }
                    }
                } else if (client) {
                    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
                    await client.sendMessage(chatId, media, { caption });
                    sent = true;
                }

                if (sent) {
                    mediaSent = true;
                    console.log(`📸 Product image (${productToSend.name || productToSend.id}) delivered via WhatsApp.`);

                    if (followUp) {
                        if (msg) {
                            await msg.reply(followUp);
                        } else if (client) {
                            const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
                            await client.sendMessage(chatId, followUp);
                        }
                    }
                }
            } catch (mediaErr) {
                console.error('   ⚠️ Failed to send product image media, falling back to text reply:', mediaErr.message?.split('\n')[0]);
                mediaSent = false;
            }
        } else {
            console.warn(`   ⚠️ Product image file not found on disk (${productToSend.image_path}), proceeding with text reply.`);
        }
    }

    if (!mediaSent) {
        // Send reply — prefer msg.reply() to avoid WhatsApp LID format issues
        try {
            if (msg) {
                await msg.reply(textToSend);
            } else if (client) {
                const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
                await client.sendMessage(chatId, textToSend);
            }
        } catch (sendErr) {
            console.error('   ❌ Primary reply failed, attempting fallback...', sendErr.message?.split('\n')[0]);
            if (client && msg && msg.from) {
                await client.sendMessage(msg.from, textToSend);
            } else {
                throw sendErr;
            }
        }
    }
}

// ─── Process an incoming message through chatbot rules (serialized) ──────
function processMessage(userId, phone, messageText, contactName = '', client = null, msg = null) {
    return conversationQueue.enqueue(userId, phone, () =>
        _processMessageInternal(userId, phone, messageText, contactName, client, msg)
    );
}

async function _processMessageInternal(userId, phone, messageText, contactName = '', client = null, msg = null) {
    // Log without the message body: this runs for every inbound message, and
    // customer message content in stdout ends up in any log aggregator,
    // container log, or terminal scrollback. Phone is partially masked for
    // the same reason.
    console.log(`🤖 processMessage: user ${userId}, ${maskPhone(phone)} (${messageText.length} chars)`);

    // Always log incoming message to database
    try {
        await logMessage(userId, {
            phone,
            contactName,
            direction: 'incoming',
            body: messageText
        });
    } catch (dbErr) {
        console.error('   ⚠️ Failed to log incoming message to DB:', dbErr.message);
    }

    // Queue a debounced AI lead-analysis of this conversation (runs after the chat goes quiet)
    try {
        scheduleAutoAnalysis(userId, phone);
    } catch (analysisErr) {
        console.error('   ⚠️ Could not schedule lead analysis:', analysisErr.message);
    }

    if (isRateLimited(userId, phone)) {
        console.log(`⚠️ Rate limit exceeded for ${maskPhone(phone)}, ignoring message to prevent ban.`);
        return { replied: false, reason: 'rate_limit' };
    }

    if (await isOverPlanLimit(userId)) {
        console.log(`⚠️ Account ${userId} has hit its monthly message limit — skipping auto-reply.`);
        return { replied: false, reason: 'plan_limit_reached' };
    }

    const chatbotEnabled = await getSetting(userId, 'chatbot_enabled');
    if (chatbotEnabled !== 'true') {
        return { replied: false, reason: 'chatbot_disabled' };
    }

    const aiEnabled = await getSetting(userId, 'ai_enabled');
    const aiMode = (await getSetting(userId, 'ai_mode')) || 'ai_first';

    // ── 1. AI-FIRST PERSONA MODE ──────
    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        const aiSystemPrompt = await getSetting(userId, 'ai_system_prompt');
        const recentHistory = await getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg, aiResponse.product);
            const responseText = aiResponse.text !== undefined ? aiResponse.text : String(aiResponse);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: responseText });
            return { replied: true, rule: 'ai_persona', response: responseText, product: aiResponse.product };
        } catch (aiErr) {
            console.warn('⚠️ AI Persona Mode failed (falling back to rules/default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 2. STATIC AWAY MODE ───────
    const awayMode = await getSetting(userId, 'away_mode');
    if (awayMode === 'true') {
        const awayMessage = await getSetting(userId, 'away_message');
        if (awayMessage) {
            await safeReply(client, phone, awayMessage, msg);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: awayMessage });
            return { replied: true, rule: 'away_mode', response: awayMessage };
        }
    }

    // ── 3. KEYWORD RULES ──
    const text = messageText.trim().toLowerCase();
    const rules = await getChatbotRules(userId, true);

    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;

        let response = rule.response_text;
        response = response.replace(/\{name\}/gi, contactName || 'there');
        response = response.replace(/\{phone\}/gi, phone);

        await safeReply(client, phone, response, msg);
        await logMessage(userId, { phone, contactName, direction: 'outgoing', body: response });
        await incrementRuleHitCount(userId, rule.id);

        return {
            replied: true,
            ruleId: rule.id,
            keyword: rule.trigger_keyword,
            matchType: rule.match_type,
            response
        };
    }

    // ── 4. AI Fallback (rules_first mode, nothing matched) ──
    if (aiEnabled === 'true') {
        const aiSystemPrompt = await getSetting(userId, 'ai_system_prompt');
        const recentHistory = await getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg, aiResponse.product);
            const responseText = aiResponse.text !== undefined ? aiResponse.text : String(aiResponse);
            await logMessage(userId, { phone, contactName, direction: 'outgoing', body: responseText });
            return { replied: true, rule: 'ai_fallback', response: responseText, product: aiResponse.product };
        } catch (aiErr) {
            console.warn('⚠️ AI Fallback failed (falling back to default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 5. Static Default Reply ──
    const defaultReply = await getSetting(userId, 'default_reply');
    if (defaultReply) {
        await safeReply(client, phone, defaultReply, msg);
        await logMessage(userId, { phone, contactName, direction: 'outgoing', body: defaultReply });
        return { replied: true, rule: 'default', response: defaultReply };
    }

    return { replied: false, reason: 'no_match' };
}

/** Masks the middle of a phone number for logs. 919876543210 → 9198****3210 */
function maskPhone(phone) {
    const s = String(phone || '');
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// ─── Test a message against rules without sending ───────────
async function testMessage(userId, messageText) {
    const aiEnabled = await getSetting(userId, 'ai_enabled');
    const aiMode = (await getSetting(userId, 'ai_mode')) || 'ai_first';

    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        return {
            matched: true,
            ruleId: 'ai_persona',
            keyword: 'AI Persona Mode',
            matchType: 'dynamic_ai',
            response: 'Gemini AI will dynamically generate a natural, conversational response acting as you.'
        };
    }

    const text = String(messageText).trim().toLowerCase();
    const rules = await getChatbotRules(userId, true);

    // Same matcher as the live path — see ruleMatches.
    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;
        return {
            matched: true,
            ruleId: rule.id,
            keyword: rule.trigger_keyword,
            matchType: rule.match_type,
            response: rule.response_text
        };
    }

    if (aiEnabled === 'true') {
        return {
            matched: false,
            willSendDefault: false,
            willSendAI: true,
            defaultReply: 'Gemini AI will generate a dynamic response based on your System Prompt.'
        };
    }

    const defaultReply = await getSetting(userId, 'default_reply');
    return {
        matched: false,
        willSendDefault: !!defaultReply,
        willSendAI: false,
        defaultReply: defaultReply || null
    };
}

module.exports = { processMessage, testMessage, ruleMatches, maskPhone };



