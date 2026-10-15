const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const { AUTH_ROOT, CACHE_ROOT } = require('../config/paths');
const { processMessage } = require('./chatbot');

// ─── Per-user session registry ─────────────────────────────────
// Each signed-up account gets its own isolated whatsapp-web.js Client,
// its own LocalAuth session folder, its own QR/connection state, and its
// own set of SSE listeners — so scanning a QR code for one account never
// touches another account's WhatsApp number.
const sessions = new Map(); // userId -> session state object

// Each live WhatsApp session spins up its own headless Chrome (Puppeteer)
// process, measured at roughly 150-250MB RSS each. Since signup is open
// (no email verification/CAPTCHA), a cap keeps a burst of new accounts from
// exhausting server memory/CPU. Raise via env var on a bigger box.
//
// The default is deliberately conservative (5) so that a small VPS (2GB RAM)
// survives out of the box. 5 sessions × ~250MB = ~1.25GB, leaving headroom
// for Node itself, the OS, and Caddy. Set MAX_CONCURRENT_WHATSAPP_SESSIONS
// higher on a box with more RAM (rough guide: (total_RAM_GB - 1) × 3).
const rawCap = parseInt(process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS, 10);
const MAX_CONCURRENT_SESSIONS = (Number.isFinite(rawCap) && rawCap >= 1) ? rawCap : 5;

// SSE connections are long-lived: each holds a socket, a file descriptor and
// a heartbeat timer for as long as the browser stays open. Without a cap, one
// account opening tabs in a loop exhausts file descriptors for the whole
// process — which takes down the API for every tenant, not just theirs.
const MAX_SSE_CLIENTS_PER_USER = parseInt(process.env.MAX_SSE_CLIENTS_PER_USER, 10) || 5;
const MAX_SSE_CLIENTS_TOTAL = parseInt(process.env.MAX_SSE_CLIENTS_TOTAL, 10) || 250;

// WhatsApp session auth folders live under AUTH_ROOT, which is part of
// PERSIST_ROOT (see src/config/paths.js). This keeps sessions on the same
// mounted disk as the database so a redeploy doesn't log every tenant out.

// ─── Session Hibernation (opt-in) ─────────────────────────────
// By default sessions are kept alive indefinitely. Sessions reconnect
// automatically on server restart via resumeExistingSessions() in server.js.
//
// On very low-RAM servers (1GB t3.micro), enable hibernation to free Chrome
// RAM for idle users. Set ENABLE_SESSION_HIBERNATION=true in .env.
// Default: 2 hours. Override with SESSION_IDLE_TIMEOUT_MS.
const HIBERNATION_ENABLED = process.env.ENABLE_SESSION_HIBERNATION === 'true';
const rawIdleMs = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS, 10);
const SESSION_IDLE_TIMEOUT_MS = (Number.isFinite(rawIdleMs) && rawIdleMs >= 60000)
    ? rawIdleMs
    : 2 * 60 * 60 * 1000; // 2 hours

let totalSseClients = 0;

function countActiveSessions() {
    let n = 0;
    const now = Date.now();
    for (const s of sessions.values()) {
        if (s.isInitializing && s.startedAt && (now - s.startedAt > 300000)) {
            s.isInitializing = false;
        }
        if (s.client || s.isInitializing) n++;
    }
    return n;
}

/**
 * Filesystem path for one account's saved WhatsApp login.
 *
 * userId is forced through Number() and asserted to be a positive integer
 * before it can reach path.join. Without that, a caller passing "../../etc"
 * would build a path outside the auth root — and this value comes from a
 * route parameter in some call paths. Every caller happens to be internal
 * today; this makes it safe regardless of who calls it next.
 */
function authDataPath(userId) {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error('authDataPath requires a positive integer user id');
    }
    return path.join(AUTH_ROOT, `user_${id}`);
}

function newSessionState() {
    return {
        client: null,
        currentQR: null,
        isConnected: false,
        sseClients: [],
        keepAliveTimer: null,
        watchdogTimer: null,
        hibernationTimer: null,
        isInitializing: false,
        restartTimer: null,
        crashCount: 0,
        lastCrashTime: Date.now(),
        lastError: null,
        startedAt: null,
        destroyed: false,
        userDisconnected: false,
        // Hibernation: tracks last message activity to decide when to free Chrome.
        lastActivityAt: Date.now(),
        isHibernated: false,
        qrTimeout: null
    };
}

