/**
 * launcher.js — Crash-proof wrapper for server.js with correct signal handling.
 *
 * Uses exponential back-off so a boot-loop doesn't hammer the system.
 *
 * Signal handling (critical for Docker / Render graceful shutdown):
 *
 *   SIGTERM/SIGINT are forwarded to the child server process.
 *   The launcher then waits for server.js to complete its own graceful
 *   shutdown (flush the database, close WhatsApp sessions, drain HTTP).
 *   If the server doesn't exit within the grace period, it is force-killed.
 *
 *   WITHOUT this forwarding, `docker stop` sends SIGTERM to PID 1 (the
 *   launcher). The old code called process.exit(0) immediately, which
 *   also killed the child — bypassing server.js's entire shutdown sequence.
 *   The database was never flushed and WhatsApp sessions were dropped abruptly.
 *
 * NOTE: In Docker, add `init: true` to the service (or use --init) so that
 * a proper init process (tini) handles PID 1 zombie reaping. The launcher
 * itself does not need to be PID 1 for signal forwarding to work, but tini
 * ensures orphaned Chromium child processes are reaped correctly.
 */
const { spawn } = require('child_process');

try {
    const patchWWebJS = require('./scripts/patch-wwebjs');
    patchWWebJS();
} catch (e) {
    console.warn('⚠️ [Launcher] patchWWebJS warning:', e.message);
}

let restartCount  = 0;
let lastStartTime = Date.now();
let currentChild  = null;
let shuttingDown  = false;

// How long to wait for the child to finish its own graceful shutdown before
// we force-kill it. Should exceed server.js's own SHUTDOWN_TIMEOUT_MS.
const FORWARD_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS, 10) || 30000;

// Exponential back-off: 2s → 4s → 8s → 16s → 30s (cap)
function backoffDelay(attempt) {
    return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
}

function startServer() {
    if (shuttingDown) return;

    restartCount++;
    lastStartTime = Date.now();
    console.log(`\n🚀 [Launcher] Starting server... (attempt #${restartCount})`);

    const child = spawn('node', ['server.js'], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env }
    });

    currentChild = child;

    child.on('error', (err) => {
        console.error('[Launcher] Failed to spawn server:', err.message);
        currentChild = null;
        if (!shuttingDown) scheduleRestart();
    });

    child.on('exit', (code, signal) => {
        currentChild = null;
        const uptime = ((Date.now() - lastStartTime) / 1000).toFixed(1);

        // If we are shutting down, propagate the child's exit code and stop.
        if (shuttingDown) {
            const exitCode = code != null ? code : 1;
            console.log(`\n🛑 [Launcher] Server exited (code=${code}, signal=${signal}). Launcher exiting.`);
            process.exit(exitCode);
            return;
        }

        // If process was alive for > 60s, treat it as a "clean" run and reset back-off
        if (Date.now() - lastStartTime > 60000) {
            restartCount = 0;
        }

        // SIGINT = user pressed Ctrl+C on the launcher, don't restart
        if (signal === 'SIGINT' || code === 0) {
            console.log(`\n🛑 [Launcher] Server exited cleanly (code=${code}, signal=${signal}). Not restarting.`);
            process.exit(0);
        }

        console.log(`\n⚠️  [Launcher] Server crashed after ${uptime}s (code=${code}, signal=${signal})`);
        scheduleRestart();
    });
}

function scheduleRestart() {
    const delay = backoffDelay(restartCount);
    console.log(`🔄 [Launcher] Restarting in ${(delay / 1000).toFixed(0)}s... (attempt ${restartCount})`);
    setTimeout(startServer, delay);
}

/**
 * Gracefully shuts down by forwarding the signal to the child and waiting
 * for it to exit. Falls back to SIGKILL after FORWARD_GRACE_MS.
 */
function gracefulShutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n🛑 [Launcher] ${sig} received, forwarding to server and waiting up to ${FORWARD_GRACE_MS / 1000}s...`);

    if (!currentChild) {
        // No child running (e.g. we're in a back-off delay), exit immediately.
        process.exit(0);
        return;
    }

    // Forward the signal to the child so server.js runs its shutdown sequence.
    try { currentChild.kill(sig); } catch (e) { /* child may have already exited */ }

    // Hard deadline: if the server doesn't finish in time, force-kill it.
    const deadline = setTimeout(() => {
        console.error(`\n💀 [Launcher] Server did not exit within ${FORWARD_GRACE_MS / 1000}s after ${sig}. Force-killing.`);
        try { currentChild.kill('SIGKILL'); } catch (e) { /* ignore */ }
        process.exit(1);
    }, FORWARD_GRACE_MS);

    // Make sure the deadline timer doesn't keep the event loop alive if the
    // child exits before the deadline.
    if (deadline.unref) deadline.unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

startServer();
