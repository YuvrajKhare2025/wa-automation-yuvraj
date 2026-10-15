const express = require('express');
const router = express.Router();

const {
    getContacts, countContacts, upsertContact, bulkUpsertContacts, deleteContact,
    getContactByPhone, getContactsByIds,
    getMessages, countMessages, getConversation,
    getChatbotRules, createChatbotRule, updateChatbotRule, deleteChatbotRule, countChatbotRules,
    getScheduledMessages, createScheduledMessage, cancelScheduledMessage, countPendingScheduledMessages,
    getAllSettings, setSetting, getSetting,
    getDashboardStats, logMessage, logOutgoingMessageIdempotent, findMessageByIdempotencyKey,
    getMonthlyOutgoingCount, clearMessages,
    getLeadAnalyses, getLeadAnalysis, deleteLeadAnalysis, getConversationPhones, getLeadStats,
    getProducts, countProducts, getProductById, searchProducts, createProduct, updateProduct, deleteProduct,
    CRM_STAGES, getCrmDeals, getCrmDealByPhone, getCrmDealById, createCrmDeal,
    updateCrmDeal, deleteCrmDeal, getCrmStats, getCrmAnalytics, addCrmActivity, getCrmActivities,
    assertPersistable, transaction, runSql
} = require('../services/database');

const multer = require('multer');
const {
    saveProductImage, getProductImageAbsolutePath, deleteProductImage,
    getMimeType, isSafeFilename, MAX_IMAGE_SIZE_BYTES
} = require('../services/product-storage');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_SIZE_BYTES }
});

function handleImageUpload(req, res, next) {
    upload.single('image')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                const mb = (MAX_IMAGE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
                return res.status(400).json({ success: false, error: `Image file exceeds maximum limit of ${mb} MB.` });
            }
            return res.status(400).json({ success: false, error: err.message || 'File upload failed' });
        }
        next();
    });
}

const { sendTextMessage, getStatus, initWhatsAppClient, destroyClientForUser } = require('../services/whatsapp-client');
const { testMessage } = require('../services/chatbot');
const { analyzeConversation, analyzeAllConversations } = require('../services/lead-analyzer');
const { analyzeBusinessProfile, getBusinessInfo } = require('../services/business');
const { parseCSV, mapContactRow } = require('../services/csv');
const { startOutreachJob, getOutreachJob, cancelOutreachJob, MAX_RECIPIENTS_PER_JOB } = require('../services/outreach');
const { getApiKey, testApiKey, ALL_GEMINI_MODELS, resetCircuits } = require('../services/gemini-client');
const { asyncHandler } = require('../utils/errors');
const { perUser, concurrencyGate } = require('../middleware/rateLimit');
const {
    LIMITS, ValidationError,
    requireString, optionalString, normalizePhone, clampInt, clampNumber,
    requireId, requireEnum, optionalEnum, toSqliteUtc,
    assertSafeRegexSource, sanitizeSpreadsheetCell, validateSettingsPatch
} = require('../utils/validate');

// One request importing tens of thousands of rows would block the whole
// (single-threaded) server for everyone else while it parses and writes —
// this is a hard cap, not a soft warning, for exactly that reason. Plenty
// of headroom for what an SMB actually has: split anything bigger.
const MAX_IMPORT_ROWS = 5000;
// Raw CSV text arrives as a JSON string, so express.json's own limit applies
// too; this is the parse-time bound, checked before the state machine walks
// the whole string.
const MAX_CSV_BYTES = 2 * 1024 * 1024;

// ─── Per-account write throttles ────────────────────────────────
// Authentication is not a rate limit. A logged-in tenant can otherwise loop
// on any write endpoint and grow the single shared in-memory database (which
// is fully re-exported to disk on every write) until the process dies —
// taking every other tenant with it. These are generous for human use and
// hostile to a loop.
const writeLimiter = perUser('write', {
    windowMs: 60 * 1000,
    max: 300,
    message: 'You are making changes very quickly. Please slow down and try again in a minute.'
});
const sendLimiter = perUser('send', {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Sending too quickly. WhatsApp will flag this — wait a minute before sending more.'
});
const importLimiter = perUser('import', {
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: 'Too many imports in a short time. Please wait a few minutes.'
});
const aiLimiter = perUser('ai', {
    windowMs: 60 * 60 * 1000,
    max: 120,
    message: 'You have used your hourly AI analysis allowance. Please try again later.'
});

/**
 * Caps AI work in flight, globally and per tenant.
 *
 * Every Gemini call is billed and takes up to 30 seconds. Rate limiting
 * alone bounds requests per hour, not how many are open simultaneously —
 * "analyze all conversations" can start hundreds. Without this, one tenant
 * can exhaust the process's outbound sockets and the platform's API quota,
 * which is a financial denial-of-service against every other customer.
 */
const MAX_CONCURRENT_AI_JOBS = parseInt(process.env.MAX_CONCURRENT_AI_JOBS, 10) || 8;
const MAX_CONCURRENT_AI_PER_USER = parseInt(process.env.MAX_CONCURRENT_AI_PER_USER, 10) || 2;
const aiGate = concurrencyGate({ maxGlobal: MAX_CONCURRENT_AI_JOBS, maxPerUser: MAX_CONCURRENT_AI_PER_USER });