function getSession(userId, createIfMissing = true) {
    if (!sessions.has(userId) && createIfMissing) {
        sessions.set(userId, newSessionState());
    }
    return sessions.get(userId);
}

// ─── Stale lock-file cleanup ──────────────────────────────────
// If Chrome crashes it leaves a SingletonLock file that blocks the next launch.
function clearStaleLocks(userId) {
    const authDir = authDataPath(userId);
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
    try {
        if (!fs.existsSync(authDir)) return;
        const cleanRecursive = (dir) => {
            try {
                for (const item of fs.readdirSync(dir)) {
                    const p = path.join(dir, item);
                    try {
                        if (lockFiles.includes(item)) {
                            fs.rmSync(p, { force: true });
                        } else {
                            const st = fs.lstatSync(p);
                            if (st.isDirectory()) cleanRecursive(p);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        };
        cleanRecursive(authDir);
    } catch (e) {
        // Auth dir may not exist yet on first run — that's fine
    }
}

// ─── SSE broadcast (scoped to one user's listeners) ────────────
/**
 * Writes an event to one account's listeners only.
 *
 * The tenant scoping is the security property: a QR code is a login
 * credential for a WhatsApp account, so broadcasting to the wrong listener
 * list would hand one customer the ability to attach their phone to another
 * customer's session. Events are looked up by userId and never iterate the
 * whole registry.
 */
function broadcastSSE(userId, data) {
    const s = getSession(userId, false);
    if (!s) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const dead = [];
    for (const c of s.sseClients) {
        try {
            c.res.write(payload);
        } catch (e) {
            dead.push(c);
        }
    }
    if (dead.length) {
        for (const c of dead) removeSseClient(s, c);
    }
}

function removeSseClient(s, client) {
    const idx = s.sseClients.indexOf(client);
    if (idx === -1) return;
    s.sseClients.splice(idx, 1);
    totalSseClients = Math.max(0, totalSseClients - 1);
    if (client.heartbeat) clearInterval(client.heartbeat);
    try { client.res.end(); } catch (e) { /* already gone */ }
}

// ─── Timers ───────────────────────────────────────────────────
function clearTimers(s) {
    if (s.keepAliveTimer)   { clearInterval(s.keepAliveTimer);  s.keepAliveTimer   = null; }
    if (s.watchdogTimer)    { clearInterval(s.watchdogTimer);   s.watchdogTimer    = null; }
    if (s.restartTimer)     { clearTimeout(s.restartTimer);     s.restartTimer     = null; }
    if (s.hibernationTimer) { clearTimeout(s.hibernationTimer); s.hibernationTimer = null; }
    if (s.qrTimeout)        { clearTimeout(s.qrTimeout);        s.qrTimeout        = null; }
}

// ─── Session Hibernation ──────────────────────────────────────
/**
 * Schedules (or re-arms) the idle hibernation timer for one session.
 *
 * Called after every inbound/outbound message activity, and cancelled when
 * a user opens the dashboard (SSE client connects). If the timer fires it
 * means the user has been genuinely idle: no messages AND no open tab.
 */
function armHibernationTimer(userId) {
    if (!HIBERNATION_ENABLED) return; // disabled by default — keep Chrome alive always
    const s = getSession(userId, false);
    if (!s) return;
    // Don't hibernate if user explicitly disconnected or session is not live.
    if (s.destroyed || s.userDisconnected || !s.isConnected) return;
    if (s.hibernationTimer) { clearTimeout(s.hibernationTimer); }
    s.hibernationTimer = setTimeout(async () => {
        s.hibernationTimer = null;
        const now = Date.now();
        // Final gate: only hibernate if still no SSE watchers and still idle.
        if (s.sseClients.length > 0) return;
        if (now - s.lastActivityAt < SESSION_IDLE_TIMEOUT_MS - 5000) return;
        if (!s.isConnected || s.destroyed || s.userDisconnected) return;
        console.log(`💤 [user ${userId}] Session idle for ${(SESSION_IDLE_TIMEOUT_MS / 60000).toFixed(0)} min — hibernating Chrome to free RAM.`);
        s.isHibernated = true;
        clearTimers(s);
        await safeDestroyClient(s);
        s.isConnected    = false;
        s.isInitializing = false;
        s.currentQR      = null;
        // Do NOT set s.destroyed or s.userDisconnected — auth stays on disk
        // and initWhatsAppClient() will revive the session on next open.
        console.log(`💤 [user ${userId}] Hibernated. Auth saved; will resume on next activity.`);
    }, SESSION_IDLE_TIMEOUT_MS);
    s.hibernationTimer.unref?.();
}

// ─── Safe client destroy ──────────────────────────────────────
async function safeDestroyClient(s) {
    s.isInitializing = false;
    if (!s.client) return;
    const c = s.client;
    s.client = null;
    // Detach listeners before destroying. whatsapp-web.js can emit
    // 'disconnected' during teardown, which would otherwise schedule a
    // restart for a session we are deliberately shutting down — the loop that
    // makes a suspended account reconnect itself.
    try { c.removeAllListeners(); } catch (e) { /* non-fatal */ }
    try {
        await Promise.race([
            c.destroy(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('destroy timeout')), 8000))
        ]);
    } catch (e) {
        console.warn('⚠️ client.destroy() warning (non-fatal):', e.message?.split('\n')[0]);
        try {
            if (c.pupBrowser && typeof c.pupBrowser.close === 'function') {
                await c.pupBrowser.close().catch(() => {});
            }
        } catch (_) {}
    }
}

// ─── Exponential back-off restart ────────────────────────────
/**
 * Schedules a reconnect with backoff.
 *
 * The backoff is what stops a permanently broken session (revoked auth,
 * missing Chrome, a WhatsApp protocol change) from becoming a tight restart
 * loop that spawns a browser process every few seconds and pins a CPU core.
 * Growth is per crash rather than per three crashes as before, and it stops
 * entirely after MAX_CRASHES_BEFORE_GIVING_UP — retrying forever is not
 * resilience when the cause needs a human.
 */
const MAX_CRASHES_BEFORE_GIVING_UP = 10;

function scheduleRestart(userId, baseDelayMs = 8000) {
    const s = getSession(userId);
    if (s.destroyed) return; // deliberately torn down; do not resurrect
    clearTimers(s);
    s.isConnected    = false;
    s.isInitializing = false;

    const now = Date.now();
    // A crash long after the last one is a fresh incident, not an escalation.
    if (now - s.lastCrashTime < 5 * 60 * 1000) {
        s.crashCount++;
    } else {
        s.crashCount = 1;
    }
    s.lastCrashTime = now;

    if (s.crashCount > MAX_CRASHES_BEFORE_GIVING_UP) {
        s.lastError = `Stopped reconnecting after ${s.crashCount - 1} consecutive failures.`;
        console.error(`❌ [user ${userId}] ${s.lastError} Reconnect manually from the dashboard.`);
        broadcastSSE(userId, {
            type: 'error',
            data: 'WhatsApp could not reconnect after several attempts. Click Connect to try again.'
        });
        return;
    }

    // 8s, 16s, 32s, … capped at 5 minutes, with jitter so many sessions
    // failing together (a WhatsApp-side outage) don't retry in lockstep and
    // hammer both WhatsApp and this server at the same instant.
    const capped = Math.min(baseDelayMs * Math.pow(2, s.crashCount - 1), 5 * 60 * 1000);
    const backoff = Math.round(capped * (0.75 + Math.random() * 0.5));
    console.log(`🔄 [user ${userId}] Scheduling WhatsApp restart in ${(backoff / 1000).toFixed(0)}s (failure #${s.crashCount})...`);

    broadcastSSE(userId, { type: 'disconnected' });

    s.restartTimer = setTimeout(async () => {
        s.restartTimer = null;
        if (s.destroyed) return;
        await safeDestroyClient(s);
        s.isInitializing = false;
        await initWhatsAppClient(userId);
    }, backoff);
    s.restartTimer.unref?.();
}

// ─── Initialization Queue ───────────────────────────────────────
const initQueue = [];
let isInitializingAnyClient = false;

async function processInitQueue() {
    if (isInitializingAnyClient || initQueue.length === 0) return;
    isInitializingAnyClient = true;

    const { userId, client } = initQueue.shift();
    const s = getSession(userId, false);

    if (!s || s.destroyed || !s.client) {
        isInitializingAnyClient = false;
        setTimeout(processInitQueue, 100);
        return;
    }

    console.log(`⏳ [user ${userId}] Initializing WhatsApp Web client (from queue)...`);
    try {
        await client.initialize();
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`❌ [user ${userId}] client.initialize() error:`, msg);
        s.isInitializing = false;
        s.lastError = `WhatsApp launch error: ${msg.split('\n')[0]}`;
        scheduleRestart(userId, 12000);
    } finally {
        isInitializingAnyClient = false;
        // Wait 4 seconds before allowing the next client to initialize.
        // This gives the CPU time to settle after the massive Puppeteer CPU spike.
        setTimeout(processInitQueue, 4000); 
    }
}

// ─── Main init (per user) ───────────────────────────────────────
/**
 * Starts (or reuses) one account's WhatsApp client.
 *
 * Returns { accepted: boolean, reason? } rather than throwing, so a route can
 * answer 503 when the server is at its session cap instead of reporting a
 * capacity limit as a 500.
 */
async function initWhatsAppClient(userId) {
    userId = Number(userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new Error('initWhatsAppClient requires a positive integer userId');
    }

    try {
        const { getUserById } = require('./database');
        const user = await getUserById(userId);
        if (!user || user.status !== 'active' || (user.role !== 'admin' && !user.wa_enabled)) {
            console.warn(`⚠️ [user ${userId}] Denying WhatsApp client start — wa_enabled is 0 or account is not active.`);
            return { accepted: false, reason: 'WhatsApp access is not enabled for this account.' };
        }
    } catch (e) {
        // Non-fatal if DB not loaded (test harness)
    }

    const s = getSession(userId);
    s.destroyed = false;
    s.userDisconnected = false;

    if (s.isInitializing) {
        if (s.startedAt && Date.now() - s.startedAt > 300000) {
            s.isInitializing = false;
            await safeDestroyClient(s);
        } else {
            if (s.currentQR) {
                broadcastSSE(userId, { type: 'qr', data: s.currentQR });
            }
            return { accepted: true, alreadyStarting: true };
        }
    }
    if (s.isConnected && s.client) {
        return { accepted: true, alreadyConnected: true };
    }
    if (!s.client && countActiveSessions() >= MAX_CONCURRENT_SESSIONS) {
        const reason = 'The server is at capacity for concurrent WhatsApp connections right now. Please try again shortly.';
        console.warn(`⚠️ [user ${userId}] Refusing to start WhatsApp client — at the concurrent-session limit (${MAX_CONCURRENT_SESSIONS}).`);
        broadcastSSE(userId, { type: 'error', data: reason });
        return { accepted: false, reason };
    }

    s.isInitializing = true;
    s.startedAt = Date.now();
    s.lastError = null;
    s.crashCount = 0;
    clearTimers(s);

    console.log(`🔧 [user ${userId}] Starting WhatsApp Web client...`);
    broadcastSSE(userId, { type: 'loading' });

    if (s.client) {
        await safeDestroyClient(s);
    }

    clearStaleLocks(userId);

    try {
        s.client = new Client({
            authStrategy: new LocalAuth({ dataPath: authDataPath(userId) }),
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0,
            // A local cache (bundled with whatsapp-web.js, tested against the
            // exact library version installed) instead of a hardcoded remote
            // fetch: the previous config pinned an old WhatsApp Web build
            // (2.2412.54) fetched from GitHub on every single connection
            // attempt — a stale/deprecated version and an extra network
            // dependency in the critical path of "show the QR code", and a
            // real cause of the QR taking a long time (or never appearing)
            // if that fetch is slow or GitHub is unreachable. Local cache
            // reads whatever the last successful session already saved to
            // .wwebjs_cache/, and transparently fetches live from
            // web.whatsapp.com only when nothing cached matches — no GitHub
            // dependency, no stale pin.
            webVersionCache: {
                type: 'none'
            },
            puppeteer: {
                headless: 'new',
                protocolTimeout: 300000,
                ...(process.env.PUPPETEER_EXECUTABLE_PATH
                    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
                    : (fs.existsSync('/usr/bin/chromium')
                        ? { executablePath: '/usr/bin/chromium' }
                        : (fs.existsSync('/usr/bin/chromium-browser') ? { executablePath: '/usr/bin/chromium-browser' } : {}))),
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--disable-gpu',
                    '--disable-extensions',
                    // ── Memory-saving flags for low-RAM servers ──────────────
                    // Limit V8 heap to 256MB per renderer (default can be 512MB+)
                    '--js-flags=--max-old-space-size=256',
                    // Disable features that use background RAM even when idle
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-breakpad',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-ipc-flooding-protection',
                    // Reduce number of renderer processes
                    '--renderer-process-limit=2',
                    // Don't run Chrome's internal crash reporter — saves ~30MB
                    '--disable-crash-reporter',
                    '--noerrdialogs'
                ]
            }
        });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`❌ [user ${userId}] Failed to create WhatsApp client:`, msg);
        s.isInitializing = false;
        s.lastError = `Failed to create client: ${msg.split('\n')[0]}`;
        scheduleRestart(userId, 10000);
        return { accepted: true, starting: false };
    }

    const client = s.client;
    attachHandlers(userId, s, client);

    console.log(`⏳ [user ${userId}] Added to WhatsApp initialization queue...`);
    initQueue.push({ userId, client });
    processInitQueue();

    return { accepted: true, starting: true };
}

