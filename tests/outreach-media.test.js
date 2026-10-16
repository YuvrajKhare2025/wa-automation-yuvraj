'use strict';

const fs = require('fs');
const path = require('path');

// Mock database and client dependencies to isolate testing
jest.mock('../src/services/database', () => ({
    getUserById: jest.fn().mockResolvedValue({ id: 10, status: 'active', message_limit: 1000 }),
    getMonthlyOutgoingCount: jest.fn().mockResolvedValue(10),
    logMessage: jest.fn().mockResolvedValue({ id: 1 }),
    getContactByPhone: jest.fn().mockResolvedValue(null),
    upsertContact: jest.fn().mockResolvedValue({}),
    markContactOutreached: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/services/google-calendar', () => ({
    checkAvailabilityNow: jest.fn().mockResolvedValue({ busy: false }),
    logOutreachEvent: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/services/whatsapp-client', () => {
    const original = jest.requireActual('../src/services/whatsapp-client');
    return {
        ...original,
        sendTextMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'fake_txt_123' } }),
        sendMediaMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'fake_media_123' } })
    };
});

const {
    validateImageBuffer,
    saveOutreachImage,
    getOutreachImageAbsolutePath,
    deleteOutreachImage,
    getOwnerUserIdFromFilename,
    isSafeFilename,
    getMimeType,
    MAX_IMAGE_SIZE_BYTES
} = require('../src/services/outreach-storage');

const {
    startOutreachJob,
    getOutreachJob,
    cancelOutreachJob
} = require('../src/services/outreach');

const { sendTextMessage, sendMediaMessage } = require('../src/services/whatsapp-client');

