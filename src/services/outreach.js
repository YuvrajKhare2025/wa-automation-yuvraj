/**
 * outreach.js — bulk "send this message to N contacts" jobs.
 *
 * Why this isn't just a loop inside the route handler: sending to, say, 150
 * contacts with a human-like delay between each takes on the order of
 * 10-20 minutes. Doing that inside a single request/response cycle would
 * hold the connection open that whole time — the browser, any reverse
 * proxy in front of this (Caddy in production), and Render's own proxy in
 * the free-tier test earlier in this project would all time it out well
 * before it finished. So the route kicks the job off in the background and
 * returns immediately with a job id; the frontend polls for progress.
 *
 * The throttle and hard cap below aren't just politeness — WhatsApp's own
 * terms prohibit bulk/automated messaging, and their detection systems are
 * known to flag or ban numbers for sending many messages to many distinct
 * contacts in a short window, which is exactly the pattern an "outreach"
 * feature produces by definition. This can reduce how obviously
 * bot-shaped the traffic looks; it cannot make bulk outreach risk-free.
 * That risk is real and belongs in the product's UI, not just this
 * comment — see the warning copy wired up on the frontend.
 *
 * Job state is in memory and deliberately does not survive a restart. What
 * *does* survive is the message log: every successful send is recorded in
 * the database as it happens, so a job interrupted halfway leaves an
 * accurate record of what was actually sent rather than a job that looks
 * resumable and re-sends to people who already received it.
 */

const { sendTextMessage, sendMediaMessage, MessageMedia } = require('./whatsapp-client');
const {
    logMessage, getContactByPhone, upsertContact, getMonthlyOutgoingCount,
    markContactOutreached, getUserById
} = require('./database');
const { tryNormalizePhone } = require('../utils/validate');
const { checkAvailabilityNow, logOutreachEvent } = require('./google-calendar');
const { getOutreachImageAbsolutePath } = require('./outreach-storage');

const MAX_RECIPIENTS_PER_JOB = parseInt(process.env.MAX_OUTREACH_RECIPIENTS_PER_JOB, 10) || 25;
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 9000;
// Global and per-user limits for concurrent outreach jobs across the platform.
const MAX_CONCURRENT_OUTREACH_JOBS = parseInt(process.env.MAX_CONCURRENT_OUTREACH_JOBS, 10) || 5;
const MAX_CONCURRENT_JOBS_PER_USER = parseInt(process.env.MAX_CONCURRENT_OUTREACH_PER_USER, 10) || 1;
// Finished jobs are kept only long enough for the UI to read the final
// result, then dropped. Without this the map grows for the life of the
// process — a slow leak proportional to how much the feature is used.
const JOB_RETENTION_MS = 30 * 60 * 1000;

const jobs = new Map(); // jobId -> job state
let nextJobId = 1;

const _sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.status !== 'running' && job.finishedAt && now - job.finishedAt > JOB_RETENTION_MS) {
            jobs.delete(id);
        }
    }
}, 5 * 60 * 1000);
_sweep.unref?.();

