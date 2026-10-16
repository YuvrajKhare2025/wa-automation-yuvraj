/**
 * paths.js — single canonical source of truth for every persistence path.
 *
 * Why this module exists:
 *   Previously, `PERSIST_ROOT` was resolved independently in database.js,
 *   src/config/auth.js, and whatsapp-client.js, each with a slightly
 *   different fallback. A mismatch between where one module writes and where
 *   another reads is how sessions silently disappear after a restart, and the
 *   kind of bug that only surfaces in production under Docker or Render where
 *   the working directory differs from development.
 *
 *   Every stateful component now imports from here. There is exactly one
 *   place where PERSIST_ROOT is computed, so all paths are guaranteed to
 *   agree.
 *
 * PERSIST_ROOT resolution order:
 *   1. PERSIST_ROOT env var (explicit: Docker volume mount, Render disk, etc.)
 *   2. Two levels above this file (src/config/../../ = project root)
 *      Works for bare-Node development AND Docker where WORKDIR=/app.
 *
 * In Docker (WORKDIR /app, volumes mounted at /app/data, /app/.wwebjs_auth,
 * /app/.wwebjs_cache), this file resolves to /app — matching the Dockerfile's
 * VOLUME declarations exactly. No env var needed.
 *
 * On Render with a persistent disk at /app/persist, set:
 *   PERSIST_ROOT=/app/persist
 * and all paths land on the persistent disk.
 */
const path = require('path');
const fs   = require('fs');

const PERSIST_ROOT = process.env.PERSIST_ROOT
    ? path.resolve(process.env.PERSIST_ROOT)
    : path.resolve(__dirname, '..', '..');   // src/config/../../ = project root

const DATA_DIR    = path.join(PERSIST_ROOT, 'data');
const DB_PATH     = path.join(DATA_DIR, 'whatsapp.db');
const SECRET_PATH = path.join(DATA_DIR, '.session_secret');
const AUTH_ROOT   = path.join(PERSIST_ROOT, '.wwebjs_auth');
const CACHE_ROOT  = path.join(PERSIST_ROOT, '.wwebjs_cache');
const PRODUCT_UPLOADS_DIR = path.join(DATA_DIR, 'product_images');
const OUTREACH_UPLOADS_DIR = path.join(DATA_DIR, 'outreach_media');

/**
 * In production, refuse to start if the persistence root either doesn't
 * exist or isn't writable — a silent non-writable directory is the "false
 * success" failure mode the audit specifically calls out. Not called in test
 * (NODE_ENV=test) because tests redirect PERSIST_ROOT to a temp directory
 * that freshDatabase() creates on demand.
 */
function assertPersistRootWritable() {
    if (process.env.NODE_ENV === 'test') return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.mkdirSync(PRODUCT_UPLOADS_DIR, { recursive: true });
        fs.mkdirSync(OUTREACH_UPLOADS_DIR, { recursive: true });
        const probe = path.join(DATA_DIR, '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
    } catch (err) {
        throw new Error(
            `PERSIST_ROOT (${PERSIST_ROOT}) is not writable: ${err.message}. ` +
            `In Docker, ensure the volume is mounted. On Render, enable the persistent disk ` +
            `and set PERSIST_ROOT to its mount path.`
        );
    }
}

module.exports = {
    PERSIST_ROOT,
    DATA_DIR,
    DB_PATH,
    SECRET_PATH,
    AUTH_ROOT,
    CACHE_ROOT,
    PRODUCT_UPLOADS_DIR,
    OUTREACH_UPLOADS_DIR,
    assertPersistRootWritable,
};