function withAiSlot(handler) {
    return asyncHandler(async (req, res, next) => {
        const slot = aiGate.tryAcquire(req.user.id);
        if (!slot.ok) {
            res.setHeader('Retry-After', '20');
            return res.status(429).json({
                success: false,
                error: slot.reason === 'user'
                    ? 'You already have AI analysis running. Wait for it to finish before starting another.'
                    : 'The server is busy with AI analysis right now. Please try again in a moment.',
                code: 'AI_BUSY'
            });
        }
        try {
            await handler(req, res, next);
        } finally {
            aiGate.release(req.user.id);
        }
    });
}

/** Rejects a write when it cannot be durably stored (see database.js). */
function requireDurableWrite(req, res, next) {
    assertPersistable();
    next();
}

// ─────────────────────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────────────────────
router.get('/dashboard/stats', asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const stats = await getDashboardStats(uid);

    // Leads overview
    stats.leads = await getLeadStats(uid);

    // Chats with new/unanalyzed messages
    try {
        const phones = await getConversationPhones(uid);
        const analyses = await getLeadAnalyses(uid);
        const byPhone = new Map(analyses.map(l => [l.phone, l]));
        stats.awaitingAnalysis = phones.filter(p => {
            const existing = byPhone.get(p.phone);
            return !existing || existing.message_count < p.message_count;
        }).length;
    } catch (e) {
        stats.awaitingAnalysis = 0;
    }

    // Sales pipeline overview
    stats.crm = await getCrmStats(uid);
    stats.currency = (await getSetting(uid, 'business_currency')) || '₹';

    // System status
    stats.waConnected = !!getStatus(uid).connected;
    // Whether AI is usable, never the key itself. Returning any prefix or
    // length of a credential to the browser is a leak in waiting.
    const geminiKey = (await getSetting(uid, 'gemini_api_key')) || process.env.GEMINI_API_KEY || '';
    stats.aiConfigured = geminiKey.trim() !== '' && geminiKey !== 'your_gemini_api_key_here';

    // Plan / usage
    stats.plan = req.user.plan;
    stats.messageLimit = req.user.message_limit;
    stats.messagesThisMonth = await getMonthlyOutgoingCount(uid);

    res.json({ success: true, data: stats });
}));

router.get('/status', (req, res) => {
    res.json({ success: true, data: getStatus(req.user.id) });
});

// ─────────────────────────────────────────────────────────────
//  WHATSAPP CONNECTION (per-account)
// ─────────────────────────────────────────────────────────────
// Each connect spawns a headless Chrome (~150-250MB). Repeated calls are
// idempotent inside the client module, but the limiter stops a script from
// hammering connect/disconnect and thrashing browser processes.
const waConnectLimiter = perUser('wa-connect', {
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many WhatsApp connection attempts. Wait a moment before retrying.'
});

router.post('/whatsapp/connect', waConnectLimiter, asyncHandler(async (req, res) => {
    // Only admin accounts or users explicitly granted access may start a
    // WhatsApp session. Regular users default to wa_enabled = 0.
    if (req.user.role !== 'admin' && !req.user.wa_enabled) {
        return res.status(403).json({
            success: false,
            error: 'WhatsApp access has not been enabled for your account. Please contact the administrator.',
            code: 'WA_NOT_ENABLED'
        });
    }
    const result = await initWhatsAppClient(req.user.id);
    if (result && result.accepted === false) {
        return res.status(503).json({ success: false, error: result.reason, code: 'WA_AT_CAPACITY' });
    }
    res.json({ success: true });
}));

router.post('/whatsapp/disconnect', waConnectLimiter, asyncHandler(async (req, res) => {
    await destroyClientForUser(req.user.id);
    res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
//  CONTACTS
// ─────────────────────────────────────────────────────────────
router.get('/contacts', asyncHandler(async (req, res) => {
    // Search text is bounded and label is treated as an exact match. Both go
    // to SQLite as bound parameters (see database.getContacts), so the only
    // thing to enforce here is size.
    const search = optionalString(req.query.search, 'search', LIMITS.SEARCH_QUERY);
    const label = optionalString(req.query.label, 'label', LIMITS.CONTACT_LABEL);
    const limit = clampInt(req.query.limit, { min: 1, max: LIMITS.MAX_PAGE_LIMIT, fallback: LIMITS.MAX_PAGE_LIMIT });
    const offset = clampInt(req.query.offset, { min: 0, max: LIMITS.MAX_OFFSET, fallback: 0 });

    const contacts = await getContacts(req.user.id, search, label, { limit, offset });
    res.json({
        success: true,
        data: contacts,
        meta: { limit, offset, total: await countContacts(req.user.id) }
    });
}));

router.post('/contacts', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const body = req.body || {};
    // normalizePhone is the single gate: it returns digits only, so a client
    // cannot store "…@g.us" (a group) or a raw internal WhatsApp id and have
    // a later send go somewhere it shouldn't.
    const phone = normalizePhone(body.phone);
    const name = sanitizeSpreadsheetCell(optionalString(body.name, 'name', LIMITS.CONTACT_NAME));
    const label = sanitizeSpreadsheetCell(optionalString(body.label, 'label', LIMITS.CONTACT_LABEL));
    const notes = sanitizeSpreadsheetCell(optionalString(body.notes, 'notes', LIMITS.CONTACT_NOTES));

    // Per-tenant cap. The database is one shared in-memory image exported to
    // disk on every write, so one tenant's unbounded growth is everyone's
    // latency and, eventually, everyone's outage.
    if (!(await getContactByPhone(req.user.id, phone)) && (await countContacts(req.user.id)) >= LIMITS.MAX_CONTACTS_PER_USER) {
        return res.status(409).json({
            success: false,
            error: `You have reached the limit of ${LIMITS.MAX_CONTACTS_PER_USER.toLocaleString()} contacts. Delete some before adding more.`,
            code: 'CONTACT_LIMIT'
        });
    }

    const contact = await upsertContact(req.user.id, phone, name, label, notes);
    res.json({ success: true, data: contact });
}));

router.delete('/contacts/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'contact id');
    // Scoped by user_id in the DELETE itself — an id belonging to another
    // tenant matches zero rows and returns 404, not their data.
    const { changes } = await deleteContact(req.user.id, id);
    if (!changes) return res.status(404).json({ success: false, error: 'Contact not found' });
    res.json({ success: true });
}));

