/**
 * src/services/db-pool.js — PostgreSQL connection pool and query abstraction layer.
 *
 * Implements:
 *   - Bounded reusable connection pool via node-postgres (pg).
 *   - Parameter placeholder rewriting (? -> $1, $2, ...).
 *   - BigInt / Numeric parsing to preserve JS integer/float contracts.
 *   - Transaction helpers guaranteeing client release on success/failure.
 *   - Connection acquisition and statement execution timeouts.
 *   - Sanitized database error logging.
 *   - Graceful pool shutdown.
 */

const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const txStorage = new AsyncLocalStorage();

// Ensure BigInt values do not break JSON responses (res.json / JSON.stringify)
if (!BigInt.prototype.toJSON) {
    BigInt.prototype.toJSON = function () {
        const num = Number(this);
        return (num >= Number.MIN_SAFE_INTEGER && num <= Number.MAX_SAFE_INTEGER) ? num : this.toString();
    };
}

// ─── Type Parsers ────────────────────────────────────────────
// In node-postgres, int8 (type 20) and numeric (type 1700) are returned as
// strings by default to prevent precision loss. Our API contracts, tests,
// and arithmetic logic expect JavaScript Numbers for counts and values.
// Safe within JS Number.MAX_SAFE_INTEGER (~9 quadrillion).
// Outside safe integer range, return as BigInt or string to prevent silent precision loss.
types.setTypeParser(20, (val) => {
    if (val === null) return null;
    const num = Number(val);
    if (num >= Number.MIN_SAFE_INTEGER && num <= Number.MAX_SAFE_INTEGER) {
        return num;
    }
    try {
        return BigInt(val);
    } catch (_) {
        return val;
    }
});
types.setTypeParser(1700, (val) => {
    if (val === null) return null;
    const num = parseFloat(val);
    if (!Number.isFinite(num)) return val;
    // Check if converting to JavaScript Number loses precision.
    // JavaScript Numbers (IEEE 754 float64) have 53 bits of precision (~15-17 significant decimal digits).
    // Extract significant digits from val:
    const significantDigits = String(val).replace(/^-/, '').replace('.', '').replace(/^0+/, '');
    if (significantDigits.length > 15) {
        // High precision decimal that cannot be represented accurately as JS float:
        // preserve as raw string to prevent silent precision loss.
        return val;
    }
    return num;
});

let pool = null;
let isShuttingDown = false;

// Persistence health tracker to mirror previous health/ready interface
const persistHealth = {
    ok: true,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    totalFailures: 0
};

/**
 * Validates and normalizes database configuration from environment variables.
 * Refuses to start with ambiguous or invalid credentials in production.
 */
function getPoolConfig() {
    const isProd = process.env.NODE_ENV === 'production';
    const connectionString = (process.env.DATABASE_URL || '').trim();

    const maxConnections = parseInt(process.env.PGMAX_CONNECTIONS || process.env.DB_POOL_MAX || '20', 10);
    const connectionTimeoutMillis = parseInt(process.env.PGCONNECT_TIMEOUT_MS || process.env.DB_CONN_TIMEOUT_MS || '15000', 10);
    const idleTimeoutMillis = parseInt(process.env.PGIDLE_TIMEOUT_MS || process.env.DB_POOL_IDLE_TIMEOUT_MS || '30000', 10);
    const statementTimeout = parseInt(process.env.PGSTATEMENT_TIMEOUT_MS || process.env.DB_STATEMENT_TIMEOUT_MS || '15000', 10);
    const queryTimeout = parseInt(process.env.PGQUERY_TIMEOUT_MS || process.env.DB_QUERY_TIMEOUT_MS || '15000', 10);

    // Timeout Hierarchy:
    // 1. connectionTimeoutMillis: Client-side timeout for acquiring an idle client or establishing a new socket.
    // 2. query_timeout: Client-side timeout (in Node.js) for waiting on query results. If the remote database
    //    freezes (e.g., container pause, network drop), node-postgres aborts the query and destroys the socket.
    // 3. statement_timeout: Server-side timeout enforced by PostgreSQL engine for running queries.
    const config = {
        max: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 20,
        connectionTimeoutMillis,
        idleTimeoutMillis,
        statement_timeout: statementTimeout,
        query_timeout: queryTimeout
    };

    // Determine TLS settings
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    let ssl = false;
    if (sslMode === 'require' || sslMode === 'verify-full' || (isProd && sslMode !== 'disable')) {
        ssl = {
            rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false'
        };
    }

    if (connectionString) {
        config.connectionString = connectionString;
        if (ssl && !connectionString.includes('sslmode=disable')) {
            config.ssl = ssl;
        }
        return config;
    }

    // Discrete parameters
    const host = process.env.PGHOST || process.env.DB_HOST || 'localhost';
    const port = parseInt(process.env.PGPORT || process.env.DB_PORT || '5432', 10);
    const user = process.env.PGUSER || process.env.DB_USER || 'postgres';
    const password = process.env.PGPASSWORD || process.env.DB_PASSWORD || '';
    const database = process.env.PGDATABASE || process.env.DB_NAME || 'whatsapp_automation';

    if (isProd && (!process.env.DATABASE_URL && !process.env.PGPASSWORD && !process.env.DB_PASSWORD)) {
        console.warn('⚠️  [db-pool] Running in production with an empty database password is not recommended.');
    }

    config.host = host;
    config.port = port;
    config.user = user;
    config.password = password;
    config.database = database;
    if (ssl) {
        config.ssl = ssl;
    }

    return config;
}

