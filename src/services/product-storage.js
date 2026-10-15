/**
 * src/services/product-storage.js — Secure storage adapter for product catalogue images.
 *
 * Implements:
 *   - File signature (magic bytes) validation for JPEG, PNG, and WebP.
 *   - Strict file size enforcement (default 5MB, configurable via PRODUCT_IMAGE_MAX_SIZE_MB).
 *   - Cryptographically random, collision-free filename generation.
 *   - Path traversal prevention.
 *   - Safe cleanup of replaced or deleted product images.
 *   - Support for persistent filesystem storage (PERSIST_ROOT/data/product_images).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PRODUCT_UPLOADS_DIR } = require('../config/paths');
const { ValidationError } = require('../utils/validate');

const DEFAULT_MAX_SIZE_MB = 5;
const MAX_IMAGE_SIZE_BYTES = (parseInt(process.env.PRODUCT_IMAGE_MAX_SIZE_MB, 10) || DEFAULT_MAX_SIZE_MB) * 1024 * 1024;

const SAFE_FILENAME_REGEX = /^prod_\d+_\d+_[a-f0-9]{16}\.(jpg|jpeg|png|webp)$/i;

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
 * Ensures the uploads directory exists on disk.
 */
function ensureUploadsDir() {
    if (!fs.existsSync(PRODUCT_UPLOADS_DIR)) {
        fs.mkdirSync(PRODUCT_UPLOADS_DIR, { recursive: true, mode: 0o755 });
    }
}

/**
 * Validates and writes a product image buffer to persistent storage.
 * Returns the safe filename (e.g. prod_1_169738...abc.png).
 */
async function saveProductImage(userId, buffer) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
        throw new ValidationError('A valid user id is required to save a product image.');
    }

    const { ext } = validateImageBuffer(buffer);
    ensureUploadsDir();

    const randomTag = crypto.randomBytes(8).toString('hex');
    const filename = `prod_${uid}_${Date.now()}_${randomTag}.${ext}`;
    const destinationPath = path.join(PRODUCT_UPLOADS_DIR, filename);

    // Write file with restricted permissions (0o644)
    await fs.promises.writeFile(destinationPath, buffer, { mode: 0o644 });
    return filename;
}

/**
 * Checks if a filename is syntactically safe and belongs to the expected convention.
 */
function isSafeFilename(filename) {
    if (!filename || typeof filename !== 'string') return false;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
    return SAFE_FILENAME_REGEX.test(filename.trim());
}

/**
 * Resolves the absolute path of a product image if it exists.
 * Returns null if invalid or not found.
 */
function getProductImageAbsolutePath(filename) {
    if (!isSafeFilename(filename)) return null;

    const base = path.basename(filename.trim());
    const fullPath = path.join(PRODUCT_UPLOADS_DIR, base);

    try {
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) return fullPath;
        }
    } catch (_) {
        return null;
    }
    return null;
}

/**
 * Deletes a product image file from disk safely.
 * Does not throw if the file does not exist.
 */
async function deleteProductImage(filename) {
    if (!isSafeFilename(filename)) return false;

    const fullPath = path.join(PRODUCT_UPLOADS_DIR, path.basename(filename.trim()));
    try {
        if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
            return true;
        }
    } catch (e) {
        console.warn('⚠️ Could not delete product image file:', e.message);
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

/**
 * Ensures the product image exists on disk by restoring from database if missing.
 * Returns the absolute path if available on disk or successfully restored, else null.
 */
async function restoreProductImageIfMissing(filename) {
    if (!isSafeFilename(filename)) return null;

    const base = path.basename(filename.trim());
    const fullPath = path.join(PRODUCT_UPLOADS_DIR, base);

    try {
        if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size > 0) return fullPath;
        }
    } catch (_) {}

    // Attempt restoration from database image_data column
    try {
        const { queryGet } = require('./db-pool');
        const row = await queryGet(
            "SELECT image_data FROM products WHERE image_path = $1 AND image_data IS NOT NULL AND image_data != '' LIMIT 1",
            [base]
        );
        if (row && row.image_data) {
            ensureUploadsDir();
            const buffer = Buffer.from(row.image_data, 'base64');
            await fs.promises.writeFile(fullPath, buffer, { mode: 0o644 });
            console.log(` Restored product image on disk from database: ${base}`);
            return fullPath;
        }
    } catch (e) {
        console.warn('⚠️ Could not restore product image from database:', e.message);
    }
    return null;
}

module.exports = {
    validateImageBuffer,
    saveProductImage,
    isSafeFilename,
    getProductImageAbsolutePath,
    getImageFilePath: getProductImageAbsolutePath,
    restoreProductImageIfMissing,
    deleteProductImage,
    deleteImageFile: deleteProductImage,
    getMimeType,
    MAX_IMAGE_SIZE_BYTES,
    PRODUCT_UPLOADS_DIR
};
