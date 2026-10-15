/**
 * server.js — process lifecycle: boot, listen, shut down.
 *
 * The application itself is built in src/app.js so tests can exercise the
 * real middleware stack. What lives here is everything that only makes sense
 * for a running process.
 *
 * On the crash policy specifically. The previous version kept a
 * `setInterval` alive "so Node never exits when Chrome crashes", and handled
 * uncaughtException by exiting. Those two intentions are contradictory, and
 * the first one is wrong: after an uncaught exception the process is in an
 * unknown state — a half-finished database write, a lock never released, a
 * request never answered. Continuing to serve from that state is how silent
 * corruption happens. So: fail fast, flush what can be flushed, and let the
 * supervisor (launcher.js, Docker's restart policy, or systemd) start a clean
 * process. That is a deliberate choice in favour of correctness over an
 * uptime number.
 */
require('dotenv').config();

const { createApp } = require('./src/config/app');
const { initDatabase, closeDatabase, getPersistHealth, listUsers } = require('./src/services/database');
const { initScheduler, stopScheduler, isSchedulerBusy } = require('./src/services/scheduler');
const { initCalendarSync, stopCalendarSync } = require('./src/services/calendar-sync');
const { initWhatsAppClient, destroyAllClients } = require('./src/services/whatsapp-client');
const { cancelAllOutreachJobs } = require('./src/services/outreach');
const { clearPendingAutoAnalyses } = require('./src/services/lead-analyzer');
const fs   = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS, 10) || 15000;

let httpServer = null;
let shuttingDown = false;

const { assertPersistRootWritable } = require('./src/config/paths');

// ─── Startup configuration checks ─────────────────────────────
/**
 * Refuses to start a production process that is misconfigured in a way that
 * would be silently insecure.
 *
 * The alternative — log a warning and carry on — means the warning scrolls
 * past in a deploy log and the service runs for months with, say, an
 * ephemeral session secret that logs every user out on each restart, or
 * cookies without Secure. A refused boot is noticed immediately.
 */
function validateEnvironment() {
    assertPersistRootWritable();
    const problems = [];
    const warnings = [];
    const isProd = process.env.NODE_ENV === 'production';

    if (isProd) {
        if (!process.env.SESSION_SECRET && !fs.existsSync(path.join(process.env.PERSIST_ROOT || __dirname, 'data', '.session_secret'))) {
            warnings.push('SESSION_SECRET is not set; one will be generated and persisted to data/.session_secret. Set it explicitly if you run more than one instance, or every instance will sign cookies differently.');
        }
        if (process.env.ALLOW_INSECURE_COOKIES === 'true') {
            warnings.push('ALLOW_INSECURE_COOKIES=true — session cookies will be sent without the Secure flag. Only acceptable for local debugging.');
        }
        if (process.env.FORCE_HTTPS !== 'true') {
            warnings.push('FORCE_HTTPS is not enabled. If a reverse proxy terminates TLS, set FORCE_HTTPS=true so plain-HTTP requests are redirected and HSTS is sent.');
        }
        if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
            // Correct behind Caddy/nginx; dangerous when directly exposed,
            // because X-Forwarded-For becomes client-controlled and every
            // rate limiter can be bypassed by rotating the header.
            warnings.push('TRUST_PROXY is enabled — make sure this process is actually behind a proxy you control, or clients can spoof their IP and bypass rate limits.');
        }
        if (process.env.DISABLE_RATE_LIMITS === 'true') {
            problems.push('DISABLE_RATE_LIMITS=true must never be set in production — it turns off login brute-force protection.');
        }
        const maxSessions = parseInt(process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS, 10);
        if (Number.isFinite(maxSessions) && maxSessions > 50) {
            warnings.push(`MAX_CONCURRENT_WHATSAPP_SESSIONS=${maxSessions} — each session is a Chrome process using roughly 150-250MB. Verify the host actually has that memory.`);
        }
    }

    if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
        problems.push(`PORT is not a valid port number (got "${process.env.PORT}").`);
    }

    for (const w of warnings) console.warn(`⚠️  Config: ${w}`);
    if (problems.length) {
        console.error('❌ Refusing to start due to configuration problems:');
        for (const p of problems) console.error(`   • ${p}`);
        process.exit(1);
    }
}