// ─── CSV import ─────────────────────────────────────────────
// Body is { csv: "<raw file text>" }, not multipart — the browser reads the
// file client-side (FileReader) and sends it as a JSON string, which avoids
// needing multer/disk storage for something that's read once and discarded.
router.post('/contacts/import', importLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const csvText = req.body?.csv;
    if (typeof csvText !== 'string' || !csvText.trim()) {
        return res.status(400).json({ success: false, error: 'No CSV content received' });
    }
    if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
        return res.status(413).json({
            success: false,
            error: `That file is too large (limit ${(MAX_CSV_BYTES / 1024 / 1024).toFixed(0)}MB). Split it and import in batches.`
        });
    }

    const rawRows = parseCSV(csvText, { maxRows: MAX_IMPORT_ROWS + 1 });
    if (rawRows.length === 0) {
        return res.status(400).json({ success: false, error: 'That file has no data rows (just a header, or empty)' });
    }
    if (rawRows.length > MAX_IMPORT_ROWS) {
        return res.status(400).json({
            success: false,
            error: `That's more than ${MAX_IMPORT_ROWS.toLocaleString()} rows — imports are capped at ${MAX_IMPORT_ROWS.toLocaleString()} at a time. Split the file and import in batches.`
        });
    }

    const mapped = rawRows.map(mapContactRow);
    const result = await bulkUpsertContacts(req.user.id, mapped);

    res.json({ success: true, data: result });
}));

// ─── Bulk outreach ──────────────────────────────────────────
// Starts a background send job and returns immediately — see src/outreach.js
// for why this can't be a normal synchronous request/response.
router.post('/contacts/outreach', sendLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.wa_enabled) {
        return res.status(403).json({
            success: false,
            error: 'WhatsApp access has not been enabled for your account. Please contact the administrator.',
            code: 'WA_NOT_ENABLED'
        });
    }

    const body = req.body || {};
    const { contactIds } = body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Select at least one contact' });
    }
    if (contactIds.length > MAX_RECIPIENTS_PER_JOB) {
        return res.status(400).json({
            success: false,
            error: `Outreach is capped at ${MAX_RECIPIENTS_PER_JOB} recipients per send — you selected ${contactIds.length}. Split into smaller batches.`
        });
    }
    const message = requireString(body.message, 'message', { max: LIMITS.MESSAGE_BODY });

    const status = getStatus(req.user.id);
    if (!status.connected) {
        return res.status(409).json({ success: false, error: 'Connect WhatsApp first (Settings → WhatsApp QR) before sending outreach.' });
    }

    const contacts = await getContactsByIds(req.user.id, contactIds);
    if (contacts.length === 0) {
        return res.status(400).json({ success: false, error: 'None of the selected contacts could be found' });
    }

    const job = startOutreachJob(req.user, contacts, message);
    res.json({ success: true, data: { jobId: job.id, total: job.total } });
}));