/**
 * Initializes the PostgreSQL connection pool.
 */
function initPool() {
    if (pool) return pool;

    const config = getPoolConfig();
    pool = new Pool(config);
    isShuttingDown = false;

    pool.on('error', (err) => {
        persistHealth.ok = false;
        persistHealth.consecutiveFailures++;
        persistHealth.totalFailures++;
        persistHealth.lastError = sanitizeErrorMessage(err.message);
        persistHealth.lastErrorAt = new Date().toISOString();
        console.error('❌ [db-pool] Unexpected error on idle PostgreSQL client:', persistHealth.lastError);
    });

    return pool;
}

/**
 * Returns the active pool instance, initializing if needed.
 */
function getPool() {
    if (!pool && !isShuttingDown) {
        return initPool();
    }
    return pool;
}

/**
 * Sanitizes error messages by redacting connection strings, passwords, or hashes.
 */
function sanitizeErrorMessage(msg) {
    if (!msg) return '';
    return String(msg)
        .replace(/postgres(ql)?:\/\/[^@]+@/gi, 'postgres://[REDACTED]@')
        .replace(/password\s*=\s*['"][^'"]+['"]/gi, 'password=[REDACTED]')
        .replace(/\$2[aby]\$\d+\$[./A-Za-z0-9]{53}/g, '[REDACTED_HASH]');
}

/**
 * Converts SQLite-style positional `?` placeholders into PostgreSQL `$1, $2, ...`
 * Robust state machine parser handling:
 *   - Single-quoted string literals with '' escapes
 *   - Double-quoted identifiers with "" escapes
 *   - Single-line SQL comments (-- ...)
 *   - Multi-line block comments (/* ... *\/)
 *   - PostgreSQL dollar-quoted strings ($$ ... $$ or $tag$ ... $tag$)
 *   - PostgreSQL operators containing ? (such as JSONB ?, ?|, ?& and escaped ??)
 */
