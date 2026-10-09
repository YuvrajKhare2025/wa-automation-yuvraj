/**
 * app.js — builds the Express application.
 *
 * Split out of server.js so that tests exercise the *real* application —
 * the same middleware order, the same headers, the same error handler — and
 * not a hand-assembled approximation of it. A test suite that builds its own
 * mini-app can pass while the deployed app is broken, which is exactly the
 * false confidence this project needs to avoid.
 *
 * server.js keeps the process concerns: listening, signals, crash policy.
 */
// Only load .env in non-test environments. In test mode, tests/setup.js
// owns the environment: it deletes production-only vars and sets controlled
// values before any module loads. Re-running dotenv.config() here after a
// Jest module-cache reset would overwrite those test values with the
// developer's real .env (including BOOTSTRAP_ADMIN_EMAIL, real API keys,
// etc.), breaking test isolation.
if (process.env.NODE_ENV !== 'test') {
    require('dotenv').config();
}
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const compression = require('compression');
const { nonceMiddleware } = require('../middleware/nonce');
const { requestLogger } = require('../utils/logger');
const apiRoutes                     = require('../routes/api');
const authRoutes                    = require('../routes/auth');
const adminRoutes                   = require('../routes/admin');
const calendarRoutes                = require('../routes/calendar');
const appointmentRoutes             = require('../routes/appointments');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { errorHandler }              = require('../utils/errors');
const { addSSEClient, getSessionMetrics } = require('../services/whatsapp-client');
const { getPersistHealth, getSchemaVersion, countUsers } = require('../services/database');
const { requestMetrics, snapshot } = require('../utils/metrics');
const { SESSION_SECRET_SOURCE } = require('./auth');

function createApp() {
    const app = express();

    app.disable('x-powered-by');

    // ─── Reverse proxy awareness ────────────────────────────────
    // Off by default: with no proxy in front, req.ip is already the real
    // client, and blindly trusting X-Forwarded-For would let anyone spoof
    // their IP and dodge the login/signup rate limiters. Only turn this on
    // (TRUST_PROXY=1) when something you control — Caddy, nginx, Cloudflare —
    // actually sits in front of this process; otherwise every visitor behind
    // that proxy collapses into one IP and the rate limiters stop meaning
    // anything.
    if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
        app.set('trust proxy', 1);
    }

    // ─── HTTPS enforcement ──────────────────────────────────────
    // Only meaningful behind a proxy that terminates TLS and sets
    // X-Forwarded-Proto. Without this, a user who types the bare hostname
    // sends their session cookie over cleartext once before any redirect.
    if (process.env.FORCE_HTTPS === 'true') {
        app.use((req, res, next) => {
            if (req.secure || req.get('X-Forwarded-Proto') === 'https') return next();
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                return res.status(403).json({ success: false, error: 'HTTPS is required.' });
            }
            return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
        });
    }

    app.use(requestMetrics);

    // ─── Response compression ────────────────────────────────────
    // The dashboard bundle (app.js, chart.umd.min.js) and every JSON API
    // response benefit from this — chart.umd.min.js alone is ~200KB
    // uncompressed. Explicitly skips the QR/status SSE stream: compression
    // buffers output to fill its chunk size before flushing, which would
    // turn a real-time "here's your QR code" push into a delayed one.
    app.use(compression({
        filter: (req, res) => {
            if (req.path === '/api/qr-stream') return false;
            return compression.filter(req, res);
        }
    }));

    // ─── CORS & Cross-Origin Security ───────────────────────────
    // Allow only legitimate SaaS domains and localhost development.
    // Untrusted cross-origin requests are blocked to prevent data theft and unauthorized remote access.
    const defaultAllowedOrigins = [
        'https://workpilots.dpdns.org',
        'https://workpilot.co.in',
        'https://leadfinder.workpilot.co.in',
        'https://linkdinpilot.workpilot.co.in',
        'http://localhost:3000',
        'http://localhost:5000',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5000'
    ];
    const allowAllOrigins = (process.env.ALLOWED_ORIGINS || '').trim() === '*';
    const envOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s && s !== '*');
    const allowedOriginsList = Array.from(new Set([...defaultAllowedOrigins, ...envOrigins]));

    function isOriginAllowed(origin, req = null) {
        if (!origin) return true; // Same-origin, direct server-to-server, or native calls
        if (allowAllOrigins) return true;
        const trimmed = origin.trim().toLowerCase();
        if (allowedOriginsList.some(o => o.toLowerCase() === trimmed)) return true;
        try {
            const parsed = new URL(trimmed);
            const host = parsed.hostname.toLowerCase();
            // Same-origin check: if browser Origin host matches server's Host header
            if (req) {
                const reqHost = (req.get('host') || '').toLowerCase();
                const reqHostname = (req.hostname || '').toLowerCase();
                if (parsed.host.toLowerCase() === reqHost || host === reqHostname) return true;
            }
            if (host === 'workpilot.co.in' || host.endsWith('.workpilot.co.in')) return true;
            if (host === 'workpilots.dpdns.org') return true;
            if (host === 'localhost' || host === '127.0.0.1') return true;
            // Direct IP address access (IPv4)
            if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
        } catch (e) {
            return false;
        }
        return false;
    }

    app.use(cors({
        origin: (origin, callback) => {
            if (isOriginAllowed(origin)) return callback(null, true);
            try {
                const parsed = new URL(origin);
                if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname.toLowerCase())) {
                    return callback(null, true);
                }
            } catch (_) {}
            return callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
        maxAge: 86400
    }));

    // Strict Cross-Origin Enforcement Middleware for API endpoints:
    app.use('/api', (req, res, next) => {
        const origin = req.headers.origin;
        if (origin && !isOriginAllowed(origin, req)) {
            return res.status(403).json({
                success: false,
                error: 'Cross-origin request blocked: origin not allowed by CORS policy.'
            });
        }
        next();
    });