function attachHandlers(userId, s, client) {
    // ── QR ──────────────────────────────────────────────────
    client.on('qr', async (qr) => {
        console.log(`📱 [user ${userId}] QR Code ready — open Settings → WhatsApp QR to scan.`);
        s.isConnected = false;
        try {
            s.currentQR = await qrcode.toDataURL(qr);
            // Tenant-scoped: only this account's listeners receive it.
            broadcastSSE(userId, { type: 'qr', data: s.currentQR });
        } catch (err) {
            console.error(`[user ${userId}] Failed to generate QR data URL:`, err.message);
        }

        // Auto-teardown idle QR code after 3 minutes if unscanned to free RAM & CPU
        if (!s.qrTimeout) {
            s.qrTimeout = setTimeout(async () => {
                s.qrTimeout = null;
                if (!s.isConnected && s.client) {
                    console.log(`⏱️ [user ${userId}] QR code scan timed out after 3 minutes — stopping idle Chrome.`);
                    clearTimers(s);
                    s.currentQR = null;
                    await safeDestroyClient(s);
                    broadcastSSE(userId, { type: 'error', data: 'QR code timed out. Click Connect when ready to scan.' });
                }
            }, 180000);
            s.qrTimeout.unref?.();
        }
    });

    // ── Auth ────────────────────────────────────────────────
    client.on('authenticated', () => {
        console.log(`✅ [user ${userId}] WhatsApp Authenticated!`);
        s.currentQR = null;
        if (s.qrTimeout) { clearTimeout(s.qrTimeout); s.qrTimeout = null; }
    });

    // ── Ready ───────────────────────────────────────
    client.on('ready', () => {
        console.log(`✅ [user ${userId}] WhatsApp Client is READY!`);
        s.isConnected    = true;
        s.isInitializing = false;
        s.isHibernated   = false;
        s.currentQR      = null;
        s.crashCount     = 0;
        s.lastError      = null;
        s.lastActivityAt = Date.now();
        if (s.qrTimeout) { clearTimeout(s.qrTimeout); s.qrTimeout = null; }

        try {
            broadcastSSE(userId, { type: 'ready', phone: client.info?.wid?.user || 'unknown' });
        } catch (e) {}

        clearTimers(s);

        s.keepAliveTimer = setInterval(async () => {
            try {
                const state = await Promise.race([
                    client.getState(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('getState timeout')), 5000))
                ]);
                if (state !== 'CONNECTED') {
                    console.warn(`⚠️ [user ${userId}] WhatsApp state is`, state, '— scheduling reconnect.');
                    scheduleRestart(userId, 5000);
                }
            } catch (e) {
                const msg = e.message || '';
                const isTransient = msg.includes('Execution context') || msg.includes('Target closed') || msg.includes('timeout');
                if (isTransient) {
                    s.transientKeepAliveFailures = (s.transientKeepAliveFailures || 0) + 1;
                    if (s.transientKeepAliveFailures >= 3) {
                        s.transientKeepAliveFailures = 0;
                        console.warn(`⚠️ [user ${userId}] Keep-alive failed 3× in a row — reconnecting.`);
                        scheduleRestart(userId, 5000);
                    }
                } else {
                    console.warn(`⚠️ [user ${userId}] Keep-alive fatal error:`, msg.split('\n')[0]);
                    scheduleRestart(userId, 5000);
                }
            }
        }, 30000);
        s.keepAliveTimer.unref?.();

        s.watchdogTimer = setInterval(() => {
            if (s.currentQR || s.isInitializing || s.restartTimer || s.destroyed || s.userDisconnected) {
                return;
            }
            if (!s.isConnected) {
                console.warn(`🐕 [user ${userId}] Watchdog: not connected and not restarting — triggering restart.`);
                scheduleRestart(userId, 5000);
            }
        }, 90000);
        s.watchdogTimer.unref?.();
    });

    // ── Auth failure ─────────────────────────────────────────
    client.on('auth_failure', msg => {
        console.error(`❌ [user ${userId}] WhatsApp Auth failure:`, msg);
        s.isConnected    = false;
        s.isInitializing = false;
        s.lastError = 'WhatsApp authentication failed. You may need to scan the QR code again.';
        broadcastSSE(userId, { type: 'error', data: s.lastError });
        scheduleRestart(userId, 15000);
    });

    // ── Disconnected ─────────────────────────────────────────
    client.on('disconnected', (reason) => {
        console.log(`❌ [user ${userId}] WhatsApp disconnected:`, reason);
        s.isConnected    = false;
        s.isInitializing = false;
        s.currentQR      = null;
        if (s.watchdogTimer) { clearInterval(s.watchdogTimer); s.watchdogTimer = null; }
        scheduleRestart(userId, 8000);
    });

    // ── Client error (Puppeteer level) ───────────────────────
    client.on('error', (err) => {
        const msg = err?.message || String(err);
        const ignorable = ['Target closed', 'Session closed', 'Execution context', 'Protocol error'];
        if (ignorable.some(s2 => msg.includes(s2))) return;
        console.error(`❌ [user ${userId}] WhatsApp client error:`, msg.split('\n')[0]);
    });

    // ── Incoming message ─────────────────────────────────────
    client.on('message', async msg => {
        try {
            if (msg.isGroupMsg || msg.isStatus || msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;
            if (!msg.body || msg.body.trim() === '') return;
            if (msg.fromMe) return;

            // msg.from is "<digits>@c.us"; take the digits. A malformed
            // address is dropped rather than passed downstream.
            const phone = String(msg.from).split('@')[0];
            if (!/^\d{7,15}$/.test(phone)) return;

            // Mark the session as active so the hibernation timer is re-armed.
            s.lastActivityAt = Date.now();
            armHibernationTimer(userId);

            let contactName = '';
            try {
                const contact = await msg.getContact();
                contactName = String(contact?.pushname || contact?.name || '').slice(0, 200);
            } catch (e) { /* non-fatal */ }

            await Promise.race([
                processMessage(userId, phone, msg.body, contactName, client, msg),
                new Promise((_, rej) => setTimeout(() => rej(new Error('processMessage timeout after 90s')), 90000))
            ]);
        } catch (error) {
            // Swallowed on purpose, and only here: an inbound message handler
            // rejecting would be an unhandledRejection, which server.js
            // treats as fatal — one malformed message would restart the
            // process and disconnect every other tenant.
            console.error(`   ❌ [user ${userId}] message handler error (non-fatal):`, error.message?.split('\n')[0]);
        }
    });
}