router.get('/contacts/outreach/:jobId', (req, res) => {
    // getOutreachJob checks ownership; an unknown or someone else's job id is
    // indistinguishable from a missing one.
    const job = getOutreachJob(String(req.params.jobId).slice(0, 40), req.user.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    res.json({ success: true, data: job });
});

router.post('/contacts/outreach/:jobId/cancel', (req, res) => {
    const ok = cancelOutreachJob(String(req.params.jobId).slice(0, 40), req.user.id);
    if (!ok) return res.status(404).json({ success: false, error: 'Job not found or already finished' });
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────────────────────
router.get('/messages', asyncHandler(async (req, res) => {
    // Every one of these was previously passed straight through:
    // ?limit=999999999 turned into a SQL LIMIT and materialised the whole
    // table into one JSON response, and a non-numeric limit became NaN.
    const phone = req.query.phone ? normalizePhone(req.query.phone) : undefined;
    const direction = optionalEnum(req.query.direction, ['incoming', 'outgoing'], 'direction');
    const limit = clampInt(req.query.limit, { min: 1, max: LIMITS.MAX_PAGE_LIMIT, fallback: LIMITS.DEFAULT_PAGE_LIMIT });
    const offset = clampInt(req.query.offset, { min: 0, max: LIMITS.MAX_OFFSET, fallback: 0 });

    const messages = await getMessages(req.user.id, { phone, direction, limit, offset });
    res.json({
        success: true,
        data: messages,
        meta: { limit, offset, total: await countMessages(req.user.id, { phone, direction }) }
    });
}));

router.get('/messages/conversation/:phone', asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    const limit = clampInt(req.query.limit, { min: 1, max: 2000, fallback: 500 });
    const messages = await getConversation(req.user.id, phone, { limit });
    res.json({ success: true, data: messages });
}));

// Danger Zone → Clear Message History: permanently deletes this account's own message log.
router.delete('/messages', writeLimiter, asyncHandler(async (req, res) => {
    await clearMessages(req.user.id);
    res.json({ success: true });
}));

/**
 * Send a WhatsApp message.
 *
 * The idempotency handling here is the important part, and it is not
 * cosmetic. Sequence that produced duplicate messages before:
 *
 *   1. browser POSTs /messages/send
 *   2. WhatsApp accepts and delivers the message
 *   3. the HTTP response is lost (proxy timeout, network drop, tab closed)
 *   4. the browser or the user retries
 *   5. the server has no memory of step 2 and sends again
 *
 * The recipient gets the message twice and WhatsApp's spam heuristics notice.
 * A client-supplied Idempotency-Key (or body idempotencyKey) makes the retry
 * safe: the key is recorded in the same table as the message under a UNIQUE
 * index, so the second attempt short-circuits and returns the original
 * outcome instead of sending.
 *
 * The key is reserved BEFORE the send, not after. Reserving afterwards
 * leaves the exact window this is meant to close: two concurrent requests
 * would both find no record, both send, and only then both try to log.
 */
router.post('/messages/send', sendLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.wa_enabled) {
        return res.status(403).json({
            success: false,
            error: 'WhatsApp access has not been enabled for your account. Please contact the administrator.',
            code: 'WA_NOT_ENABLED'
        });
    }

    const uid = req.user.id;
    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    const text = requireString(body.body, 'body', { max: LIMITS.MESSAGE_BODY });

    const rawKey = req.get('Idempotency-Key') || body.idempotencyKey;
    const idempotencyKey = rawKey === undefined || rawKey === null || rawKey === ''
        ? null
        : requireString(String(rawKey), 'Idempotency-Key', { max: 120 });

    if (idempotencyKey) {
        const already = await findMessageByIdempotencyKey(uid, idempotencyKey);
        if (already) {
            // 200 with a flag, not an error: the caller's intent was carried
            // out exactly once, which is what they asked for.
            return res.json({
                success: true,
                data: { duplicate: true, messageId: already.wa_message_id, loggedAt: already.created_at }
            });
        }
    }

    if (req.user.message_limit && (await getMonthlyOutgoingCount(uid)) >= req.user.message_limit) {
        return res.status(403).json({
            success: false,
            error: `Monthly message limit reached (${req.user.message_limit}). Contact your administrator to raise it.`,
            code: 'MESSAGE_LIMIT'
        });
    }

    // Claim the key first. If this insert wins, we own the send; a concurrent
    // duplicate loses and reports itself as a duplicate without sending.
    if (idempotencyKey) {
        const claim = await logOutgoingMessageIdempotent(uid, idempotencyKey, {
            phone,
            direction: 'outgoing',
            messageType: 'text',
            body: text,
            status: 'pending'
        });
        if (!claim.created) {
            return res.json({ success: true, data: { duplicate: true, loggedAt: claim.row.created_at } });
        }
    }

    let result;
    try {
        result = await sendTextMessage(uid, phone, text);
    } catch (err) {
        // The claim row stays, marked failed, so a retry with the same key
        // reports the failure rather than silently re-sending — the caller
        // must decide, with a new key, whether to try again.
        if (idempotencyKey) {
            try {
                const row = await findMessageByIdempotencyKey(uid, idempotencyKey);
                if (row) {
                    await runSql("UPDATE messages SET status = 'failed' WHERE id = $1", [row.id]);
                }
            } catch (_) { /* logging the failure must not mask the real error */ }
        }
        err.status = err.status || 502;
        throw err;
    }

    if (idempotencyKey) {
        const row = await findMessageByIdempotencyKey(uid, idempotencyKey);
        if (row) {
            await runSql("UPDATE messages SET status = 'sent' WHERE id = $1", [row.id]);
        }
    } else {
        await logMessage(uid, {
            waMessageId: result?.id?._serialized || result?.messageId || null,
            phone,
            direction: 'outgoing',
            messageType: 'text',
            body: text,
            status: 'sent'
        });
    }

    // Auto-save contact
    if (!(await getContactByPhone(uid, phone))) {
        if ((await countContacts(uid)) < LIMITS.MAX_CONTACTS_PER_USER) await upsertContact(uid, phone);
    }

    res.json({ success: true, data: { sent: true, messageId: result?.id?._serialized || null } });
}));

// ─────────────────────────────────────────────────────────────
//  CHATBOT RULES
// ─────────────────────────────────────────────────────────────
router.get('/chatbot/rules', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getChatbotRules(req.user.id) });
}));

const RULE_MATCH_TYPES = ['exact', 'contains', 'startswith', 'regex'];

/**
 * Validates a rule's trigger according to its match type.
 *
 * The 'regex' case is the one that matters: the pattern is later compiled
 * and run against incoming message text on the single shared event loop.
 * A catastrophically backtracking pattern would freeze the API for every
 * tenant, so it is rejected at write time — Node cannot interrupt a running
 * RegExp, which makes prevention the only available defence.
 */
function validateRuleTrigger(triggerKeyword, matchType) {
    const keyword = requireString(triggerKeyword, 'trigger_keyword', { max: LIMITS.RULE_KEYWORD });
    if (matchType === 'regex') assertSafeRegexSource(keyword, 'trigger_keyword');
    return keyword;
}

router.post('/chatbot/rules', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const body = req.body || {};
    const matchType = body.match_type === undefined ? 'contains'
        : requireEnum(body.match_type, RULE_MATCH_TYPES, 'match_type');
    const triggerKeyword = validateRuleTrigger(body.trigger_keyword, matchType);
    const responseText = requireString(body.response_text, 'response_text', { max: LIMITS.RULE_RESPONSE });
    const priority = clampInt(body.priority, { min: -1000, max: 1000, fallback: 0 });

    const current = await countChatbotRules(uid);
    // Plan limit first (an admin-set number), then the platform ceiling that
    // exists regardless of plan, because every active rule is evaluated on
    // every inbound message.
    if (req.user.rule_limit && current >= req.user.rule_limit) {
        return res.status(403).json({
            success: false,
            error: `Chatbot rule limit reached (${req.user.rule_limit}). Contact your administrator to raise it.`,
            code: 'RULE_LIMIT'
        });
    }
    if (current >= LIMITS.MAX_RULES_PER_USER) {
        return res.status(409).json({
            success: false,
            error: `You have reached the maximum of ${LIMITS.MAX_RULES_PER_USER} chatbot rules.`,
            code: 'RULE_LIMIT'
        });
    }

    const rule = await createChatbotRule(uid, triggerKeyword, matchType, responseText, priority);
    res.json({ success: true, data: rule });
}));

router.put('/chatbot/rules/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const id = requireId(req.params.id, 'rule id');
    const body = req.body || {};

    // The old handler passed req.body straight to updateChatbotRule, which
    // filtered column names but validated nothing — so a rule could be
    // *edited* into a catastrophic regex even though creating one was
    // checked. Re-validate against the effective match type, which may be
    // the stored one if this request only changes the keyword.
    const rules = await getChatbotRules(uid);
    const existing = rules.find(r => r.id === id);
    if (!existing) return res.status(404).json({ success: false, error: 'Rule not found' });

    const fields = {};
    const matchType = body.match_type === undefined
        ? existing.match_type
        : requireEnum(body.match_type, RULE_MATCH_TYPES, 'match_type');
    if (body.match_type !== undefined) fields.match_type = matchType;

    if (body.trigger_keyword !== undefined) {
        fields.trigger_keyword = validateRuleTrigger(body.trigger_keyword, matchType);
    } else if (body.match_type === 'regex' && existing.match_type !== 'regex') {
        // Switching an existing plain keyword to regex mode: the stored text
        // now becomes a pattern and must clear the same bar.
        assertSafeRegexSource(existing.trigger_keyword, 'trigger_keyword');
    }

    if (body.response_text !== undefined) {
        fields.response_text = requireString(body.response_text, 'response_text', { max: LIMITS.RULE_RESPONSE });
    }
    if (body.priority !== undefined) {
        fields.priority = clampInt(body.priority, { min: -1000, max: 1000, fallback: 0 });
    }
    if (body.is_active !== undefined) {
        fields.is_active = (body.is_active === true || body.is_active === 1 || body.is_active === '1') ? 1 : 0;
    }

    if (Object.keys(fields).length === 0) {
        return res.status(400).json({ success: false, error: 'No changes supplied.' });
    }

    await updateChatbotRule(uid, id, fields);
    const updatedRules = await getChatbotRules(uid);
    const updated = updatedRules.find(r => r.id === id);
    res.json({ success: true, data: updated });
}));

router.delete('/chatbot/rules/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'rule id');
    const { changes } = await deleteChatbotRule(req.user.id, id);
    if (!changes) return res.status(404).json({ success: false, error: 'Rule not found' });
    res.json({ success: true });
}));

// Test a message against chatbot rules (without sending)
router.post('/chatbot/test', writeLimiter, asyncHandler(async (req, res) => {
    const message = requireString(req.body?.message, 'message', { max: LIMITS.MESSAGE_BODY });
    res.json({ success: true, data: await testMessage(req.user.id, message) });
}));

// ─────────────────────────────────────────────────────────────
//  SCHEDULED MESSAGES
// ─────────────────────────────────────────────────────────────
router.get('/scheduled', asyncHandler(async (req, res) => {
    const status = optionalEnum(req.query.status, ['pending', 'sending', 'sent', 'failed', 'cancelled'], 'status');
    res.json({ success: true, data: await getScheduledMessages(req.user.id, status) });
}));

router.post('/scheduled', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    if (req.user.role !== 'admin' && !req.user.wa_enabled) {
        return res.status(403).json({
            success: false,
            error: 'WhatsApp access has not been enabled for your account. Please contact the administrator.',
            code: 'WA_NOT_ENABLED'
        });
    }

    const body = req.body || {};
    const phone = normalizePhone(body.phone);
    const text = requireString(body.body, 'body', { max: LIMITS.MESSAGE_BODY });

    // toSqliteUtc returns "YYYY-MM-DD HH:MM:SS" in UTC
    const scheduledAt = toSqliteUtc(body.scheduled_at, 'scheduled_at');

    // Small grace window for clock skew / time spent filling the form.
    if (new Date(scheduledAt + 'Z').getTime() < Date.now() - 60000) {
        return res.status(400).json({ success: false, error: 'scheduled_at must be in the future.' });
    }

    if ((await countPendingScheduledMessages(req.user.id)) >= LIMITS.MAX_PENDING_SCHEDULED_PER_USER) {
        return res.status(409).json({
            success: false,
            error: `You already have ${LIMITS.MAX_PENDING_SCHEDULED_PER_USER} messages scheduled. Cancel some before adding more.`,
            code: 'SCHEDULE_LIMIT'
        });
    }

    const msg = await createScheduledMessage(req.user.id, phone, text, scheduledAt);
    res.json({ success: true, data: msg });
}));

