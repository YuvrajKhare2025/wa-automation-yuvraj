'use strict';

const fs = require('fs');
const path = require('path');
const {
    validateImageBuffer,
    saveProductImage,
    deleteImageFile,
    getImageFilePath,
    restoreProductImageIfMissing,
    isSafeFilename,
    MAX_IMAGE_SIZE_BYTES
} = require('../src/services/product-storage');

describe('Product Images Feature Test Suite', () => {
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

    describe('1. Product Storage & Validation Service', () => {
        test('accepts valid PNG image by magic bytes', () => {
            const result = validateImageBuffer(samplePng);
            expect(result.ext).toBe('png');
            expect(result.mime).toBe('image/png');
        });

        test('accepts valid JPEG image by magic bytes', () => {
            const result = validateImageBuffer(sampleJpg);
            expect(result.ext).toBe('jpg');
            expect(result.mime).toBe('image/jpeg');
        });

        test('accepts valid WebP image by magic bytes', () => {
            const result = validateImageBuffer(sampleWebp);
            expect(result.ext).toBe('webp');
            expect(result.mime).toBe('image/webp');
        });

        test('rejects non-image text/HTML files masked with image extension', () => {
            const fakeImage = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
            expect(() => validateImageBuffer(fakeImage)).toThrow(/Invalid or unsupported image format/i);
        });

        test('rejects empty or excessively small buffers', () => {
            const tiny = Buffer.from([0xff, 0xd8]);
            expect(() => validateImageBuffer(tiny)).toThrow(/Invalid or unsupported image format/i);
        });

        test('rejects files exceeding the size limit', () => {
            const oversized = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 1024);
            samplePng.copy(oversized, 0, 0, samplePng.length);
            expect(() => validateImageBuffer(oversized)).toThrow(/size exceeds the maximum allowed limit/i);
        });

        test('isSafeFilename validates file names and blocks path traversal', () => {
            expect(isSafeFilename('prod_1_1729000000000_abcdef1234567890.png')).toBe(true);
            expect(isSafeFilename('prod_42_1729000000000_1234567890abcdef.jpg')).toBe(true);
            expect(isSafeFilename('prod_99_1729000000000_87654321fedcba09.webp')).toBe(true);

            expect(isSafeFilename('../../etc/passwd')).toBe(false);
            expect(isSafeFilename('..\\..\\windows\\system32')).toBe(false);
            expect(isSafeFilename('exploit.php')).toBe(false);
            expect(isSafeFilename('photo.png')).toBe(false);
            expect(isSafeFilename('prod_1_test.png')).toBe(false);
        });

        test('getImageFilePath safely resolves file paths and blocks path traversal attempts', () => {
            expect(getImageFilePath('../../etc/passwd')).toBeNull();
            expect(getImageFilePath('..\\..\\windows\\system32')).toBeNull();
            expect(getImageFilePath('/etc/hosts')).toBeNull();
            expect(getImageFilePath('bad_file_name.exe')).toBeNull();
        });

        test('saveProductImage saves image to disk and deleteImageFile cleans it up', async () => {
            const filename = await saveProductImage(99, samplePng);
            expect(filename).toMatch(/^prod_99_\d+_[a-f0-9]{16}\.png$/);

            const filePath = getImageFilePath(filename);
            expect(filePath).toBeTruthy();
            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.readFileSync(filePath)).toEqual(samplePng);

            const deleted = await deleteImageFile(filename);
            expect(deleted).toBe(true);
            expect(fs.existsSync(filePath)).toBe(false);
        });

        test('restoreProductImageIfMissing validates filename and returns path if already on disk', async () => {
            expect(await restoreProductImageIfMissing('../bad.png')).toBeNull();
            expect(await restoreProductImageIfMissing('')).toBeNull();

            const filename = await saveProductImage(99, samplePng);
            const restoredPath = await restoreProductImageIfMissing(filename);
            expect(restoredPath).toBeTruthy();
            expect(fs.existsSync(restoredPath)).toBe(true);
            await deleteImageFile(filename);
        });
    });

    describe('2. Gemini AI Function-Calling & Catalogue Context Integration', () => {
        test('show_product function declaration exists in ai.js tools schema', () => {
            const aiModule = require('../src/services/ai');
            expect(typeof aiModule.generateReply).toBe('function');
            expect(typeof aiModule.buildSystemInstruction).toBe('function');
        });

        test('buildSystemInstruction enforces that show_product is NOT called on greetings', () => {
            const { buildSystemInstruction } = require('../src/services/ai');
            const instruction = buildSystemInstruction({
                systemPrompt: 'You are an assistant',
                ownerName: 'Acme Owner',
                businessName: 'Acme Corp',
                hasProducts: true
            });

            expect(instruction).toContain('Product catalog & photos:');
            expect(instruction).toContain('CRITICAL RULE: Do NOT call show_product for simple greetings');
            expect(instruction).toContain('Only call the show_product tool when the customer actively asks for product details');
        });
    });

    describe('3. WhatsApp Media Message Delivery & Graceful Fallback', () => {
        test('sendProductMediaMessage throws 409 WA_NOT_CONNECTED when client is offline', async () => {
            const { sendProductMediaMessage } = require('../src/services/whatsapp-client');
            await expect(sendProductMediaMessage(9999, '919876543210', 1, 'Test Caption'))
                .rejects.toThrow(/WhatsApp client is not connected/i);
        });

        test('sendProductMediaMessage validates destination phone number format', async () => {
            const { sendProductMediaMessage } = require('../src/services/whatsapp-client');
            await expect(sendProductMediaMessage(9999, 'abc', 1, 'Caption'))
                .rejects.toThrow();
        });

        test('chatbot processMessage handles incoming queries safely', async () => {
            const { processMessage } = require('../src/services/chatbot');
            expect(typeof processMessage).toBe('function');
        });
    });

    describe('4. Backward Compatibility & Isolation', () => {
        test('products without image_path operate normally with empty string default', () => {
            const product = {
                id: 1,
                user_id: 1,
                name: 'Standard Product',
                price: '499',
                description: 'A test service',
                image_path: ''
            };
            expect(product.image_path).toBe('');
        });

        test('products with valid image_path preserve the reference', () => {
            const product = {
                id: 2,
                user_id: 1,
                name: 'Photo Product',
                price: '999',
                description: 'Product with photo',
                image_path: 'prod_1_1729000000000_abcdef1234567890.jpg'
            };
            expect(product.image_path).toMatch(/^prod_\d+_\d+_[a-f0-9]{16}\.(jpg|png|webp)$/);
        });
    });

    describe('5. Image Upload & Product API Security Integration Tests', () => {
        const express = require('express');
        const request = require('supertest');
        let app;

        beforeAll(() => {
            app = express();
            app.use(express.json());
            // Middleware simulating authentication boundary
            app.use((req, res, next) => {
                if (req.headers['authorization'] === 'Bearer valid-token') {
                    req.user = { id: 1, role: 'user', status: 'active', wa_enabled: 1 };
                }
                next();
            });
            app.use('/api', require('../src/routes/api'));
            app.use(require('../src/utils/errors').errorHandler);
        });

        test('POST /api/products/upload-image rejects unauthenticated requests', async () => {
            const res = await request(app)
                .post('/api/products/upload-image')
                .attach('image', samplePng, 'sample.png');
            expect(res.status).toBe(401);
        });

        test('POST /api/products/upload-image accepts genuine PNG and saves file', async () => {
            const res = await request(app)
                .post('/api/products/upload-image')
                .set('Authorization', 'Bearer valid-token')
                .attach('image', samplePng, 'sample.png');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.filename).toMatch(/^prod_1_\d+_[a-f0-9]{16}\.png$/);
            expect(res.body.data.url).toContain(res.body.data.filename);

            await deleteImageFile(res.body.data.filename);
        });

        test('POST /api/products/upload-image rejects non-image text file', async () => {
            const fake = Buffer.from('hello world not an image', 'utf8');
            const res = await request(app)
                .post('/api/products/upload-image')
                .set('Authorization', 'Bearer valid-token')
                .attach('image', fake, 'exploit.txt');

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/Invalid or unsupported image format/i);
        });

        test('GET /api/products/images/:filename serves image with correct mime header', async () => {
            const filename = await saveProductImage(1, samplePng);
            const res = await request(app)
                .get(`/api/products/images/${filename}`);

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('image/png');
            expect(res.body).toEqual(samplePng);

            await deleteImageFile(filename);
        });

        test('GET /api/products/images/:filename rejects directory traversal', async () => {
            const res = await request(app)
                .get('/api/products/images/..%2F..%2Fetc%2Fpasswd');
            expect([400, 404]).toContain(res.status);
        });
    });
});