// ─── Tear down a user's session entirely (suspend / delete) ───
/**
 * Fully removes an account's live session: timers, SSE streams, Chrome
 * process, and registry entry.
 *
 * `destroyed` is set first so any in-flight event handler or pending restart
 * timer that fires during teardown does not resurrect the session — the
 * exact reason a suspended account could previously reconnect itself
 * seconds after being cut off.
 */
async function destroyClientForUser(userId) {
    userId = Number(userId);
    const s = getSession(userId, false);
    if (!s) return;
    s.destroyed = true;
    s.userDisconnected = true;
    s.isHibernated = false;
    clearTimers(s);
    s.isConnected = false;
    s.isInitializing = false;
    s.currentQR = null;
    s.crashCount = 0;
    s.lastError = null;

    broadcastSSE(userId, { type: 'disconnected' });

    if (s.client) {
        try {
            await Promise.race([
                s.client.logout(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('logout timeout')), 4000))
            ]);
        } catch (e) { /* client may already be closed or disconnected */ }
    }

    await safeDestroyClient(s);

    // Clean up saved auth directory on explicit disconnect so next connect is a clean fresh session
    const authDir = authDataPath(userId);
    try {
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (e) { /* non-fatal */ }
}

/** Tears down every session — used by graceful shutdown. */
async function destroyAllClients() {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map(id => destroyClientForUser(id).catch(() => {})));
    return ids.length;
}

