/**
 * src/services/outreach-storage.js — Secure storage adapter for outreach media attachments.
 *
 * Implements:
 *   - File signature (magic bytes) validation for JPEG, PNG, and WebP.
 *   - Strict file size enforcement (default 5MB, configurable via OUTREACH_IMAGE_MAX_SIZE_MB).
 *   - Cryptographically random, collision-free filename generation.
 *   - Tenant isolation: filenames encode userId; accesses verify matching tenant.
 *   - Path traversal prevention.
 *   - Safe cleanup / removal of uploaded outreach media files.
 *   - Persistent filesystem storage in OUTREACH_UPLOADS_DIR.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OUTREACH_UPLOADS_DIR } = require('../config/paths');
const { ValidationError } = require('../utils/validate');

const DEFAULT_MAX_SIZE_MB = 5;
const MAX_IMAGE_SIZE_BYTES = (parseInt(process.env.OUTREACH_IMAGE_MAX_SIZE_MB, 10) || DEFAULT_MAX_SIZE_MB) * 1024 * 1024;

const SAFE_FILENAME_REGEX = /^outreach_(\d+)_\d+_[a-f0-9]{16}\.(jpg|jpeg|png|webp)$/i;

/**
 * Validates that the buffer contains legitimate image data by inspecting magic bytes.
 * Rejects disguised executables, scripts, HTML, or corrupted files.
 */
function validateImageBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new ValidationError('Uploaded file is empty or invalid.', 'image');
    }

    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
        const mb = (MAX_IMAGE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
        throw new ValidationError(`Image size exceeds the maximum allowed limit of ${mb} MB.`, 'image');
    }

    // 1. JPEG: FF D8 FF
    if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { ext: 'jpg', mime: 'image/jpeg' };
    }

    // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
    ) {
        return { ext: 'png', mime: 'image/png' };
    }

    // 3. WebP: RIFF ... WEBP
    if (
        buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
        return { ext: 'webp', mime: 'image/webp' };
    }

    throw new ValidationError(
        'Invalid or unsupported image format. Please upload a genuine JPEG, PNG, or WebP image.',
        'image'
    );
}

/**
 * Ensures the outreach uploads directory exists on disk.
 */
function ensureUploadsDir() {
    if (!fs.existsSync(OUTREACH_UPLOADS_DIR)) {
        fs.mkdirSync(OUTREACH_UPLOADS_DIR, { recursive: true, mode: 0o755 });
    }
}

/**
 * Checks if a filename conforms to the strict safe regex.
 */
function isSafeFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
    return SAFE_FILENAME_REGEX.test(filename.trim());
}

/**
 * Extracts userId from the safe filename, or null if invalid.
 */
function getOwnerUserIdFromFilename(filename) {
    if (!isSafeFilename(filename)) return null;
    const match = filename.trim().match(SAFE_FILENAME_REGEX);
    return match ? Number(match[1]) : null;
}

/**
 * Validates and writes an outreach image buffer to persistent storage.
 * Returns metadata including mediaId and safe filename.
 */
async function saveOutreachImage(userId, buffer) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
        throw new ValidationError('A valid user id is required to save outreach media.');
    }

    const { ext, mime } = validateImageBuffer(buffer);
    ensureUploadsDir();

    const randomTag = crypto.randomBytes(8).toString('hex');
    const filename = `outreach_${uid}_${Date.now()}_${randomTag}.${ext}`;
    const destinationPath = path.join(OUTREACH_UPLOADS_DIR, filename);

    await fs.promises.writeFile(destinationPath, buffer, { mode: 0o644 });

    return {
        mediaId: filename,
        filename,
        size: buffer.length,
        ext,
        mime
    };
}

/**
 * Resolves the absolute path of an outreach image if it exists and belongs to userId (if specified).
 * Returns null if invalid, not found, or cross-tenant access is attempted.
 */
function getOutreachImageAbsolutePath(filename, expectedUserId = null) {
    if (!isSafeFilename(filename)) return null;

    if (expectedUserId !== null && expectedUserId !== undefined) {
        const ownerId = getOwnerUserIdFromFilename(filename);
        if (ownerId !== Number(expectedUserId)) {
            return null; // Tenant isolation violation
        }
    }

    const base = path.basename(filename.trim());
    const fullPath = path.join(OUTREACH_UPLOADS_DIR, base);

    try {
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size > 0) return fullPath;
        }
    } catch (_) {
        return null;
    }
    return null;
}

/**
 * Deletes an outreach image safely from disk if it exists and belongs to the specified userId.
 */
async function deleteOutreachImage(filename, expectedUserId = null) {
    if (!isSafeFilename(filename)) return false;

    if (expectedUserId !== null && expectedUserId !== undefined) {
        const ownerId = getOwnerUserIdFromFilename(filename);
        if (ownerId !== Number(expectedUserId)) {
            return false;
        }
    }

    const fullPath = path.join(OUTREACH_UPLOADS_DIR, path.basename(filename.trim()));
    try {
        if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
            return true;
        }
    } catch (e) {
        console.warn('⚠️ Could not delete outreach media file:', e.message);
    }
    return false;
}

/**
 * Extracts MIME type from safe filename.
 */
function getMimeType(filename) {
    const ext = path.extname(filename || '').toLowerCase().replace('.', '');
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    return 'application/octet-stream';
}

module.exports = {
    validateImageBuffer,
    saveOutreachImage,
    isSafeFilename,
    getOwnerUserIdFromFilename,
    getOutreachImageAbsolutePath,
    deleteOutreachImage,
    getMimeType,
    MAX_IMAGE_SIZE_BYTES,
    OUTREACH_UPLOADS_DIR
};