router.delete('/scheduled/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'scheduled message id');
    // The UPDATE requires status='pending', so cancelling a message the
    // scheduler has already claimed ('sending') correctly fails rather than
    // pretending a send in flight was stopped.
    const { changes } = await cancelScheduledMessage(req.user.id, id);
    if (!changes) {
        return res.status(409).json({
            success: false,
            error: 'That message was not found, or it has already been sent, cancelled, or is being sent right now.'
        });
    }
    res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
//  LEAD ANALYSIS (AI conversation insights)
// ─────────────────────────────────────────────────────────────

// List saved lead analyses (sorted by priority, then interest score)
router.get('/leads', asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const interest = optionalEnum(req.query.interest, ['interested', 'not_interested', 'neutral', 'unclear'], 'interest');
    const priority = optionalEnum(req.query.priority, ['high', 'medium', 'low'], 'priority');

    const leads = await getLeadAnalyses(uid, { interestStatus: interest || '', priority: priority || '' });
    const stats = await getLeadStats(uid);
    // Conversations that exist but haven't been analyzed yet (or have new messages)
    const phones = await getConversationPhones(uid);
    const leadByPhone = new Map(leads.map(l => [l.phone, l]));
    const pending = phones.filter(p => {
        const existing = leadByPhone.get(p.phone);
        return !existing || existing.message_count < p.message_count;
    }).map(p => ({ phone: p.phone, contact_name: p.contact_name, message_count: p.message_count }));

    res.json({ success: true, data: { leads, stats, pending } });
}));

// Get one lead's analysis
router.get('/leads/:phone', asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    const lead = await getLeadAnalysis(req.user.id, phone);
    if (!lead) return res.status(404).json({ success: false, error: 'No analysis found for this contact yet.' });
    res.json({ success: true, data: lead });
}));

// Analyze (or re-analyze) one conversation now
router.post('/leads/analyze/:phone', aiLimiter, withAiSlot(async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    const lead = await analyzeConversation(req.user.id, phone);
    res.json({ success: true, data: lead });
}));

// Analyze all conversations (skips up-to-date ones unless ?force=true)
router.post('/leads/analyze-all', aiLimiter, withAiSlot(async (req, res) => {
      const force = req.query.force === 'true' || req.body?.force === true;
      // Absolute deadline for the entire batch (default 2 minutes, max 5 minutes).
      // Without a cap a client could pass ?deadlineMs=999999999 and hold an AI
      // concurrency slot occupied for days, starving other tenants.
      const deadlineMs = Math.min(
          parseInt(req.query.deadlineMs, 10) || 120000,
          5 * 60 * 1000  // hard ceiling: 5 minutes
      );
      const results = await analyzeAllConversations(req.user.id, !force, deadlineMs);
      res.json({
          success: true,
          data: {
              analyzed: results.analyzed.length,
              skipped: results.skipped.length,
              failed: results.failed,
              aborted: results.aborted,
              remaining: results.remaining
          }
      });
  }));

// Delete a saved analysis
router.delete('/leads/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'lead id');
    const { changes } = await deleteLeadAnalysis(req.user.id, id);
    if (!changes) return res.status(404).json({ success: false, error: 'Lead not found' });
    res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────
//  BUSINESS SETUP (products, catalog, AI business analysis)
// ─────────────────────────────────────────────────────────────
router.get('/products', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getProducts(req.user.id) });
}));

router.get('/products/images/:filename', asyncHandler(async (req, res) => {
    const filename = req.params.filename;
    if (!isSafeFilename(filename)) {
        return res.status(400).json({ success: false, error: 'Invalid image filename' });
    }

    const absPath = getProductImageAbsolutePath(filename);
    if (!absPath) {
        return res.status(404).json({ success: false, error: 'Image not found' });
    }

    res.setHeader('Content-Type', getMimeType(filename));
    res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    res.sendFile(absPath);
}));

router.get('/products/:id', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'product id');
    const product = await getProductById(req.user.id, id);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product });
}));

router.post('/products/upload-image', writeLimiter, requireDurableWrite, handleImageUpload, asyncHandler(async (req, res) => {
    if (!req.user || !req.user.id) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!req.file || !req.file.buffer) {
        throw new ValidationError('No image file was uploaded.', 'image');
    }

    const filename = await saveProductImage(req.user.id, req.file.buffer);
    res.json({
        success: true,
        data: {
            filename,
            url: `/api/products/images/${filename}`
        }
    });
}));

/**
 * Validates a product URL.
 *
 * Only http/https, because the value is rendered as a link in the dashboard
 * and injected into AI prompts: a "javascript:" URL is stored XSS the moment
 * any view renders it as an href, and "file:"/"data:" have no legitimate use
 * here. Rejecting at the boundary means no view has to remember.
 */
function validateProductUrl(value) {
    const url = optionalString(value, 'url', LIMITS.PRODUCT_URL);
    if (url === '') return '';
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        throw new ValidationError('Product URL must be a valid http(s) address.', 'url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ValidationError('Product URL must start with http:// or https://', 'url');
    }
    return parsed.toString();
}

function validateProductImageRef(imagePath) {
    if (!imagePath) return '';
    const clean = String(imagePath).trim();
    if (!clean) return '';
    if (!isSafeFilename(clean)) {
        throw new ValidationError('Invalid product image reference.', 'image_path');
    }
    const absPath = getProductImageAbsolutePath(clean);
    if (!absPath) {
        throw new ValidationError('Referenced product image does not exist on server.', 'image_path');
    }
    return clean;
}