// Custom structured request logging with PII masking (replaces morgan)
    app.use(requestLogger);

    // 1MB is generous for JSON here (the largest legitimate body is a CSV
    // import, capped separately at 2MB of text). Express rejects anything
    // larger with a 413 before it is parsed, which is what keeps a 500MB body
    // from being buffered into memory.
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Nonce middleware (must run before security headers for CSP nonce) ───
    app.use(nonceMiddleware);

    // ─── Security headers ───────────────────────────────────────
      app.use((req, res, next) => {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          // CSP with per-request nonce — replaces 'unsafe-inline' for scripts/styles.
          // The nonce is generated per-request in nonceMiddleware and available as res.locals.nonce.
          const nonce = res.locals.nonce;
          res.setHeader('Content-Security-Policy', [
              "default-src 'self'",
              `script-src 'self' 'nonce-${nonce}'`,
              "script-src-attr 'none'",
              `style-src 'self' 'nonce-${nonce}'`,
              "img-src 'self' data:",       // data: is required: QR codes are data URLs
              "connect-src 'self'",
              "font-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'self'"
          ].join('; '));

          if (process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true') {
              res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
          }
          next();
      });

    // Authenticated API responses must never be cached — by the browser, or
    // by any proxy in between. Without this, a shared cache can serve one
    // tenant's dashboard JSON to another.
    app.use('/api', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        next();
    });

    // ─── Static assets — index.html is served explicitly below ──
    app.use(express.static(path.join(__dirname, '..', '..', 'public'), {
        index: false,
        // Long cache for assets, but they have no content hash in their
        // filenames, so a deploy would otherwise serve stale JS. etag +
        // must-revalidate keeps correctness while still avoiding re-downloads.
        maxAge: '1h',
        setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate')
    }));

    // ─── Health checks ──────────────────────────────────────────
    // Liveness: is the process running at all? Deliberately trivial and
    // dependency-free — a liveness probe that checks dependencies causes a
    // restart loop during a dependency outage, which is the opposite of what
    // you want.
