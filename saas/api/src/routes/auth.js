'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const db = require('../db/client');

const router = express.Router();
const SALT_ROUNDS = 12;

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post(
    '/register',
    [
        body('email').isEmail().normalizeEmail(),
        body('password').isLength({ min: 8 }).withMessage('Password must be ≥ 8 characters'),
    ],
    validate,
    async (req, res) => {
        const { email, password } = req.body;
        try {
            const hash = await bcrypt.hash(password, SALT_ROUNDS);
            const { rows } = await db.query(
                'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
                [email, hash]
            );
            res.status(201).json({ user: rows[0] });
        } catch (err) {
            if (err.code === '23505') {  // unique violation
                return res.status(409).json({ error: 'Email already registered' });
            }
            console.error('[auth] register error:', err.message);
            res.status(500).json({ error: 'Registration failed' });
        }
    }
);

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post(
    '/login',
    [
        body('email').isEmail().normalizeEmail(),
        body('password').notEmpty(),
    ],
    validate,
    async (req, res) => {
        const { email, password } = req.body;
        try {
            const { rows } = await db.query(
                'SELECT id, email, password_hash, is_active FROM users WHERE email = $1',
                [email]
            );
            const user = rows[0];

            // Constant-time comparison prevents timing attacks
            const valid = user
                ? await bcrypt.compare(password, user.password_hash)
                : await bcrypt.compare(password, '$2b$12$invalidhashtopreventtimingattack');

            if (!user || !valid || !user.is_active) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const token = jwt.sign(
                { sub: user.id },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
            );

            res.json({
                token,
                user: { id: user.id, email: user.email },
            });
        } catch (err) {
            console.error('[auth] login error:', err.message);
            res.status(500).json({ error: 'Login failed' });
        }
    }
);

// ── GET /auth/me ──────────────────────────────────────────────────────────────
const { requireAuth } = require('../middleware/auth');
router.get('/me', requireAuth, async (req, res) => {
    const { rows } = await db.query(
        'SELECT id, email, telegram_chat_id, created_at FROM users WHERE id = $1',
        [req.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
});

// ── PUT /auth/telegram — Register user's Telegram chat_id ─────────────────────
// How to get your chat_id:
//   1. Start a chat with @YourBotUsername on Telegram
//   2. Send any message, then visit:
//      https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates
//   3. Copy the "id" field from message.chat
router.put(
    '/telegram',
    requireAuth,
    [
        body('chatId')
            .notEmpty().withMessage('chatId required')
            .matches(/^-?\d+$/).withMessage('chatId must be a numeric Telegram chat ID'),
    ],
    validate,
    async (req, res) => {
        const { chatId } = req.body;
        try {
            const { rows } = await db.query(
                `UPDATE users
                 SET telegram_chat_id = $1
                 WHERE id = $2
                 RETURNING id, email, telegram_chat_id`,
                [chatId.trim(), req.userId]
            );
            if (!rows[0]) return res.status(404).json({ error: 'User not found' });
            res.json({
                message: 'Telegram chat ID saved. You will now receive bot notifications.',
                user: rows[0],
            });
        } catch (err) {
            console.error('[auth] telegram update error:', err.message);
            res.status(500).json({ error: 'Failed to update Telegram chat ID' });
        }
    }
);

// ── DELETE /auth/telegram — Remove Telegram notifications ─────────────────────
router.delete('/telegram', requireAuth, async (req, res) => {
    try {
        await db.query(
            'UPDATE users SET telegram_chat_id = NULL WHERE id = $1',
            [req.userId]
        );
        res.json({ message: 'Telegram notifications disabled' });
    } catch (err) {
        console.error('[auth] telegram delete error:', err.message);
        res.status(500).json({ error: 'Failed to remove Telegram chat ID' });
    }
});

module.exports = router;
