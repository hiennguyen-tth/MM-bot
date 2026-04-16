'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { encrypt, decrypt } = require('../services/cryptoService');
const db = require('../db/client');

const router = express.Router();
router.use(requireAuth);

// ── POST /credentials — Store encrypted API key pair ─────────────────────────
router.post(
    '/',
    [
        body('exchange').isIn(['binance', 'bingx']),
        body('apiKey').notEmpty().withMessage('apiKey required'),
        body('apiSecret').notEmpty().withMessage('apiSecret required'),
        body('label').optional().isString().isLength({ max: 64 }).default('default'),
    ],
    validate,
    async (req, res) => {
        const { exchange, apiKey, apiSecret, label = 'default' } = req.body;
        const userId = req.userId;

        try {
            const apiKeyEnc = encrypt(apiKey);
            const apiSecretEnc = encrypt(apiSecret);

            const { rows } = await db.query(
                `INSERT INTO user_credentials
                    (user_id, exchange, label, api_key_enc, api_secret_enc)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, exchange, label, created_at`,
                [userId, exchange, label, apiKeyEnc, apiSecretEnc]
            );

            res.status(201).json({ credential: rows[0] });
        } catch (err) {
            if (err.code === '23505') {
                return res.status(409).json({ error: 'Credential with this exchange+label already exists' });
            }
            console.error('[credentials] store error:', err.message);
            res.status(500).json({ error: 'Failed to store credentials' });
        }
    }
);

// ── GET /credentials — List user's credentials (never return keys) ────────────
router.get('/', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, exchange, label, created_at
             FROM user_credentials
             WHERE user_id = $1
             ORDER BY created_at DESC`,
            [req.userId]
        );
        res.json({ credentials: rows });
    } catch (err) {
        console.error('[credentials] list error:', err.message);
        res.status(500).json({ error: 'Failed to list credentials' });
    }
});

// ── DELETE /credentials/:id — Delete if no active bot is using it ─────────────
router.delete(
    '/:id',
    [param('id').isUUID()],
    validate,
    async (req, res) => {
        const { id } = req.params;
        const userId = req.userId;
        try {
            // Verify ownership
            const { rows: creds } = await db.query(
                'SELECT id FROM user_credentials WHERE id = $1 AND user_id = $2',
                [id, userId]
            );
            if (!creds[0]) return res.status(404).json({ error: 'Credential not found' });

            // Block deletion if a bot is still running with a config that uses this credential
            const { rows: active } = await db.query(
                `SELECT bi.id FROM bot_instances bi
                 JOIN bot_configs bc ON bc.id = bi.config_id
                 WHERE bc.cred_id = $1
                   AND bi.status IN ('pending','running','stopping')
                 LIMIT 1`,
                [id]
            );
            if (active[0]) {
                return res.status(409).json({ error: 'Cannot delete credential while a bot is running with it' });
            }

            await db.query('DELETE FROM user_credentials WHERE id = $1', [id]);
            res.status(204).send();
        } catch (err) {
            console.error('[credentials] delete error:', err.message);
            res.status(500).json({ error: 'Failed to delete credential' });
        }
    }
);

// ── Internal: decrypt credentials for worker use (not exposed as HTTP route) ──
async function getDecryptedCredential(credId, userId) {
    const { rows } = await db.query(
        'SELECT api_key_enc, api_secret_enc, exchange FROM user_credentials WHERE id = $1 AND user_id = $2',
        [credId, userId]
    );
    if (!rows[0]) throw new Error('Credential not found');
    return {
        apiKey: decrypt(rows[0].api_key_enc),
        apiSecret: decrypt(rows[0].api_secret_enc),
        exchange: rows[0].exchange,
    };
}

module.exports = router;
module.exports.getDecryptedCredential = getDecryptedCredential;