router.post('/products', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = sanitizeSpreadsheetCell(requireString(body.name, 'name', { max: LIMITS.PRODUCT_NAME }));

    if ((await countProducts(req.user.id)) >= LIMITS.MAX_PRODUCTS_PER_USER) {
        return res.status(409).json({
            success: false,
            error: `You have reached the maximum of ${LIMITS.MAX_PRODUCTS_PER_USER} products.`,
            code: 'PRODUCT_LIMIT'
        });
    }

    const image_path = validateProductImageRef(body.image_path);

    const product = await createProduct(req.user.id, {
        name,
        description: optionalString(body.description, 'description', LIMITS.PRODUCT_DESCRIPTION),
        price: optionalString(body.price, 'price', LIMITS.PRODUCT_PRICE),
        category: optionalString(body.category, 'category', LIMITS.PRODUCT_CATEGORY),
        url: validateProductUrl(body.url),
        image_path
    });
    res.json({ success: true, data: product });
}));

router.put('/products/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'product id');
    const body = req.body || {};

    const existing = await getProductById(req.user.id, id);
    if (!existing) return res.status(404).json({ success: false, error: 'Product not found' });

    const fields = {};
    if (body.name !== undefined)        fields.name = sanitizeSpreadsheetCell(requireString(body.name, 'name', { max: LIMITS.PRODUCT_NAME }));
    if (body.description !== undefined) fields.description = optionalString(body.description, 'description', LIMITS.PRODUCT_DESCRIPTION);
    if (body.price !== undefined)       fields.price = optionalString(body.price, 'price', LIMITS.PRODUCT_PRICE);
    if (body.category !== undefined)    fields.category = optionalString(body.category, 'category', LIMITS.PRODUCT_CATEGORY);
    if (body.url !== undefined)         fields.url = validateProductUrl(body.url);
    if (body.image_path !== undefined)  fields.image_path = validateProductImageRef(body.image_path);
    if (body.is_active !== undefined)   fields.is_active = (body.is_active === true || body.is_active === 1 || body.is_active === '1') ? 1 : 0;

    const updated = await updateProduct(req.user.id, id, fields);
    if (!updated) return res.status(404).json({ success: false, error: 'Product not found' });

    // Clean up replaced old image if it was replaced with a new or empty image
    if (fields.image_path !== undefined && existing.image_path && existing.image_path !== fields.image_path) {
        await deleteProductImage(existing.image_path);
    }

    res.json({ success: true, data: updated });
}));

router.delete('/products/:id/image', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'product id');
    const product = await getProductById(req.user.id, id);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    if (product.image_path) {
        await updateProduct(req.user.id, id, { image_path: '' });
        await deleteProductImage(product.image_path);
    }

    const updated = await getProductById(req.user.id, id);
    res.json({ success: true, data: updated });
}));

router.delete('/products/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'product id');
    const existing = await getProductById(req.user.id, id);
    if (!existing) return res.status(404).json({ success: false, error: 'Product not found' });

    const { changes } = await deleteProduct(req.user.id, id);
    if (!changes) return res.status(404).json({ success: false, error: 'Product not found' });

    if (existing.image_path) {
        await deleteProductImage(existing.image_path);
    }

    res.json({ success: true });
}));

// Run the AI business analysis and save the sales brief
router.post('/business/analyze', aiLimiter, withAiSlot(async (req, res) => {
    const profile = await analyzeBusinessProfile(req.user.id);
    res.json({ success: true, data: profile });
}));

// Current business info (settings + products in one call)
router.get('/business', asyncHandler(async (req, res) => {
    const info = await getBusinessInfo(req.user.id);
    let aiProfile = null;
    try {
        const raw = await getSetting(req.user.id, 'business_ai_profile');
        aiProfile = JSON.parse(raw || '');
    } catch (e) { aiProfile = null; }
    res.json({ success: true, data: { ...info, aiProfile } });
}));

// ─────────────────────────────────────────────────────────────
//  CRM (pipeline, deals, activities)
// ─────────────────────────────────────────────────────────────
router.get('/crm/deals', asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const stage = optionalEnum(req.query.stage, CRM_STAGES, 'stage');
    const deals = await getCrmDeals(uid, { stage: stage || '' });
    const stats = await getCrmStats(uid);
    const currency = (await getSetting(uid, 'business_currency')) || '₹';
    res.json({ success: true, data: { deals, stats, stages: CRM_STAGES, currency } });
}));

router.get('/crm/analytics', asyncHandler(async (req, res) => {
    const analytics = await getCrmAnalytics(req.user.id);
    analytics.currency = (await getSetting(req.user.id, 'business_currency')) || '₹';
    res.json({ success: true, data: analytics });
}));

router.post('/crm/deals', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const body = req.body || {};
    const phone = normalizePhone(body.phone);

    // UNIQUE(user_id, phone) is the real guard against a double-click creating
    // two deals; this check just produces a friendlier message when it isn't
    // a race.
    if (await getCrmDealByPhone(uid, phone)) {
        return res.status(409).json({ success: false, error: 'A deal already exists for this contact.' });
    }

    let deal;
    try {
        deal = await createCrmDeal(uid, {
            phone,
            contactName: sanitizeSpreadsheetCell(optionalString(body.contact_name, 'contact_name', LIMITS.CONTACT_NAME)),
            stage: body.stage === undefined ? 'new' : requireEnum(body.stage, CRM_STAGES, 'stage'),
            dealValue: clampNumber(body.deal_value),
            productInterest: optionalString(body.product_interest, 'product_interest', LIMITS.CRM_PRODUCT_INTEREST),
            source: 'manual',
            notes: sanitizeSpreadsheetCell(optionalString(body.notes, 'notes', LIMITS.CRM_NOTES)),
            nextFollowupAt: body.next_followup_at ? toSqliteUtc(body.next_followup_at, 'next_followup_at') : null
        });
    } catch (err) {
        if (/UNIQUE constraint failed|duplicate key value/i.test(String(err.message))) {
            return res.status(409).json({ success: false, error: 'A deal already exists for this contact.' });
        }
        throw err;
    }

    await addCrmActivity(uid, deal.phone, 'system', 'Deal created manually');
    res.json({ success: true, data: deal });
}));

