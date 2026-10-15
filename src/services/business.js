const { getSetting, setSetting, getProducts } = require('./database');
const { callGeminiWithRetry, extractText, parseJsonResponse } = require('./gemini-client');

// How much of the catalog goes into a prompt. Uncapped, a tenant with 1000
// products makes every single auto-reply enormous and slow — and the model
// ignores most of it anyway.
const MAX_PRODUCTS_IN_CONTEXT = 40;

// ─── Raw business info (what the owner typed in Settings) ───
async function getBusinessInfo(userId) {
    return {
        name:            (await getSetting(userId, 'business_name')) || '',
        website:         (await getSetting(userId, 'business_website')) || '',
        industry:        (await getSetting(userId, 'business_industry')) || '',
        description:     (await getSetting(userId, 'business_description')) || '',
        targetCustomers: (await getSetting(userId, 'business_target_customers')) || '',
        offers:          (await getSetting(userId, 'business_offers')) || '',
        currency:        (await getSetting(userId, 'business_currency')) || '₹',
        products:        await getProducts(userId, true)
    };
}

function hasBusinessInfo(info) {
    return !!(info.description || info.industry || info.website || info.offers || info.products.length);
}

/**
 * Builds a compact text block describing the business, for injection into
 * AI prompts (auto-replies and lead analysis). Returns '' if nothing is set up.
 *
 * Everything here is the tenant's own data, fetched by their user id — which
 * is what makes cross-tenant leakage through the AI impossible rather than
 * merely unlikely. Values are flattened to single lines because this block
 * is line-oriented and is placed in the system instruction: a product name
 * containing a newline could otherwise forge a directive line.
 */
async function getBusinessContext(userId) {
    const info = await getBusinessInfo(userId);
    if (!hasBusinessInfo(info)) return '';

    const flat = (v) => String(v == null ? '' : v).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

    const lines = [];
    if (info.name)            lines.push(`Business: ${flat(info.name)}`);
    if (info.website)         lines.push(`Website: ${flat(info.website)}`);
    if (info.industry)        lines.push(`Industry: ${flat(info.industry)}`);
    if (info.description)     lines.push(`About: ${flat(info.description)}`);
    if (info.targetCustomers) lines.push(`Target customers: ${flat(info.targetCustomers)}`);
    if (info.offers)          lines.push(`Current offers/promotions: ${flat(info.offers)}`);

    if (info.products.length) {
        lines.push('Products / Services catalog:');
        for (const p of info.products.slice(0, MAX_PRODUCTS_IN_CONTEXT)) {
            const bits = [`[ID: ${p.id}] ${flat(p.name)}`];
            if (p.price)       bits.push(`price: ${flat(p.price)}`);
            if (p.category)    bits.push(`category: ${flat(p.category)}`);
            if (p.description) bits.push(flat(p.description));
            if (p.url)         bits.push(`link: ${flat(p.url)}`);
            if (p.image_path)  bits.push('has_photo: yes');
            lines.push(`  - ${bits.join(' | ')}`);
        }
        if (info.products.length > MAX_PRODUCTS_IN_CONTEXT) {
            lines.push(`  (…and ${info.products.length - MAX_PRODUCTS_IN_CONTEXT} more products not listed here)`);
        }
    }

    // Include the AI-generated sales brief if the owner has run the analysis
    const profileRaw = await getSetting(userId, 'business_ai_profile');
    if (profileRaw) {
        try {
            const profile = JSON.parse(profileRaw);
            if (profile && profile.profile_summary) lines.push(`Sales positioning: ${flat(profile.profile_summary)}`);
            if (profile && Array.isArray(profile.selling_points) && profile.selling_points.length) {
                lines.push(`Key selling points: ${profile.selling_points.map(flat).join('; ')}`);
            }
        } catch (e) { /* ignore malformed stored profile */ }
    }

    return lines.join('\n');
}

// ─── AI Business Analysis ───────────────────────────────────
/**
 * Analyzes the business setup with Gemini and produces a sales brief:
 * positioning summary, selling points, ideal customer, pitch, objection
 * handling, and suggested FAQs. Saved to settings as business_ai_profile.
 *
 * The result is normalised before being stored, not stored raw. It is read
 * back into every future auto-reply prompt (getBusinessContext above), so
 * an unbounded or unexpectedly-shaped model response would otherwise become
 * a permanent cost and a permanent risk on every message thereafter.
 */
async function analyzeBusinessProfile(userId) {
    const info = await getBusinessInfo(userId);
    if (!hasBusinessInfo(info)) {
        const err = new Error('Add some business details or products first, then run the analysis.');
        err.status = 400;
        throw err;
    }

    const productText = info.products.length
        ? info.products.slice(0, MAX_PRODUCTS_IN_CONTEXT).map(p =>
            `- ${p.name}${p.price ? ` (${p.price})` : ''}${p.category ? ` [${p.category}]` : ''}${p.description ? `: ${p.description}` : ''}`
          ).join('\n')
        : '(no products listed)';

    const systemInstruction = `You are a senior sales strategist. Analyze the business below and respond with ONLY a valid JSON object (no markdown, no code fences) with exactly these fields:

{
  "profile_summary": "2-3 sentence positioning summary of what this business sells and to whom",
  "selling_points": ["3-6 short, concrete selling points"],
  "ideal_customer": "1-2 sentence description of the ideal customer",
  "sales_pitch": "a short natural WhatsApp-friendly pitch message (2-4 sentences) the owner could send to an interested lead",
  "objection_handling": [{"objection": "common objection a customer may raise", "response": "short suggested reply"}],
  "faq": [{"q": "likely customer question", "a": "short suggested answer"}],
  "improvement_tips": ["2-4 practical tips to improve conversions on WhatsApp for this business"]
}

Keep everything concise and practical. Use the same currency the business uses (${String(info.currency).slice(0, 8)}).`;

    const userText = `BUSINESS DETAILS:
Name: ${info.name || '(not set)'}
Website: ${info.website || '(not set)'}
Industry: ${info.industry || '(not set)'}
Description: ${info.description || '(not set)'}
Target customers: ${info.targetCustomers || '(not set)'}
Current offers: ${info.offers || '(none)'}

PRODUCTS / SERVICES:
${productText}`;

    const response = await callGeminiWithRetry(
        userId,
        (client, model) => client.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            config: {
                systemInstruction,
                temperature: 0.3,
                responseMimeType: 'application/json',
                maxOutputTokens: 2048
            }
        }),
        'Business analysis'
    );

    const raw = parseJsonResponse(extractText(response));
    if (!raw) {
        const err = new Error('The AI response could not be read as a business profile. Please try again.');
        err.status = 502;
        throw err;
    }

    const profile = normalizeBusinessProfile(raw);
    profile.analyzed_at = new Date().toISOString();
    await setSetting(userId, 'business_ai_profile', JSON.stringify(profile));
    return profile;
}

/** Clamps every field of a model-produced profile to a known shape and size. */
function normalizeBusinessProfile(raw) {
    const str = (v, max) => String(v == null ? '' : v).slice(0, max);
    const strList = (v, max, count) =>
        Array.isArray(v) ? v.slice(0, count).map(i => str(i, max)).filter(Boolean) : [];

    return {
        profile_summary: str(raw.profile_summary, 1200),
        selling_points: strList(raw.selling_points, 300, 10),
        ideal_customer: str(raw.ideal_customer, 600),
        sales_pitch: str(raw.sales_pitch, 1200),
        objection_handling: Array.isArray(raw.objection_handling)
            ? raw.objection_handling.slice(0, 10)
                .filter(o => o && typeof o === 'object')
                .map(o => ({ objection: str(o.objection, 300), response: str(o.response, 600) }))
            : [],
        faq: Array.isArray(raw.faq)
            ? raw.faq.slice(0, 15)
                .filter(f => f && typeof f === 'object')
                .map(f => ({ q: str(f.q, 300), a: str(f.a, 600) }))
            : [],
        improvement_tips: strList(raw.improvement_tips, 400, 8)
    };
}

module.exports = {
    getBusinessInfo,
    getBusinessContext,
    analyzeBusinessProfile,
    normalizeBusinessProfile,
    hasBusinessInfo,
    MAX_PRODUCTS_IN_CONTEXT
};