function convertPlaceholders(sql) {
    let paramIndex = 1;
    let out = '';
    const len = sql.length;
    let i = 0;

    while (i < len) {
        const char = sql[i];
        const nextChar = i + 1 < len ? sql[i + 1] : '';

        // 1. Single-quoted string literal: '...'
        if (char === "'") {
            out += char;
            i++;
            while (i < len) {
                if (sql[i] === "'") {
                    out += "'";
                    if (i + 1 < len && sql[i + 1] === "'") {
                        // Escaped single quote ''
                        out += "'";
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                out += sql[i];
                i++;
            }
            continue;
        }

        // 2. Double-quoted identifier: "..."
        if (char === '"') {
            out += char;
            i++;
            while (i < len) {
                if (sql[i] === '"') {
                    out += '"';
                    if (i + 1 < len && sql[i + 1] === '"') {
                        // Escaped double quote ""
                        out += '"';
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                out += sql[i];
                i++;
            }
            continue;
        }

        // 3. Single-line comment: -- ...
        if (char === '-' && nextChar === '-') {
            while (i < len && sql[i] !== '\n') {
                out += sql[i];
                i++;
            }
            continue;
        }

        // 4. Block comment: /* ... */
        if (char === '/' && nextChar === '*') {
            out += '/*';
            i += 2;
            while (i < len) {
                if (sql[i] === '*' && i + 1 < len && sql[i + 1] === '/') {
                    out += '*/';
                    i += 2;
                    break;
                }
                out += sql[i];
                i++;
            }
            continue;
        }

        // 5. Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$
        if (char === '$') {
            const tagMatch = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
            if (tagMatch) {
                const fullTag = tagMatch[0];
                out += fullTag;
                i += fullTag.length;
                const closeIdx = sql.indexOf(fullTag, i);
                if (closeIdx !== -1) {
                    out += sql.slice(i, closeIdx + fullTag.length);
                    i = closeIdx + fullTag.length;
                } else {
                    out += sql.slice(i);
                    i = len;
                }
                continue;
            }
        }

        // 6. PostgreSQL operators containing ?:
        //    ?? (escaped question mark literal / operator)
        //    ?| (JSONB any key exists operator)
        //    ?& (JSONB all keys exist operator)
        if (char === '?') {
            if (nextChar === '?') {
                // Escaped question mark: output literal ?
                out += '?';
                i += 2;
                continue;
            }
            if (nextChar === '|' || nextChar === '&') {
                // JSONB operator: keep as is
                out += char + nextChar;
                i += 2;
                continue;
            }

            // Positional parameter placeholder
            out += `$${paramIndex++}`;
            i++;
            continue;
        }

        out += char;
        i++;
    }

    return out;
}

/**
 * Normalizes query input: accepts either ? or $1 placeholders, returns converted SQL.
 */
function normalizeSql(sql) {
    if (sql.includes('?')) {
        return convertPlaceholders(sql);
    }
    return sql;
}

/**
 * Executes a query using a client or the pool.
 * Records persist health metrics on success/failure.
 */
async function query(sql, params = [], client = null) {
    const activeClient = client || txStorage.getStore();
    const executor = activeClient || getPool();
    if (!executor) {
        const err = new Error('Database pool is not available or has been shut down.');
        err.status = 503;
        err.code = 'DB_UNAVAILABLE';
        throw err;
    }

    const normalizedSql = normalizeSql(sql);

    try {
        const res = await executor.query(normalizedSql, params);
        persistHealth.ok = true;
        persistHealth.consecutiveFailures = 0;
        persistHealth.lastSuccessAt = new Date().toISOString();
        persistHealth.lastError = null;
        return res;
    } catch (err) {
        persistHealth.ok = false;
        persistHealth.consecutiveFailures++;
        persistHealth.totalFailures++;
        persistHealth.lastError = sanitizeErrorMessage(err.message);
        persistHealth.lastErrorAt = new Date().toISOString();

        // Attach sanitized message
        err.sanitizedMessage = persistHealth.lastError;
        throw err;
    }
}

/**
 * Run a SELECT query and return all rows as an array.
 */
async function queryAll(sql, params = [], client = null) {
    const res = await query(sql, params, client);
    return res.rows;
}

/**
 * Run a SELECT query and return the first matching row (or null).
 */
async function queryGet(sql, params = [], client = null) {
    const rows = await queryAll(sql, params, client);
    return rows[0] || null;
}

/**
 * Run an INSERT / UPDATE / DELETE query, returning { lastId, changes, rows }.
 */
async function runSql(sql, params = [], client = null) {
    const res = await query(sql, params, client);
    const lastId = res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : 0;
    return {
        lastId,
        changes: res.rowCount || 0,
        rows: res.rows || []
    };
}

/**
 * Executes `fn(txClient)` inside a PostgreSQL transaction.
 * Automatically checks out a client, issues BEGIN, executes callback,
 * runs COMMIT on success, ROLLBACK on error, and releases client back to pool.
 */
async function transaction(fn) {
    const p = getPool();
    if (!p) {
        const err = new Error('Database pool is not available.');
        err.status = 503;
        throw err;
    }

    const client = await p.connect();
    try {
        await client.query('BEGIN');

        // Create transaction-bound helper wrappers
        const txHelper = {
            query: (sql, params) => query(sql, params, client),
            queryAll: (sql, params) => queryAll(sql, params, client),
            queryGet: (sql, params) => queryGet(sql, params, client),
            runSql: (sql, params) => runSql(sql, params, client),
            client
        };

        const result = await txStorage.run(client, () => fn(txHelper));
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rbErr) {
            console.warn('⚠️ [db-pool] Error during ROLLBACK:', sanitizeErrorMessage(rbErr.message));
        }
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Persistence health check to satisfy /ready and /health endpoints.
 */
function getPersistHealth() {
    const p = getPool();
    const poolStats = p ? {
        total: p.totalCount || 0,
        idle: p.idleCount || 0,
        waiting: p.waitingCount || 0
    } : { total: 0, idle: 0, waiting: 0 };

    return {
        ...persistHealth,
        pool: poolStats
    };
}

/**
 * Throws 503 if database writes are currently failing.
 */
function assertPersistable() {
    if (!persistHealth.ok) {
        const err = new Error(
            'The database is currently unreachable or rejecting writes. ' +
            'An administrator has been alerted — please retry shortly.'
        );
        err.status = 503;
        err.code = 'DB_PERSIST_FAILED';
        throw err;
    }
}

/**
 * Gracefully shuts down the connection pool.
 */
async function closePool() {
    isShuttingDown = true;
    if (pool) {
        const activePool = pool;
        pool = null;
        try {
            await activePool.end();
            console.log('   ✔ PostgreSQL connection pool closed');
        } catch (err) {
            console.warn('   ⚠️ Error closing PostgreSQL pool:', sanitizeErrorMessage(err.message));
        }
    }
}

module.exports = {
    initPool,
    getPool,
    query,
    queryAll,
    queryGet,
    runSql,
    transaction,
    normalizeSql,
    convertPlaceholders,
    getPersistHealth,
    assertPersistable,
    closePool,
    sanitizeErrorMessage
};
