/**
 * routes/calendar.js — Google Calendar connect/disconnect/status.
 *
 * Mounted at /api/calendar under the same `requireAuth` gate as the rest of
 * /api (see config/app.js), including the OAuth callback: Google redirects
 * the browser back to our own origin, which is a normal top-level
 * navigation that still carries the session cookie, so req.user is
 * available there exactly like any other route.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
    isConfigured, getAuthUrl, connectAccount, isConnected, disconnectAccount,
    setAvailabilityCheck, syncEventsToScheduledMessages
} = require('../services/google-calendar');
const { getGoogleCalendarAccount } = require('../services/database');
const { asyncHandler } = require('../utils/errors');

// OAuth state tokens are short-lived proof that the callback belongs to the
// login that started it — without this, an attacker could get a victim to
// visit a callback URL carrying the attacker's own authorization code and
// link the victim's account to the attacker's Google Calendar. Kept
// in-memory (like outreach job state): a state token only needs to survive
// the few seconds of the redirect round trip, not a server restart.
const pendingStates = new Map(); // state -> { userId, expiresAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepExpiredStates() {
    const now = Date.now();
    for (const [state, entry] of pendingStates) {
        if (entry.expiresAt < now) pendingStates.delete(state);
    }
}

router.get('/status', asyncHandler(async (req, res) => {
    const { getSetting } = require('../services/database');
    const calendarLink = (await getSetting(req.user.id, 'calendar_link')) || '';
    if (!isConfigured()) {
        return res.json({ success: true, data: { configured: false, connected: false, calendarLink } });
    }
    const account = await getGoogleCalendarAccount(req.user.id);
    res.json({
        success: true,
        data: {
            configured: true,
            connected: !!account,
            checkAvailability: account ? !!account.check_availability : false,
            connectedAt: account ? account.connected_at : null,
            lastSyncAt: account ? account.last_sync_at : null,
            calendarLink
        }
    });
}));

router.get('/link', asyncHandler(async (req, res) => {
    const { getSetting } = require('../services/database');
    const calendarLink = (await getSetting(req.user.id, 'calendar_link')) || '';
    res.json({ success: true, data: { calendarLink } });
}));

router.put('/link', asyncHandler(async (req, res) => {
    const { setSetting } = require('../services/database');
    const body = req.body || {};
    let link = typeof body.calendarLink === 'string' ? body.calendarLink.trim() : '';
    if (link && !/^https?:\/\//i.test(link)) {
        link = 'https://' + link;
    }
    await setSetting(req.user.id, 'calendar_link', link);
    res.json({ success: true, data: { calendarLink: link } });
}));

router.get('/connect', (req, res) => {
    if (!isConfigured()) {
        return res.status(400).json({
            success: false,
            error: 'Google Calendar is not configured on this server. An administrator needs to set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET and GOOGLE_CALENDAR_REDIRECT_URI.'
        });
    }
    sweepExpiredStates();
    const state = crypto.randomBytes(24).toString('hex');
    pendingStates.set(state, { userId: req.user.id, expiresAt: Date.now() + STATE_TTL_MS });
    res.json({ success: true, data: { url: getAuthUrl(state) } });
});

// Google redirects the browser here with ?code=&state=. This is rendered as
// a small HTML page (not JSON) since it's a top-level browser navigation,
// not a fetch() call from the dashboard's JS.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;

    /**
     * Escape a string for safe interpolation into an HTML text context.
     *
     * JSON.stringify already handles the value passed into the postMessage
     * <script> block (because JSON-encoded strings are JS string literals,
     * not HTML). This function is for the <p> fallback text, which IS parsed
     * by the HTML parser — an unescaped `message` containing `<script>` would
     * execute in the victim's browser (reflected XSS).
     */
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g,  '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;')
            .replace(/'/g,  '&#39;');
    }

    const closeAndNotify = (ok, message) => {
        // postMessage back to the opener (the dashboard tab that started the
        // popup/redirect) so the Settings page can refresh status without a
        // manual reload, then close this tab if it was a popup.
        //
        // `message` in the <script> block is passed through JSON.stringify(),
        // which produces a valid JS string literal — safe against HTML/JS
        // injection in that context. The <p> fallback uses escapeHtml() for
        // the same reason: it's inside the HTML parser, not JS.
        const safeMsg = escapeHtml(message || '');
        res.setHeader('Content-Type', 'text/html');
        res.send(`<!doctype html><html><body>
            <script nonce="${res.locals.nonce || ''}">
                try {
                    if (window.opener) {
                        window.opener.postMessage({ type: 'google-calendar-connected', ok: ${JSON.stringify(!!ok)}, message: ${JSON.stringify(message || '')} }, window.location.origin);
                        window.close();
                    } else {
                        window.location.href = '/app.html?settings=calendar';
                    }
                } catch (e) { window.location.href = '/app.html?settings=calendar'; }
            </script>
            <p>${ok ? 'Google Calendar connected &#8212; you can close this window.' : 'Could not connect Google Calendar: ' + safeMsg}</p>
        </body></html>`);
    };

    if (error) return closeAndNotify(false, String(error).slice(0, 200));
    if (!code || !state) return closeAndNotify(false, 'Missing authorization code.');

    const entry = pendingStates.get(String(state));
    pendingStates.delete(String(state));
    if (!entry || entry.expiresAt < Date.now() || entry.userId !== req.user.id) {
        return closeAndNotify(false, 'This connection request expired or does not belong to your session — please try again.');
    }

    try {
        await connectAccount(req.user.id, String(code));
    } catch (err) {
        console.error('❌ Google Calendar OAuth exchange failed:', err.message);
        return closeAndNotify(false, 'Google did not accept the authorization code.');
    }

    // Pull in anything already on the calendar right away rather than
    // waiting up to 5 minutes for the next background sync tick.
    try { await syncEventsToScheduledMessages(req.user.id); } catch (e) { /* non-fatal, next tick will retry */ }

    closeAndNotify(true);
}));

router.post('/disconnect', asyncHandler(async (req, res) => {
    await disconnectAccount(req.user.id);
    res.json({ success: true });
}));

router.put('/settings', asyncHandler(async (req, res) => {
    if (!(await isConnected(req.user.id))) {
        return res.status(409).json({ success: false, error: 'Connect Google Calendar first.' });
    }
    await setAvailabilityCheck(req.user.id, !!(req.body && req.body.checkAvailability));
    res.json({ success: true });
}));

// Manual "sync now" button, for after adding an event when the user doesn't
// want to wait for the next 5-minute tick.
router.post('/sync', asyncHandler(async (req, res) => {
    if (!(await isConnected(req.user.id))) {
        return res.status(409).json({ success: false, error: 'Connect Google Calendar first.' });
    }
    const imported = await syncEventsToScheduledMessages(req.user.id);
    res.json({ success: true, data: { imported } });
}));

module.exports = router;