// ─── SSE client handler (scoped per user) ──────────────────────
/**
 * Attaches one browser tab to an account's event stream.
 *
 * Called only from a requireAuth-protected route with req.user.id, so the
 * stream is bound to the authenticated account and a client cannot ask for
 * another tenant's QR by changing a parameter — there is no parameter.
 */
function addSSEClient(userId, req, res) {
    userId = Number(userId);
    const s = getSession(userId);

    // Refuse before allocating anything. Returning 429 with a JSON body (not
    // an event stream) tells the frontend to stop reconnecting.
    if (s.sseClients.length >= MAX_SSE_CLIENTS_PER_USER) {
        return res.status(429).json({
            success: false,
            error: 'Too many open status streams for this account. Close other tabs and try again.',
            code: 'SSE_LIMIT'
        });
    }
    if (totalSseClients >= MAX_SSE_CLIENTS_TOTAL) {
        return res.status(503).json({
            success: false,
            error: 'The server is at capacity for live status streams. Please retry shortly.',
            code: 'SSE_CAPACITY'
        });
    }

    // ─── SSE Origin Validation (Critical Security Fix) ─────────────────
    // SameSite=Lax allows cross-site GET with cookies, so a malicious site
    // could open /api/qr-stream in a top-level navigation and steal the QR
    // code. Validate Origin and Sec-Fetch-Site headers to prevent this.
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
        return res.status(403).json({
            success: false,
            error: 'Invalid origin for SSE',
            code: 'ORIGIN_REJECTED'
        });
    }
    // Defense in depth: reject cross-site navigations even if Origin is missing
    if (req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({
            success: false,
            error: 'Cross-site SSE not allowed',
            code: 'CSRF_REJECTED'
        });
    }
    // If no allowed origins configured but we're in production, warn
    if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
        console.warn('⚠️ ALLOWED_ORIGINS not set in production — SSE origin validation is permissive');
    }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection',    'keep-alive');
    // Tells nginx/Caddy not to buffer, without which events arrive in batches
    // (or not at all) behind a reverse proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const client = { req, res, heartbeat: null, userId };
    s.sseClients.push(client);
    totalSseClients++;

    const send = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { removeSseClient(s, client); }
    };

    // Cancel the hibernation countdown while the user has their tab open —
    // there's no point freeing Chrome while they're actively looking at it.
    if (s.hibernationTimer) { clearTimeout(s.hibernationTimer); s.hibernationTimer = null; }

    if (s.isConnected && s.client?.info) {
        send({ type: 'ready', phone: s.client.info.wid.user });
    } else if (s.currentQR) {
        send({ type: 'qr', data: s.currentQR });
    } else if (s.userDisconnected) {
        send({ type: 'disconnected' });
    } else {
        send({ type: 'loading' });
        // Covers two cases:
        //   1. Nothing started yet (first visit after signup)
        //   2. Session was hibernated — silently revive Chrome without a new QR.
        if (!s.isInitializing && !s.client) {
            initWhatsAppClient(userId).then(result => {
                if (result && result.accepted === false) send({ type: 'error', data: result.reason });
            }).catch(e => {
                send({ type: 'error', data: e.message });
            });
        }
    }

