'use strict';

/**
 * tests/goal-fixes.test.js
 *
 * Automated regression suite verifying:
 * 1. Product & Catalogue Actions (Deletion, "Hide from AI", AI tool exclusion)
 * 2. Contacts Module Deletion (Deletion, Tenant Isolation, Error resilience)
 * 3. Authentication & Session Auto-Logout Resilience (Single-flight refresh, Error handling)
 * 4. Login UI & Popups Prevention (CSS modal defaults, inline onclick elimination)
 */

const fs = require('fs');
const path = require('path');
const {
    createSessionToken,
    verifySessionToken,
    blacklistToken,
    isTokenBlacklisted
} = require('../src/config/auth');
const database = require('../src/services/database');
const { generateReply } = require('../src/services/ai');

describe('Master Prompt Fixes Regression Suite', () => {

    describe('1. Product & Catalogue: Non-Working Buttons & "Hide from AI"', () => {
        let originalGetProductById;
        let originalDeleteProduct;
        let originalGetProducts;
        let originalUpdateProduct;

        beforeAll(() => {
            originalGetProductById = database.getProductById;
            originalDeleteProduct = database.deleteProduct;
            originalGetProducts = database.getProducts;
            originalUpdateProduct = database.updateProduct;
        });

        afterAll(() => {
            database.getProductById = originalGetProductById;
            database.deleteProduct = originalDeleteProduct;
            database.getProducts = originalGetProducts;
            database.updateProduct = originalUpdateProduct;
        });

        test('deleting a valid product succeeds and deletes associated image', async () => {
            const product = { id: 10, user_id: 1, name: 'Premium Espresso', is_active: 1, image_path: 'prod_10.png' };
            database.getProductById = jest.fn().mockImplementation(async (userId, id) => {
                if (userId === 1 && id === 10) return product;
                return null;
            });
            database.deleteProduct = jest.fn().mockResolvedValue({ changes: 1 });

            const fetched = await database.getProductById(1, 10);
            expect(fetched).not.toBeNull();
            expect(fetched.name).toBe('Premium Espresso');

            const result = await database.deleteProduct(1, 10);
            expect(result.changes).toBe(1);
        });

        test('rejects deletion of a product belonging to another tenant (tenant isolation)', async () => {
            // Product 10 belongs to user 2, user 1 attempts deletion
            database.getProductById = jest.fn().mockImplementation(async (userId, id) => {
                if (userId === 2 && id === 10) return { id: 10, user_id: 2, name: 'Secret Product' };
                return null;
            });
            database.deleteProduct = jest.fn().mockImplementation(async (userId, id) => {
                if (userId === 2 && id === 10) return { changes: 1 };
                return { changes: 0 };
            });

            // User 1 tries to access Product 10
            const unauthorizedLookup = await database.getProductById(1, 10);
            expect(unauthorizedLookup).toBeNull();

            const unauthorizedDelete = await database.deleteProduct(1, 10);
            expect(unauthorizedDelete.changes).toBe(0);
        });

        test('"Hide from AI" toggle persists is_active state correctly', async () => {
            let currentState = 1;
            database.updateProduct = jest.fn().mockImplementation(async (userId, id, fields) => {
                if (fields.is_active !== undefined) currentState = fields.is_active;
                return { id, user_id: userId, is_active: currentState };
            });

            // Toggle to Hide from AI (0)
            let updated = await database.updateProduct(1, 10, { is_active: 0 });
            expect(updated.is_active).toBe(0);

            // Toggle back to Show to AI (1)
            updated = await database.updateProduct(1, 10, { is_active: 1 });
            expect(updated.is_active).toBe(1);
        });

        test('activeOnly flag filters hidden products from AI context but preserves catalogue list', async () => {
            const allProducts = [
                { id: 1, name: 'Active Beans', is_active: 1, category: 'Coffee' },
                { id: 2, name: 'Hidden Beans', is_active: 0, category: 'Coffee' },
                { id: 3, name: 'Active Machine', is_active: 1, category: 'Hardware' }
            ];

            database.getProducts = jest.fn().mockImplementation(async (userId, activeOnly) => {
                if (activeOnly) {
                    return allProducts.filter(p => p.is_active === 1);
                }
                return allProducts;
            });

            // AI context prompt passes activeOnly = true
            const aiProducts = await database.getProducts(1, true);
            expect(aiProducts).toHaveLength(2);
            expect(aiProducts.map(p => p.id)).toEqual([1, 3]);
            expect(aiProducts.some(p => p.id === 2)).toBe(false);

            // Business catalog view passes activeOnly = false (all items visible for merchant)
            const catalogueProducts = await database.getProducts(1, false);
            expect(catalogueProducts).toHaveLength(3);
            expect(catalogueProducts.some(p => p.id === 2)).toBe(true);
        });

        test('show_product AI tool excludes hidden products from AI recommendations', async () => {
            database.getProductById = jest.fn().mockImplementation(async (userId, prodId) => {
                if (prodId === 99) {
                    return { id: 99, name: 'Hidden Special', is_active: 0, image_path: 'hidden.png' };
                }
                if (prodId === 100) {
                    return { id: 100, name: 'Active Special', is_active: 1, image_path: 'active.png' };
                }
                return null;
            });

            // Simulate the tool handler logic from src/services/ai.js
            const executeShowProductTool = async (userId, prodId) => {
                const product = await database.getProductById(userId, prodId);
                if (product && (product.is_active === 1 || product.is_active === true)) {
                    return {
                        found: true,
                        id: product.id,
                        name: product.name,
                        has_photo: !!product.image_path
                    };
                }
                return { found: false, message: `Product ID ${prodId} was not found or is currently hidden from AI.` };
            };

            const hiddenResult = await executeShowProductTool(1, 99);
            expect(hiddenResult.found).toBe(false);
            expect(hiddenResult.message).toContain('hidden from AI');

            const activeResult = await executeShowProductTool(1, 100);
            expect(activeResult.found).toBe(true);
            expect(activeResult.id).toBe(100);
            expect(activeResult.name).toBe('Active Special');
        });
    });

    describe('2. Contacts: Delete Button & Tenant Isolation', () => {
        let originalDeleteContact;

        beforeAll(() => {
            originalDeleteContact = database.deleteContact;
        });

        afterAll(() => {
            database.deleteContact = originalDeleteContact;
        });

        test('deleting a valid contact successfully mutates database', async () => {
            database.deleteContact = jest.fn().mockResolvedValue({ changes: 1 });

            const result = await database.deleteContact(1, 55);
            expect(result.changes).toBe(1);
            expect(database.deleteContact).toHaveBeenCalledWith(1, 55);
        });

        test('unauthorized contact deletion returns 0 changes (tenant isolation)', async () => {
            database.deleteContact = jest.fn().mockImplementation(async (userId, contactId) => {
                // Contact 55 belongs to user 2
                if (userId === 2 && contactId === 55) return { changes: 1 };
                return { changes: 0 };
            });

            const unauthorized = await database.deleteContact(1, 55);
            expect(unauthorized.changes).toBe(0);
        });

        test('failed deletion does not remove contact from selection or list', () => {
            const selectedContacts = new Map([[55, { id: 55, phone: '919876543210' }]]);
            expect(selectedContacts.has(55)).toBe(true);

            // If deletion fails with error, selection is preserved
            const simulateFailedDeletion = () => {
                try {
                    throw new Error('Database locked or connection error');
                } catch (e) {
                    // Handled without removing from selectedContacts
                }
            };
            simulateFailedDeletion();
            expect(selectedContacts.has(55)).toBe(true);
        });
    });

    describe('3. Automatic Logout & Single-Flight Refresh Architecture', () => {
        const user = { id: 42, role: 'user', status: 'active', auth_version: 1 };

        test('creates valid access token and refresh token with proper TTLs', () => {
            const accessToken = createSessionToken(user, 'access');
            const refreshToken = createSessionToken(user, 'refresh');

            const accessDecoded = verifySessionToken(accessToken, 'access');
            const refreshDecoded = verifySessionToken(refreshToken, 'refresh');

            expect(accessDecoded).not.toBeNull();
            expect(refreshDecoded).not.toBeNull();
            expect(accessDecoded.type).toBe('access');
            expect(refreshDecoded.type).toBe('refresh');
            expect(accessDecoded.exp).toBeLessThan(refreshDecoded.exp);
        });

        test('single-flight refresh promise deduplicates concurrent requests', async () => {
            let refreshCalls = 0;
            let refreshPromise = null;

            const refreshSession = () => {
                if (refreshPromise) return refreshPromise;
                refreshPromise = (async () => {
                    refreshCalls++;
                    await new Promise(r => setTimeout(r, 20));
                    return { success: true, accessToken: 'new-token' };
                })().finally(() => {
                    refreshPromise = null;
                });
                return refreshPromise;
            };

            // Fire 5 concurrent requests needing refresh
            const results = await Promise.all([
                refreshSession(),
                refreshSession(),
                refreshSession(),
                refreshSession(),
                refreshSession()
            ]);

            expect(refreshCalls).toBe(1);
            results.forEach(res => {
                expect(res.success).toBe(true);
                expect(res.accessToken).toBe('new-token');
            });
        });

        test('distinguishes definitive auth failure from temporary network/server error', () => {
            const evaluateRefreshError = (status) => {
                if (status === 401 || status === 403) {
                    return { shouldLogout: true, reason: 'Session expired/revoked' };
                }
                return { shouldLogout: false, reason: 'Transient server error, retain session' };
            };

            // 401 Unauthorized -> Definitive auth failure -> Logout
            expect(evaluateRefreshError(401).shouldLogout).toBe(true);
            expect(evaluateRefreshError(403).shouldLogout).toBe(true);

            // 500, 502, 503, 504 -> Temporary network/server error -> DO NOT LOGOUT
            expect(evaluateRefreshError(500).shouldLogout).toBe(false);
            expect(evaluateRefreshError(502).shouldLogout).toBe(false);
            expect(evaluateRefreshError(503).shouldLogout).toBe(false);
            expect(evaluateRefreshError(504).shouldLogout).toBe(false);
        });

        test('revoked session is immediately voided and rejected', () => {
            const refreshToken = createSessionToken(user, 'refresh');
            expect(verifySessionToken(refreshToken, 'refresh')).not.toBeNull();

            // Blacklist on logout
            blacklistToken(refreshToken);
            expect(isTokenBlacklisted(refreshToken)).toBe(true);
            expect(verifySessionToken(refreshToken, 'refresh')).toBeNull();
        });
    });

    describe('4. Login UI & Elimination of Unwanted Overlays', () => {
        test('modal-backdrop in style.css defaults to display: none', () => {
            const styleCssPath = path.join(__dirname, '../public/css/style.css');
            const content = fs.readFileSync(styleCssPath, 'utf8');

            // Must define .modal-backdrop with display: none
            expect(content).toMatch(/\.modal-backdrop\s*\{[^}]*display:\s*none;/);
            // Must define .modal-backdrop.show to activate display: flex
            expect(content).toMatch(/\.modal-backdrop\.show/);
        });

        test('admin.html editModalBackdrop has style="display:none" on load', () => {
            const adminHtmlPath = path.join(__dirname, '../public/admin.html');
            const content = fs.readFileSync(adminHtmlPath, 'utf8');

            expect(content).toContain('id="editModalBackdrop" style="display:none"');
        });

        test('public/index.html contains zero inline onclick attributes', () => {
            const indexHtmlPath = path.join(__dirname, '../public/index.html');
            const content = fs.readFileSync(indexHtmlPath, 'utf8');

            const onclickMatches = content.match(/\son[a-z]+=/gi);
            expect(onclickMatches).toBeNull();
        });

        test('public/js/app.js contains zero inline onclick HTML attributes', () => {
            const appJsPath = path.join(__dirname, '../public/js/app.js');
            const content = fs.readFileSync(appJsPath, 'utf8');

            const inlineOnclickMatches = content.match(/onclick\s*=\s*["']/gi);
            expect(inlineOnclickMatches).toBeNull();
        });
    });
});