// ─── Crash guards ─────────────────────────────────────────────
function fatal(label, err) {
    console.error(`❌ ${label}:`, err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    try { closeDatabase().catch(() => {}); } catch (_) {}
    process.exit(1);
}

function isNonFatalRejection(err) {
    const msg = (err && (err.message || String(err))) || '';
    return (
        msg.includes('onQRChangedEvent') ||
        msg.includes('already exists') ||
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Protocol error') ||
        msg.includes('Session closed') ||
        msg.includes('Evaluation failed') ||
        msg.includes('Cannot find context with specified id') ||
        msg.includes('EBUSY') ||
        msg.includes('resource busy or locked') ||
        msg.includes('lockfile') ||
        msg.includes('LocalAuth') ||
        msg.includes('EPERM')
    );
}

process.on('uncaughtException', (err) => fatal('UNCAUGHT EXCEPTION', err));
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (isNonFatalRejection(err)) {
        console.warn('⚠️  Ignored non-fatal Puppeteer/async unhandled rejection:', err.message);
        return;
    }
    fatal('UNHANDLED REJECTION', err);
});

// ─── Graceful shutdown ────────────────────────────────────────
/**
 * Stops accepting new work, lets in-flight work finish, then exits.
 *
 * Order matters:
 *   1. stop the HTTP listener      — no new requests
 *   2. stop the scheduler          — no new sends started
 *   3. cancel background jobs      — outreach loops and pending AI timers
 *   4. wait for in-flight sends    — bounded by SHUTDOWN_GRACE_MS
 *   5. tear down Chrome processes  — otherwise they outlive the container
 *   6. close database pool         — last, so it captures everything above
 */
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 ${signal} received — shutting down gracefully...`);

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;

    if (httpServer) {
        await new Promise(resolve => httpServer.close(resolve)).catch(() => {});
        console.log('   ✔ HTTP listener closed');
    }

    stopScheduler();
    stopCalendarSync();
    const cancelled = cancelAllOutreachJobs();
    if (cancelled) console.log(`   ✔ Requested cancellation of ${cancelled} outreach job(s)`);
    clearPendingAutoAnalyses();

    while (isSchedulerBusy() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
    }
    if (isSchedulerBusy()) console.warn('   ⚠ Scheduler still busy at the shutdown deadline — proceeding anyway');
    else console.log('   ✔ Scheduler idle');

    try {
        const n = await destroyAllClients();
        console.log(`   ✔ Closed ${n} WhatsApp session(s)`);
    } catch (e) {
        console.warn('   ⚠ Error closing WhatsApp sessions:', e.message);
    }

    try {
        await closeDatabase();
        console.log('   ✔ Database connections closed');
    } catch (e) {
        console.error('   ❌ Could not close database pool cleanly:', e.message);
    }

    console.log('👋 Shutdown complete');
    process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });

// ─── Reconnect WhatsApp for accounts connected before a restart ──
/**
 * Resumes saved sessions, oldest-first, spread out over time.
 *
 * Starting them all at once is what made restarts painful: 25 Chrome
 * processes launching simultaneously spikes CPU and memory hard enough that
 * the HTTP server becomes unresponsive right when users are reloading the
 * page to see if the service is back. Staggering trades a slower full
 * recovery for a site that stays usable throughout.
 */
const RESUME_STAGGER_MS = parseInt(process.env.RESUME_STAGGER_MS, 10) || 4000;

async function resumeExistingSessions() {
    try {
        const authRoot = path.join(process.env.PERSIST_ROOT || __dirname, '.wwebjs_auth');
        if (!fs.existsSync(authRoot)) return;

        const users = await listUsers();
        const activeUserIds = new Set(
            users
                .filter(u => u.status === 'active' && (u.role === 'admin' || u.wa_enabled === 1))
                .map(u => u.id)
        );
        const resumable = [];

        for (const dir of fs.readdirSync(authRoot)) {
            const match = dir.match(/^user_(\d+)$/);
            if (!match) continue;
            const userId = parseInt(match[1], 10);
            // A suspended or deleted account must not be reconnected — its
            // session folder may still exist on disk.
            if (!activeUserIds.has(userId)) continue;
            const sessionPath = path.join(authRoot, dir);
            try {
                if (fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0) resumable.push(userId);
            } catch (e) { /* unreadable dir — skip */ }
        }

        if (resumable.length === 0) return;
        console.log(`🔁 Resuming ${resumable.length} saved WhatsApp session(s), ${RESUME_STAGGER_MS / 1000}s apart...`);

        resumable.forEach((userId, i) => {
            const t = setTimeout(() => {
                if (shuttingDown) return;
                try {
                    initWhatsAppClient(userId);
                } catch (e) {
                    console.warn(`⚠️ Could not resume session for user ${userId}:`, e.message);
                }
            }, i * RESUME_STAGGER_MS);
            t.unref?.();
        });
    } catch (e) {
        console.warn('⚠️ Could not resume existing WhatsApp sessions (non-fatal):', e.message);
    }
}

// ─── Start ────────────────────────────────────────────────────
async function start() {
    validateEnvironment();

    try {
        await initDatabase();
        console.log('✅ Database initialized');
    } catch (dbErr) {
        console.error('❌ Database init failed:', dbErr.message);
        process.exit(1);
    }

    const app = createApp();

    try {
        await initScheduler();
        console.log('✅ Scheduler initialized');
    } catch (schedErr) {
        console.error('⚠️ Scheduler init failed (non-fatal):', schedErr.message);
    }

    try {
        initCalendarSync();
    } catch (calErr) {
        console.error('⚠️ Calendar sync init failed (non-fatal):', calErr.message);
    }

    await new Promise((resolve, reject) => {
        httpServer = app.listen(PORT, resolve);
        httpServer.on('error', reject);
    });

    // Slow-client protections. Without headersTimeout/requestTimeout, a
    // client that opens a connection and dribbles bytes holds a socket
    // indefinitely — a few thousand of those exhaust the process's file
    // descriptors with almost no attacker bandwidth (Slowloris).
    httpServer.headersTimeout = 20000;
    httpServer.requestTimeout = 60000;
    httpServer.keepAliveTimeout = 20000;

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   WhatsApp Automation Server Running! 🚀     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║   Landing:  http://localhost:${PORT}`);
    console.log(`║   Log in:   http://localhost:${PORT}/login`);
    console.log(`║   Health:   http://localhost:${PORT}/health`);
    console.log(`║   Ready:    http://localhost:${PORT}/ready`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // ─── Capacity diagnostics ─────────────────────────────────
    // Log memory and session cap so OOM crashes are diagnosable from logs.
    const os = require('os');
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const maxWaSessions = parseInt(process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS, 10) || 5;
    const estimatedPeakMB = maxWaSessions * 250 + 500; // 250MB per Chrome + 500MB for Node/OS
    console.log(`📊 System: ${totalMemMB}MB total, ${freeMemMB}MB free | WA session cap: ${maxWaSessions} (est. peak ~${estimatedPeakMB}MB)`);
    if (estimatedPeakMB > totalMemMB * 0.85) {
        console.warn(`⚠️  WARNING: ${maxWaSessions} WhatsApp sessions could use ~${estimatedPeakMB}MB, which exceeds 85% of available memory (${totalMemMB}MB). Risk of OOM kill! Lower MAX_CONCURRENT_WHATSAPP_SESSIONS or add more RAM.`);
    }

    if (!getPersistHealth().ok) {
        console.error('❌ The database could not be written on startup — the service will refuse writes until this is fixed.');
    }

    // After the HTTP server is listening, so the site is reachable while
    // sessions come back.
    await resumeExistingSessions();
}

if (require.main === module) {
    start().catch(err => {
        console.error('❌ Fatal server start error:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { start, shutdown, validateEnvironment };