client.heartbeat = setInterval(() => {
          // Rate-limit heartbeats: max 180 per connection (1 hour at 20s intervals)
          // Prevents a malicious/buggy client from holding the connection forever.
          if (++client.hbSent > 180) {
              removeSseClient(s, client);
              return;
          }
          try {
              res.write(': heartbeat\n\n');
          } catch (e) {
              removeSseClient(s, client);
          }
      }, 20000);
      client.heartbeat.unref?.();
      client.hbSent = 0;

    // Both events matter: 'close' covers a normal disconnect, 'error' covers a
    // reset connection. Missing either leaks the timer and the array entry —
    // which is how an SSE endpoint becomes a memory and file-descriptor leak.
    const cleanup = () => {
        removeSseClient(s, client);
        // User closed their tab. If nobody else is watching, re-arm the
        // hibernation countdown so Chrome is freed after the idle window.
        if (s.sseClients.length === 0 && s.isConnected && !s.destroyed && !s.userDisconnected) {
            armHibernationTimer(userId);
        }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
}

// ─── Exports ─────────────────────────────────────────────────
function getClient(userId) {
    const s = getSession(Number(userId), false);
    return s ? s.client : null;
}

function getStatus(userId) {
    const s = getSession(Number(userId), false);
    if (!s) return { connected: false, phone: null, started: false, error: null, qr: null, hibernated: false };
    return {
        connected: s.isConnected,
        phone: s.isConnected && s.client?.info ? s.client.info.wid.user : null,
        started: !!(s.client || s.isInitializing),
        initializing: !!s.isInitializing,
        hibernated: !!s.isHibernated,
        error: s.lastError || null,
        // Expose QR data URL so the frontend can fetch it via REST polling
        // when the SSE stream is blocked by a cloud load balancer / proxy.
        qr: s.currentQR || null
    };
}