router.put('/crm/deals/:id', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const id = requireId(req.params.id, 'deal id');
    const body = req.body || {};

    const existing = await getCrmDealById(uid, id);
    if (!existing) return res.status(404).json({ success: false, error: 'Deal not found' });

    const fields = {};
    if (body.contact_name !== undefined)     fields.contact_name = sanitizeSpreadsheetCell(optionalString(body.contact_name, 'contact_name', LIMITS.CONTACT_NAME));
    if (body.stage !== undefined)            fields.stage = requireEnum(body.stage, CRM_STAGES, 'stage');
    if (body.deal_value !== undefined)       fields.deal_value = clampNumber(body.deal_value);
    if (body.product_interest !== undefined) fields.product_interest = optionalString(body.product_interest, 'product_interest', LIMITS.CRM_PRODUCT_INTEREST);
    if (body.notes !== undefined)            fields.notes = sanitizeSpreadsheetCell(optionalString(body.notes, 'notes', LIMITS.CRM_NOTES));
    if (body.next_followup_at !== undefined) {
        fields.next_followup_at = body.next_followup_at ? toSqliteUtc(body.next_followup_at, 'next_followup_at') : null;
    }

    const updated = await updateCrmDeal(uid, id, fields);

    if (fields.stage !== undefined && fields.stage !== existing.stage) {
        await addCrmActivity(uid, existing.phone, 'stage', `Stage changed: ${existing.stage} → ${fields.stage}`);
    }

    res.json({ success: true, data: updated });
}));

router.delete('/crm/deals/:id', writeLimiter, asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'deal id');
    const { changes } = await deleteCrmDeal(req.user.id, id);
    if (!changes) return res.status(404).json({ success: false, error: 'Deal not found' });
    res.json({ success: true });
}));

// One deal with its lead analysis + activity timeline (for the detail view)
router.get('/crm/deals/phone/:phone', asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const phone = normalizePhone(req.params.phone);
    const deal = await getCrmDealByPhone(uid, phone);
    if (!deal) return res.status(404).json({ success: false, error: 'Deal not found' });
    const analysis = (await getLeadAnalysis(uid, phone)) || null;
    const activities = await getCrmActivities(uid, phone);
    res.json({ success: true, data: { deal, analysis, activities } });
}));

router.post('/crm/deals/phone/:phone/notes', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.params.phone);
    const content = sanitizeSpreadsheetCell(
        requireString(req.body?.content, 'content', { max: LIMITS.CRM_NOTE_ENTRY })
    );
    const activity = await addCrmActivity(req.user.id, phone, 'note', content);
    res.json({ success: true, data: activity });
}));

// ─────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────
router.get('/settings', asyncHandler(async (req, res) => {
    const settings = await getAllSettings(req.user.id);
    // The API key never leaves the server. The dashboard only needs to know
    // whether one is configured, so it gets a boolean; sending the value back
    // (as the old handler did) means it lives in the browser's memory, in any
    // proxy log that captures response bodies, and in a saved HAR file.
    const hasKey = !!(settings.gemini_api_key && settings.gemini_api_key.trim() !== '');
    delete settings.gemini_api_key;
    res.json({ success: true, data: { ...settings, gemini_api_key_set: hasKey } });
}));

router.put('/settings', writeLimiter, requireDurableWrite, asyncHandler(async (req, res) => {
    const uid = req.user.id;
    // An allow-list with per-key length caps.
    const { accepted, rejected } = validateSettingsPatch(req.body);

    await transaction(async () => {
        for (const [key, value] of Object.entries(accepted)) {
            // An empty key means "clear it"; the UI sends the field blank.
            await setSetting(uid, key, value);
        }
    });

    if (accepted.gemini_api_key !== undefined) {
        resetCircuits();
    }

    const settings = await getAllSettings(uid);
    const hasKey = !!(settings.gemini_api_key && settings.gemini_api_key.trim() !== '');
    delete settings.gemini_api_key;

    res.json({
        success: true,
        data: { ...settings, gemini_api_key_set: hasKey },
        meta: rejected.length ? { ignored: rejected } : undefined
    });
}));

router.get('/settings/gemini-models', (req, res) => {
    res.json({
        success: true,
        data: {
            models: ALL_GEMINI_MODELS,
            default: 'auto'
        }
    });
});

router.post('/settings/test-gemini', writeLimiter, asyncHandler(async (req, res) => {
    try {
        const candidate = (req.body?.key && typeof req.body.key === 'string' && req.body.key.trim()) || (await getApiKey(req.user.id));
        const preferredModel = (req.body?.model && typeof req.body.model === 'string' && req.body.model.trim()) || (await getSetting(req.user.id, 'gemini_model'));
        if (!candidate) {
            return res.status(400).json({ success: false, error: 'No Gemini API key found. Please type your API key.' });
        }
        const result = await testApiKey(candidate, preferredModel);
        res.json({
            success: true,
            data: {
                success: true,
                model: result.model,
                supportedModels: ALL_GEMINI_MODELS
            },
            model: result.model,
            supportedModels: ALL_GEMINI_MODELS
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message || 'API key validation failed' });
    }
}));

module.exports = router;


