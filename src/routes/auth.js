const express = require('express');
const router = express.Router();

const {
    hashPassword, verifyPassword, burnPasswordVerification, createSessionToken,
    verifySessionToken, getTokenFromRequest,
    setSessionCookie, clearSessionCookie, revokeSession, revokeAllSessionsForUser,
    isValidEmail, isValidPassword, normalizeEmail, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH
} = require('../config/auth');
const {
    getUserByEmail, createUser, touchLastLogin, getUserById,
    isDuplicateEmailError, updateUser, incrementAuthVersion
} = require('../services/database');
const { requireAuth } = require('../middleware/auth');
const { rateLimit, clientIp } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/errors');
const { optionalString, LIMITS } = require('../utils/validate');

function publicUser(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return rest;
}

// Blunt brute-force login attempts and spam signups. Generous enough that a
// real user mistyping their password a few times never notices.
//
// Two layers, not one: a per-(IP, account) limiter stops someone brute-forcing
// one specific account, and a looser per-IP limiter stops one IP from spraying
// attempts across many accounts. An IP-only limiter alone would lock out an
// entire office/NAT/mobile-carrier IP for everyone behind it after one person's
// typos or one attacker's attempt against a single account — that's the bug a
// same-origin login-flood test in this project's own test suite caught.
const loginAccountLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    keyFn: (req) => `login-acct:${clientIp(req)}:${String(req.body?.email || '').trim().toLowerCase().slice(0, 254)}`,
    message: 'Too many login attempts for this account. Please wait a few minutes and try again.'
});
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    keyFn: (req) => `login-ip:${clientIp(req)}`,
    message: 'Too many login attempts from this location. Please wait a few minutes and try again.'
});
const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyFn: (req) => `signup:${clientIp(req)}`,
    message: 'Too many signup attempts from this location. Please try again later.'
});
// Password changes are authenticated, so the risk isn't account enumeration —
// it's someone with a stolen cookie grinding the *current* password to
// confirm it before locking the owner out. Keyed per account.
const passwordChangeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => `pwchange:${req.user ? req.user.id : clientIp(req)}`,
    message: 'Too many password change attempts. Please wait a few minutes.'
});

// ─── Sign up ──────────────────────────────────────────────────
router.post('/signup', signupLimiter, asyncHandler(async (req, res) => {
    if (process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
        return res.status(403).json({
            success: false,
            error: 'Public registration is closed. Only authorized client access is permitted.'
        });
    }
    const { email, password, businessName, ownerName } = req.body || {};

    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
        return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    if (!isValidPassword(password)) {
        return res.status(400).json({
            success: false,
            error: `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`
        });
    }

    // Bound these before they reach the database — they're rendered in the
    // admin panel and injected into AI prompts.
    const safeBusinessName = optionalString(businessName, 'businessName', LIMITS.CONTACT_NAME).trim();
    const safeOwnerName = optionalString(ownerName, 'ownerName', LIMITS.CONTACT_NAME).trim();

    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
        return res.status(409).json({ success: false, error: 'An account with this email already exists. Try logging in instead.' });
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
        user = await createUser({
            email: normalizedEmail,
            passwordHash,
            businessName: safeBusinessName,
            ownerName: safeOwnerName
        });
    } catch (err) {
        // Two simultaneous signups for the same address both pass the check
        // above (it happens before the `await` on bcrypt, so they interleave
        // there), and the UNIQUE index on users.email is what actually
        // prevents the duplicate. Report it as the 409 it is, not a 500.
        if (isDuplicateEmailError(err)) {
            return res.status(409).json({ success: false, error: 'An account with this email already exists. Try logging in instead.' });
        }
        throw err;
    }

    // Admin approval required: new signups are created with status 'pending'
    // and are NOT automatically logged in with a session cookie.
    const createdUser = await getUserById(user.id);

    res.json({
        success: true,
        pendingApproval: true,
        message: 'Your account has been created and is pending administrator approval. You will be able to log in once an admin approves your request.',
        data: publicUser(createdUser)
    });
}));