describe('Outreach Media Attachment & Outreach Job Test Suite', () => {
    // 1x1 test image buffers with genuine magic bytes
    const samplePng = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82
    ]);

    const sampleJpg = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
        0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
        0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
        0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
        0xff, 0xd9
    ]);

    const sampleWebp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x20, 0x00, 0x00, 0x00]),
        Buffer.from('WEBPVP8 '),
        Buffer.from([0x14, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x00])
    ]);

    describe('1. Outreach Media Storage & Magic-Bytes Validation', () => {
        test('accepts valid PNG image by magic bytes', () => {
            const res = validateImageBuffer(samplePng);
            expect(res.ext).toBe('png');
            expect(res.mime).toBe('image/png');
        });

        test('accepts valid JPEG image by magic bytes', () => {
            const res = validateImageBuffer(sampleJpg);
            expect(res.ext).toBe('jpg');
            expect(res.mime).toBe('image/jpeg');
        });

        test('accepts valid WebP image by magic bytes', () => {
            const res = validateImageBuffer(sampleWebp);
            expect(res.ext).toBe('webp');
            expect(res.mime).toBe('image/webp');
        });

        test('rejects non-image scripts or HTML disguised as images', () => {
            const disguised = Buffer.from('<script>alert("hacked")</script>', 'utf8');
            expect(() => validateImageBuffer(disguised)).toThrow(/Invalid or unsupported image format/i);
        });

        test('rejects empty or corrupt buffers', () => {
            expect(() => validateImageBuffer(Buffer.alloc(0))).toThrow(/empty or invalid/i);
            expect(() => validateImageBuffer(Buffer.from([0x01, 0x02, 0x03]))).toThrow(/Invalid or unsupported/i);
        });

        test('rejects buffers exceeding MAX_IMAGE_SIZE_BYTES limit', () => {
            const oversized = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1024);
            samplePng.copy(oversized, 0, 0, samplePng.length);
            expect(() => validateImageBuffer(oversized)).toThrow(/size exceeds the maximum allowed limit/i);
        });

        test('getMimeType returns correct mime types', () => {
            expect(getMimeType('photo.jpg')).toBe('image/jpeg');
            expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
            expect(getMimeType('photo.png')).toBe('image/png');
            expect(getMimeType('photo.webp')).toBe('image/webp');
            expect(getMimeType('photo.pdf')).toBe('application/octet-stream');
        });
    });

    describe('2. Safe Filename, Storage, and Tenant Isolation', () => {
        test('isSafeFilename prevents path traversal and enforces convention', () => {
            expect(isSafeFilename('outreach_1_1729000000000_abcdef1234567890.png')).toBe(true);
            expect(isSafeFilename('outreach_42_1729000000000_1234567890abcdef.jpg')).toBe(true);
            expect(isSafeFilename('outreach_99_1729000000000_87654321fedcba09.webp')).toBe(true);

            expect(isSafeFilename('../../etc/passwd')).toBe(false);
            expect(isSafeFilename('..\\windows\\system32')).toBe(false);
            expect(isSafeFilename('prod_1_1729000000000_abcdef1234567890.png')).toBe(false);
            expect(isSafeFilename('random_image.png')).toBe(false);
        });

        test('getOwnerUserIdFromFilename extracts the tenant ID', () => {
            expect(getOwnerUserIdFromFilename('outreach_42_1729000000000_1234567890abcdef.jpg')).toBe(42);
            expect(getOwnerUserIdFromFilename('outreach_1_1729000000000_1234567890abcdef.png')).toBe(1);
            expect(getOwnerUserIdFromFilename('bad_file.png')).toBeNull();
        });

        test('saveOutreachImage persists file, and getOutreachImageAbsolutePath enforces tenant isolation', async () => {
            const saved = await saveOutreachImage(7, samplePng);
            expect(saved.mediaId).toMatch(/^outreach_7_\d+_[a-f0-9]{16}\.png$/);
            expect(saved.size).toBe(samplePng.length);

            // Access with correct tenant
            const authorizedPath = getOutreachImageAbsolutePath(saved.mediaId, 7);
            expect(authorizedPath).toBeTruthy();
            expect(fs.existsSync(authorizedPath)).toBe(true);

            // Cross-tenant access attempt (user 8 trying to access user 7's uploaded media)
            const unauthorizedPath = getOutreachImageAbsolutePath(saved.mediaId, 8);
            expect(unauthorizedPath).toBeNull();

            // Cross-tenant delete attempt
            const deleteByOther = await deleteOutreachImage(saved.mediaId, 8);
            expect(deleteByOther).toBe(false);
            expect(fs.existsSync(authorizedPath)).toBe(true);

            // Authorized delete
            const deleteByOwner = await deleteOutreachImage(saved.mediaId, 7);
            expect(deleteByOwner).toBe(true);
            expect(fs.existsSync(authorizedPath)).toBe(false);
        });
    });

    describe('3. Bulk Outreach Job Configuration & Modes', () => {
        let mediaUser11 = null;
        let mediaUser12 = null;

        beforeAll(async () => {
            const s11 = await saveOutreachImage(11, samplePng);
            mediaUser11 = s11.mediaId;

            const s12 = await saveOutreachImage(12, samplePng);
            mediaUser12 = s12.mediaId;
        });

        afterAll(async () => {
            if (mediaUser11) await deleteOutreachImage(mediaUser11, 11);
            if (mediaUser12) await deleteOutreachImage(mediaUser12, 12);
        });

        const testContacts = [
            { id: 101, name: 'Sahil Sharma', phone: '919876543210' },
            { id: 102, name: 'Alice Smith', phone: '919876543211' }
        ];

        test('rejects when both message and mediaId are missing', () => {
            expect(() => {
                startOutreachJob({ id: 10, role: 'user', status: 'active' }, testContacts, '', null);
            }).toThrow(/Please enter a message or attach an image/i);
        });

        test('rejects when mediaId does not exist or belongs to another user', () => {
            expect(() => {
                startOutreachJob({ id: 10, role: 'user', status: 'active' }, testContacts, 'Hello', 'outreach_999_1729000000000_1234567890abcdef.png');
            }).toThrow(/Attached media file not found or invalid/i);
        });

        test('Mode 1: Text-only outreach job starts successfully', () => {
            const user10 = { id: 10, role: 'user', status: 'active' };
            const job = startOutreachJob(user10, testContacts, 'Hi {{name}}, welcome to our platform!');
            expect(job.id).toBeTruthy();
            expect(job.userId).toBe(10);
            expect(job.mediaId).toBeNull();
            expect(job.total).toBe(2);
            expect(job.status).toBe('running');

            cancelOutreachJob(job.id, 10);
        });

        test('Mode 2: Image-only outreach job starts successfully without text', () => {
            const user11 = { id: 11, role: 'user', status: 'active' };
            const job = startOutreachJob(user11, testContacts, '', mediaUser11);
            expect(job.id).toBeTruthy();
            expect(job.userId).toBe(11);
            expect(job.mediaId).toBe(mediaUser11);
            expect(job.total).toBe(2);
            expect(job.status).toBe('running');

            cancelOutreachJob(job.id, 11);
        });

        test('Mode 3: Text + Image outreach job starts successfully with personalized caption', () => {
            const user12 = { id: 12, role: 'user', status: 'active' };
            const job = startOutreachJob(user12, testContacts, 'Check out our new catalog, {{name}}!', mediaUser12);
            expect(job.id).toBeTruthy();
            expect(job.userId).toBe(12);
            expect(job.mediaId).toBe(mediaUser12);
            expect(job.total).toBe(2);

            const retrieved = getOutreachJob(job.id, 12);
            expect(retrieved).toBeTruthy();
            expect(retrieved.id).toBe(job.id);

            // Cross-tenant job retrieval is blocked
            expect(getOutreachJob(job.id, 13)).toBeNull();

            cancelOutreachJob(job.id, 12);
        });
    });
});
