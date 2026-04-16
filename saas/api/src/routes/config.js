'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { generateConfig, RISK_PROFILES } = require('../services/configService');
const db = require('../db/client');

const router = express.Router();
router.use(requireAuth);

// ── GET /config/risk-profiles ─────────────────────────────────────────────────
router.get('/risk-profiles', (_req, res) => {
    const profiles = Object.entries(RISK_PROFILES).map(([key, p]) => ({
        key,
        description: p.description,
    }));
    res.json({ profiles });
});

// ── POST /config — generate + save a bot config ───────────────────────────────
router.post(
    '/',
    [
        body('credId').isUUID(),
        body('capital').isFloat({ min: 100 }),
        body('risk').isIn(['low', 'medium', 'high', 'custom']),
        body('symbol').optional().isString(),
        body('exchange').optional().isIn(['binance', 'bingx']),
        body('custom').optional().isObject(),
    ],
    validate,
    async (req, res) => {
        const { credId, capital, risk, symbol, exchange, custom } = req.body;
        const userId = req.userId;

        // Verify credential belongs to this user
        const { rows: creds } = await db.query(
            'SELECT id, exchange FROM user_credentials WHERE id = $1 AND user_id = $2',
            [credId, userId]
        );
        if (!creds[0]) return res.status(404).json({ error: 'Credential not found' });

        try {
            const { config, warnings } = generateConfig({
                capital,
                risk,
                symbol: symbol || 'BTC/USDT:USDT',
                exchange: exchange || creds[0].exchange,
                custom: custom || {},
            });

            const { rows } = await db.query(
                `INSERT INTO bot_configs (user_id, cred_id, symbol, risk_level, capital, config_json)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, symbol, risk_level, capital, created_at`,
                [
                    userId, credId,
                    config.SYMBOL, risk, capital,
                    JSON.stringify(config),
                ]
            );

            res.status(201).json({ config: rows[0], warnings });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    }
);

// ── GET /config — list user's configs ────────────────────────────────────────
router.get('/', async (req, res) => {
    const { rows } = await db.query(
        `SELECT id, symbol, risk_level, capital, created_at
         FROM bot_configs WHERE user_id = $1 ORDER BY created_at DESC`,
        [req.userId]
    );
    res.json({ configs: rows });
});

// ── GET /config/:id ───────────────────────────────────────────────────────────
router.get(
    '/:id',
    [param('id').isUUID()],
    validate,
    async (req, res) => {
        const { rows } = await db.query(
            `SELECT id, symbol, risk_level, capital, config_json, created_at
             FROM bot_configs WHERE id = $1 AND user_id = $2`,
            [req.params.id, req.userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Config not found' });
        res.json({ config: rows[0] });
    }
);

module.exports = router;