// ─── Log in ───────────────────────────────────────────────────
router.post('/login', loginIpLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const normalizedEmail = normalizeEmail(email);

    if (!normalizedEmail || typeof password !== 'string' || password === '') {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }
    // Don't hash absurd input: bcrypt truncates at 72 bytes anyway, so a 1MB
    // "password" is pure CPU cost for an attacker to impose on us.
    if (password.length > MAX_PASSWORD_LENGTH) {
        return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    const user = await getUserByEmail(normalizedEmail);

    // Same response, same status, and — via burnPasswordVerification — the
    // same amount of CPU whether or not the account exists. Skipping the
    // hash for unknown emails is what makes login timing a reliable account
    // enumeration oracle.
    if (!user) {
        await burnPasswordVerification();
        return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
        return res.status(401).json({ success: false, error: 'Invalid email or password.' });
    }

    if (user.status === 'pending') {
        return res.status(403).json({
            success: false,
            error: 'Your account is pending administrator approval. Please wait for an admin to approve your account before logging in.',
            code: 'ACCOUNT_PENDING'
        });
    }

    if (user.status === 'rejected') {
        return res.status(403).json({
            success: false,
            error: 'Your account registration was declined by the administrator.',
            code: 'ACCOUNT_REJECTED'
        });
    }

    if (user.status === 'suspended') {
        return res.status(403).json({
            success: false,
            error: 'Your account has been suspended. Contact your administrator.',
            code: 'ACCOUNT_SUSPENDED'
        });
    }

    await touchLastLogin(user.id);
    const refreshToken = createSessionToken(user, 'refresh');
    setSessionCookie(res, refreshToken);
    
    const accessToken = createSessionToken(user, 'access');

    const loggedInUser = await getUserById(user.id);
    res.json({ success: true, data: publicUser(loggedInUser), accessToken });
}));

// ─── Refresh token ────────────────────────────────────────────
// Called when the frontend's access token expires.
router.post('/refresh', asyncHandler(async (req, res) => {
    const token = getTokenFromRequest(req);
    if (!token) return res.status(401).json({ success: false, error: 'No refresh token provided', code: 'AUTH_REQUIRED' });

    const payload = verifySessionToken(token, 'refresh');
    if (!payload) {
        clearSessionCookie(res);
        return res.status(401).json({ success: false, error: 'Refresh token expired or invalid', code: 'AUTH_REQUIRED' });
    }

    const user = await getUserById(payload.id);
    if (!user || user.status !== 'active') {
        clearSessionCookie(res);
        return res.status(401).json({ success: false, error: 'Account inactive', code: 'AUTH_REQUIRED' });
    }

    // Issue new tokens (rotation)
    const newRefreshToken = createSessionToken(user, 'refresh');
    setSessionCookie(res, newRefreshToken);
    const newAccessToken = createSessionToken(user, 'access');

    res.json({ success: true, accessToken: newAccessToken });
}));

// ─── Log out ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    revokeSession(req, res);
    res.json({ success: true });
});

// ─── Change password ──────────────────────────────────────────
// Requiring the current password is what stops a stolen session cookie from
// becoming permanent ownership of the account; revoking every other session
// afterwards is what evicts the thief once the real owner notices.
router.post('/change-password', requireAuth, passwordChangeLimiter, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};

    if (typeof currentPassword !== 'string' || currentPassword === '') {
        return res.status(400).json({ success: false, error: 'Your current password is required.' });
    }
    if (!isValidPassword(newPassword)) {
        return res.status(400).json({
            success: false,
            error: `New password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`
        });
    }
    if (currentPassword === newPassword) {
        return res.status(400).json({ success: false, error: 'Your new password must be different from the current one.' });
    }

    const fresh = await getUserById(req.user.id);
    const ok = await verifyPassword(currentPassword, fresh.password_hash);
    if (!ok) {
        return res.status(401).json({ success: false, error: 'That is not your current password.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await updateUser(req.user.id, { password_hash: passwordHash });

    revokeAllSessionsForUser(req.user.id);
    revokeSession(req, res);
    const updatedUser = await getUserById(req.user.id);
    
    const newRefreshToken = createSessionToken(updatedUser, 'refresh');
    setSessionCookie(res, newRefreshToken);
    const newAccessToken = createSessionToken(updatedUser, 'access');

    res.json({ success: true, accessToken: newAccessToken, data: { message: 'Password changed. Other devices have been signed out.' } });
}));

// ─── Current session ────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
    res.json({ success: true, data: publicUser(req.user) });
});

// ─── Revoke all sessions & tokens ────────────────────────────
router.post('/revoke-all-sessions', requireAuth, asyncHandler(async (req, res) => {
    revokeAllSessionsForUser(req.user.id);
    await incrementAuthVersion(req.user.id);
    revokeSession(req, res);
    res.json({ success: true, message: 'All active sessions and tokens have been revoked.' });
}));

module.exports = router;