/** Registry-wide counters for /health and capacity monitoring. */
function getSessionMetrics() {
    let connected = 0, initializing = 0, hibernated = 0;
    for (const s of sessions.values()) {
        if (s.isConnected) connected++;
        else if (s.isInitializing) initializing++;
        if (s.isHibernated) hibernated++;
    }
    return {
        sessions: sessions.size,
        connected,
        initializing,
        hibernated,
        maxConcurrent: MAX_CONCURRENT_SESSIONS,
        idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
        hibernationEnabled: HIBERNATION_ENABLED,
        sseClients: totalSseClients,
        maxSseClients: MAX_SSE_CLIENTS_TOTAL
    };
}

/**
 * Sends a text message on behalf of one account.
 *
 * The chat id is built here from digits only, so the destination cannot be
 * steered to a group, a broadcast list, or a raw internal WhatsApp id by
 * whatever the caller passed in. validate.normalizePhone enforces the same
 * shape at the API boundary; this is the second gate, because the scheduler
 * and outreach also reach this function with data read back out of the
 * database.
 */
async function sendTextMessage(userId, phone, text) {
    const s = getSession(Number(userId), false);
    if (!s || !s.isConnected || !s.client) {
        const err = new Error('WhatsApp client is not connected');
        err.code = 'WA_NOT_CONNECTED';
        err.status = 409;
        throw err;
    }
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
        const err = new Error('Invalid destination phone number');
        err.status = 400;
        throw err;
    }
    return await s.client.sendMessage(`${digits}@c.us`, String(text));
}

/**
 * Sends a product image message with an optional caption on behalf of an account.
 * Validates connection state, phone format, product ownership, and image file existence.
 */
async function sendProductMediaMessage(userId, phone, productIdOrData, caption = '') {
    const s = getSession(Number(userId), false);
    if (!s || !s.isConnected || !s.client) {
        const err = new Error('WhatsApp client is not connected');
        err.code = 'WA_NOT_CONNECTED';
        err.status = 409;
        throw err;
    }
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
        const err = new Error('Invalid destination phone number');
        err.status = 400;
        throw err;
    }

    let product = productIdOrData;
    if (typeof productIdOrData === 'number' || typeof productIdOrData === 'string') {
        const { getProductById } = require('./database');
        product = await getProductById(Number(userId), productIdOrData);
    }

    if (!product || !product.image_path) {
        const err = new Error('Product not found or has no image');
        err.status = 404;
        throw err;
    }

    const { getImageFilePath } = require('./product-storage');
    const filePath = getImageFilePath(product.image_path);
    if (!filePath || !fs.existsSync(filePath)) {
        const err = new Error('Product image file not found on disk');
        err.status = 404;
        throw err;
    }

    const media = MessageMedia.fromFilePath(filePath);
    const chatId = `${digits}@c.us`;
    return await s.client.sendMessage(chatId, media, { caption: String(caption || '') });
}

module.exports = {
    initWhatsAppClient,
    destroyClientForUser,
    destroyAllClients,
    addSSEClient,
    getClient,
    getStatus,
    getSessionMetrics,
    sendTextMessage,
    sendProductMediaMessage,
    authDataPath,
    MAX_CONCURRENT_SESSIONS,
    MAX_SSE_CLIENTS_PER_USER,
    MAX_SSE_CLIENTS_TOTAL
};