function randomDelay() {
    return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function renderTemplate(template, contact) {
    if (!template) return '';
    return template.replace(/\{\{\s*name\s*\}\}/gi, contact.name || 'there');
}

function countRunningJobsForUser(userId) {
    let n = 0;
    for (const job of jobs.values()) {
        if (job.userId === userId && job.status === 'running') n++;
    }
    return n;
}

function countTotalRunningJobs() {
    let n = 0;
    for (const job of jobs.values()) {
        if (job.status === 'running') n++;
    }
    return n;
}

/**
 * Starts a bulk-send job for one user against a list of contacts. Returns
 * the job immediately (status 'running', nothing sent yet) — the actual
 * sending happens afterward, off the caller's stack. Poll
 * getOutreachJob(jobId) for progress.
 */
function startOutreachJob(user, contacts, messageTemplate = '', mediaId = null) {
    const hasMessage = typeof messageTemplate === 'string' && messageTemplate.trim().length > 0;
    const hasMedia = !!mediaId;
    if (!hasMessage && !hasMedia) {
        const err = new Error('Please enter a message or attach an image.');
        err.status = 400;
        throw err;
    }

    if (hasMedia) {
        const filePath = getOutreachImageAbsolutePath(mediaId, user.id);
        if (!filePath) {
            const err = new Error('Attached media file not found or invalid.');
            err.status = 400;
            throw err;
        }
    }

    if (contacts.length > MAX_RECIPIENTS_PER_JOB) {
        const err = new Error(`Outreach is capped at ${MAX_RECIPIENTS_PER_JOB} recipients per send — you selected ${contacts.length}. Split into smaller batches.`);
        err.status = 400;
        throw err;
    }
    if (countTotalRunningJobs() >= MAX_CONCURRENT_OUTREACH_JOBS) {
        const err = new Error('The server is currently at capacity for concurrent outreach campaigns. Please wait a few moments.');
        err.status = 503;
        throw err;
    }
    if (countRunningJobsForUser(user.id) >= MAX_CONCURRENT_JOBS_PER_USER) {
        const err = new Error('You already have an outreach send in progress. Wait for it to finish, or cancel it first.');
        err.status = 409;
        throw err;
    }

    const jobId = `${user.id}-${nextJobId++}`;
    const job = {
        id: jobId,
        userId: user.id,
        mediaId: mediaId || null,
        total: contacts.length,
        sent: 0,
        failed: 0,
        skipped: 0,
        status: 'running', // running | done | cancelled
        cancelRequested: false,
        results: [], // { phone, name, status: 'sent'|'failed'|'skipped', reason? }
        startedAt: Date.now()
    };
    jobs.set(jobId, job);

    // Deliberately not awaited. The rejection handler matters: an unhandled
    // rejection here would, given server.js's process.exit(1) policy, take
    // down every tenant because one send loop threw.
    runJob(job, user, contacts, messageTemplate, mediaId).catch(err => {
        job.status = 'done';
        job.finishedAt = Date.now();
        job.error = 'The send stopped unexpectedly. Some messages may not have been sent.';
        console.error(`❌ Outreach job ${job.id} crashed:`, err.message);
    });
    return job;
}

async function runJob(job, user, contacts, messageTemplate = '', mediaId = null) {
    let preloadedMedia = null;
    if (mediaId) {
        try {
            const filePath = getOutreachImageAbsolutePath(mediaId, user.id);
            if (!filePath) {
                throw new Error('Attached image could not be found on disk');
            }
            preloadedMedia = MessageMedia.fromFilePath(filePath);
        } catch (err) {
            job.status = 'failed';
            job.finishedAt = Date.now();
            job.error = `Failed to prepare attached media: ${err.message}`;
            console.error(`❌ Outreach job ${job.id} media preload failed:`, err.message);
            return;
        }
    }

    for (const contact of contacts) {
        if (job.cancelRequested) {
            const remaining = job.total - job.sent - job.failed - job.skipped;
            if (remaining > 0) {
                job.skipped += remaining;
                job.results.push({ status: 'skipped', reason: `Cancelled — ${remaining} recipient(s) not contacted` });
            }
            job.status = 'cancelled';
            job.finishedAt = Date.now();
            return;
        }

        // Re-read the account each iteration. A job can run for 20 minutes,
        // during which an admin may suspend the account — continuing to send
        // on behalf of a suspended tenant is exactly what suspension is
        // supposed to stop.
        const fresh = await getUserById(user.id);
        if (!fresh || fresh.status !== 'active') {
            const remaining = job.total - job.sent - job.failed - job.skipped;
            job.skipped += remaining;
            job.results.push({ status: 'skipped', reason: 'Remaining sends stopped: this account is no longer active' });
            job.status = 'cancelled';
            job.finishedAt = Date.now();
            return;
        }

        // Plan message-limit check, re-evaluated per send since it can change
        // mid-job — same rule /messages/send enforces.
        if (fresh.message_limit && (await getMonthlyOutgoingCount(fresh.id)) >= fresh.message_limit) {
            const remaining = job.total - job.sent - job.failed - job.skipped;
            job.skipped += remaining;
            job.results.push({
                phone: contact.phone, name: contact.name,
                status: 'skipped', reason: 'Remaining sends skipped: monthly message limit reached'
            });
            break;
        }

        // Optional per-user setting (routes/calendar.js): skip this contact
        // rather than send while the owner's own Google Calendar shows them
        // busy right now. checkAvailabilityNow fails open (busy: false) on
        // any error or if the feature isn't connected, so a Calendar API
        // hiccup can never silently stall a whole outreach job.
        const availability = await checkAvailabilityNow(fresh.id);
        if (availability.busy) {
            job.results.push({
                phone: contact.phone, name: contact.name,
                status: 'skipped', reason: 'Skipped — your Google Calendar shows you as busy right now'
            });
            job.skipped++;
            if (contact !== contacts[contacts.length - 1]) {
                await new Promise(resolve => setTimeout(resolve, randomDelay()));
            }
            continue;
        }

        // The contact rows come from our own database, but they may predate
        // phone validation (see migration 4), so normalise rather than trust.
        const phone = tryNormalizePhone(contact.phone);
        if (!phone) {
            job.failed++;
            job.results.push({ phone: contact.phone, name: contact.name, status: 'failed', reason: 'Not a valid phone number' });
            continue;
        }

        const personalized = messageTemplate ? renderTemplate(messageTemplate, contact) : '';
        try {
            let result;
            if (preloadedMedia) {
                result = await sendMediaMessage(fresh.id, phone, preloadedMedia, personalized);
                await logMessage(fresh.id, {
                    waMessageId: result?.id?._serialized || result?.messageId || null,
                    phone,
                    contactName: contact.name || '',
                    direction: 'outgoing',
                    messageType: 'image',
                    body: personalized || '[Image]',
                    status: 'sent'
                });
            } else {
                result = await sendTextMessage(fresh.id, phone, personalized);
                await logMessage(fresh.id, {
                    waMessageId: result?.id?._serialized || result?.messageId || null,
                    phone,
                    contactName: contact.name || '',
                    direction: 'outgoing',
                    messageType: 'text',
                    body: personalized,
                    status: 'sent'
                });
            }
            if (!(await getContactByPhone(fresh.id, phone))) await upsertContact(fresh.id, phone, contact.name);
            await markContactOutreached(fresh.id, phone);
            job.sent++;
            job.results.push({ phone, name: contact.name, status: 'sent' });
            // Best-effort, deliberately not awaited before continuing: this
            // is a courtesy record, not something the send itself should
            // wait on, and logOutreachEvent already swallows its own errors.
            logOutreachEvent(fresh.id, { phone, name: contact.name, message: personalized || '[Image]' }).catch?.(() => {});
        } catch (err) {
            job.failed++;
            // Don't echo raw internals into a response body the browser shows.
            job.results.push({
                phone, name: contact.name, status: 'failed',
                reason: /not connected/i.test(err.message) ? 'WhatsApp disconnected' : (err.message || 'Send failed')
            });
            // A disconnected client will fail for every remaining recipient,
            // several seconds apart, for the rest of the job. Stop instead.
            if (/not connected/i.test(err.message)) {
                const remaining = job.total - job.sent - job.failed - job.skipped;
                if (remaining > 0) {
                    job.skipped += remaining;
                    job.results.push({ status: 'skipped', reason: 'Stopped: WhatsApp is disconnected' });
                }
                break;
            }
        }

        // Skip the delay after the very last send — nothing left to wait for.
        if (contact !== contacts[contacts.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, randomDelay()));
        }
    }
    if (job.status === 'running') job.status = 'done';
    job.finishedAt = Date.now();
}

/**
 * Returns a job only to the account that owns it.
 *
 * The ownership check is the authorization boundary for this resource: job
 * ids are short and sequential, so without it any tenant could read another
 * tenant's recipient phone numbers by guessing.
 */
function getOutreachJob(jobId, userId) {
    const job = jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return job;
}

function cancelOutreachJob(jobId, userId) {
    const job = getOutreachJob(jobId, userId);
    if (!job || job.status !== 'running') return false;
    job.cancelRequested = true;
    return true;
}

/** Test/shutdown helper: request cancellation of everything in flight. */
function cancelAllOutreachJobs() {
    let n = 0;
    for (const job of jobs.values()) {
        if (job.status === 'running') { job.cancelRequested = true; n++; }
    }
    return n;
}

module.exports = {
    startOutreachJob,
    getOutreachJob,
    cancelOutreachJob,
    cancelAllOutreachJobs,
    countRunningJobsForUser,
    MAX_RECIPIENTS_PER_JOB,
    MIN_DELAY_MS,
    MAX_DELAY_MS
};