app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // Readiness: can this process actually serve requests correctly? This
    // fails when the database cannot be written, because at that point the
    // app would accept work it silently cannot keep — a load balancer should
    // stop sending traffic here. Public, so it exposes booleans only, no
    // paths, versions, or error text.
    app.get('/ready', async (req, res) => {
        const persist = getPersistHealth();
        let dbReadable = false;
        try {
            await countUsers();
            dbReadable = true;
        } catch (e) {
            dbReadable = false;
        }

        const ready = dbReadable && persist.ok;
        // Only return a plain boolean — internal check details (databaseReadable,
        // databaseWritable) would let an unauthenticated caller infer the failure
        // mode and time attacks during degraded states. The 503 is sufficient for
        // a load balancer; a logged-in admin can see specifics via /api/health.
        res.status(ready ? 200 : 503).json({ ready });
    });

    // Detailed metrics are admin-only: session counts, memory, and failure
    // counters are exactly the reconnaissance an attacker wants, and event
    // loop lag tells them when the server is under strain.
    app.get('/api/metrics', requireAdmin, async (req, res) => {
        res.json({
            success: true,
            data: {
                ...snapshot(),
                whatsapp: getSessionMetrics(),
                database: { ...getPersistHealth(), schemaVersion: await getSchemaVersion() },
                sessionSecretSource: SESSION_SECRET_SOURCE
            }
        });
    });

    // ─── Auth routes (public) ───────────────────────────────────
    app.use('/api/auth', authRoutes);

    // ─── Admin routes (admin-only) ──────────────────────────────
    app.use('/api/admin', requireAdmin, adminRoutes);

    // ─── Per-account SSE stream for QR code / connection status ──
    // req.user.id, never a parameter: the stream is bound to the
    // authenticated account, so there is nothing for a client to tamper with
    // in order to read another tenant's QR code.
    app.get('/api/qr-stream', requireAuth, (req, res) => addSSEClient(req.user.id, req, res));

    // ─── Google Calendar (requires login; the OAuth callback is a normal
    //     top-level browser navigation back to our own origin, so the
    //     session cookie is present there too) ─────────────────────
    app.use('/api/calendar', requireAuth, calendarRoutes);

    // ─── Appointment booking (weekly hours, slot lookup, bookings) ──
    app.use('/api/appointments', requireAuth, appointmentRoutes);

    // ─── Everything else under /api requires a logged-in account ──
    app.use('/api', requireAuth, apiRoutes);

    // ─── Unmatched API routes get a JSON 404, not the HTML redirect below ──
    app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));

    // ─── Pages ──────────────────────────────────────────────────
    const page = (name) => (req, res) => {
        // For HTML files, inject CSP nonce into inline scripts/styles
        if (name.endsWith('.html')) {
            // __dirname is src/config, so project root is ../../
            const filePath = path.join(__dirname, '..', '..', 'public', name);
            fs.readFile(filePath, 'utf8', (err, content) => {
                if (err) return res.status(404).send('Not found');
                const nonce = res.locals.nonce || '';
                // Inject nonce into inline <script> and <style> tags
                const withNonce = content
                    .replace(/<script(\s[^>]*)?>/gi, `<script$1 nonce="${nonce}">`)
                    .replace(/<style(\s[^>]*)?>/gi, `<style$1 nonce="${nonce}">`);
                res.setHeader('Content-Type', 'text/html');
                res.send(withNonce);
            });
        } else {
            res.sendFile(path.join(__dirname, '..', '..', 'public', name));
        }
    };
    app.get('/', page('landing.html'));
    app.get(['/login', '/login.html'], page('login.html'));
    app.get(['/signup', '/signup.html'], page('signup.html'));
    // The dashboard shell is public HTML; every byte of data in it comes from
    // /api/* calls that enforce auth server-side. Client-side redirects here
    // are UX, not a security boundary.
    app.get(['/app', '/app.html', '/index.html'], page('index.html'));
    app.get(['/admin', '/admin.html'], requireAuth, (req, res, next) => {
        if (req.user.role !== 'admin') return res.redirect('/app');
        page('admin.html')(req, res, next);
    });

    // Anything else falls back to the landing page.
    app.use((req, res) => res.redirect('/'));

    // ─── Error handler (must be last) ───────────────────────────
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };








