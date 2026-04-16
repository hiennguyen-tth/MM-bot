'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const db = require('../db/client');
const orchestrator = require('../services/orchestratorService');
const { getDecryptedCredential } = require('./credentials');

const router = express.Router();
router.use(requireAuth);

// ── POST /bot/start ───────────────────────────────────────────────────────────
router.post(
    '/start',
    [
        body('configId').isUUID().withMessage('configId (UUID) required'),
    ],
    validate,
    async (req, res) => {
        const userId = req.userId;
        const { configId } = req.body;

        // Global kill switch check
        if (process.env.GLOBAL_KILL_SWITCH === 'true') {
            return res.status(503).json({ error: 'Service temporarily unavailable (kill switch active)' });
        }

        try {
            // 1. Check no other bot is already running for this user
            const existing = await orchestrator.getRunningInstance(userId);
            if (existing) {
                return res.status(409).json({
                    error: 'A bot is already running. Stop it before starting a new one.',
                    instanceId: existing.id,
                });
            }

            // 2. Load config and verify ownership
            const { rows: configs } = await db.query(
                `SELECT bc.*, uc.exchange
                 FROM bot_configs bc
                 JOIN user_credentials uc ON uc.id = bc.cred_id
                 WHERE bc.id = $1 AND bc.user_id = $2`,
                [configId, userId]
            );
            if (!configs[0]) {
                return res.status(404).json({ error: 'Config not found' });
            }
            const cfg = configs[0];

            // 3. Decrypt API keys (in-memory only, never logged)
            const { apiKey, apiSecret } = await getDecryptedCredential(cfg.cred_id, userId);

            // 4. Create bot_instances row
            // 3b. Fetch user's Telegram chat_id (to pass into bot process for direct alerts)
            const { rows: userRows } = await db.query(
                'SELECT telegram_chat_id FROM users WHERE id = $1',
                [userId]
            );
            const telegramChatId = userRows[0]?.telegram_chat_id || null;

            // 4. Create bot_instances row
            const { rows: inst } = await db.query(
                `INSERT INTO bot_instances (user_id, config_id, status)
                 VALUES ($1, $2, 'pending')
                 RETURNING id, status, created_at`,
                [userId, configId]
            );
            const instance = inst[0];

            // 5. Enqueue the start job — keys handed off in-memory to worker
            await orchestrator.startBot({
                instanceId: instance.id,
                userId,
                configJson: { ...cfg.config_json, TELEGRAM_CHAT_ID: telegramChatId },
                apiKey,
                apiSecret,
            });

            res.status(202).json({
                message: 'Bot starting',
                instanceId: instance.id,
                status: instance.status,
            });
        } catch (err) {
            console.error('[bot] start error:', err.message);
            res.status(500).json({ error: 'Failed to start bot' });
        }
    }
);

// ── POST /bot/stop ────────────────────────────────────────────────────────────
router.post('/stop', async (req, res) => {
    const userId = req.userId;
    try {
        const instance = await orchestrator.getRunningInstance(userId);
        if (!instance) {
            return res.status(404).json({ error: 'No running bot found' });
        }

        // Mark as stopping in DB immediately
        await orchestrator.setInstanceStatus(instance.id, 'stopping');

        // Send stop signal via Redis pub/sub to the worker
        await orchestrator.stopBot(instance.id);

        res.json({ message: 'Stop signal sent', instanceId: instance.id });
    } catch (err) {
        console.error('[bot] stop error:', err.message);
        res.status(500).json({ error: 'Failed to stop bot' });
    }
});

// ── GET /bot/status ───────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
    const userId = req.userId;
    try {
        // Get latest instance (any status)
        const { rows } = await db.query(
            `SELECT bi.id, bi.status, bi.stop_reason, bi.started_at, bi.stopped_at,
                    bc.symbol, bc.risk_level, bc.capital
             FROM bot_instances bi
             JOIN bot_configs bc ON bc.id = bi.config_id
             WHERE bi.user_id = $1
             ORDER BY bi.created_at DESC LIMIT 1`,
            [userId]
        );
        if (!rows[0]) {
            return res.json({ status: 'never_started', instance: null });
        }

        const instance = rows[0];

        // Attach latest metrics if running
        let metrics = null;
        if (['running', 'stopping'].includes(instance.status)) {
            metrics = await orchestrator.getLatestMetrics(instance.id);
        }

        res.json({ instance, metrics });
    } catch (err) {
        console.error('[bot] status error:', err.message);
        res.status(500).json({ error: 'Failed to get bot status' });
    }
});

// ── GET /bot/metrics?instanceId=&limit=&offset= ───────────────────────────────
router.get(
    '/metrics',
    [
        query('instanceId').optional().isUUID(),
        query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
        query('offset').optional().isInt({ min: 0 }).toInt(),
    ],
    validate,
    async (req, res) => {
        const userId = req.userId;
        const limit = req.query.limit ?? 100;
        const offset = req.query.offset ?? 0;

        try {
            let queryText, queryParams;

            if (req.query.instanceId) {
                // Verify the instance belongs to this user
                const { rows: inst } = await db.query(
                    'SELECT id FROM bot_instances WHERE id = $1 AND user_id = $2',
                    [req.query.instanceId, userId]
                );
                if (!inst[0]) return res.status(404).json({ error: 'Instance not found' });

                queryText = `
                    SELECT id, recorded_at, realized_pnl, hourly_pnl, max_drawdown,
                           inventory, fill_rate, quotes_placed, fills, adverse_fill_ratio, regime
                    FROM bot_metrics
                    WHERE instance_id = $1
                    ORDER BY recorded_at DESC
                    LIMIT $2 OFFSET $3
                `;
                queryParams = [req.query.instanceId, limit, offset];
            } else {
                // Return metrics across all user instances
                queryText = `
                    SELECT id, instance_id, recorded_at, realized_pnl, hourly_pnl, max_drawdown,
                           inventory, fill_rate, quotes_placed, fills, adverse_fill_ratio, regime
                    FROM bot_metrics
                    WHERE user_id = $1
                    ORDER BY recorded_at DESC
                    LIMIT $2 OFFSET $3
                `;
                queryParams = [userId, limit, offset];
            }

            const { rows } = await db.query(queryText, queryParams);
            res.json({ metrics: rows, limit, offset });
        } catch (err) {
            console.error('[bot] metrics error:', err.message);
            res.status(500).json({ error: 'Failed to fetch metrics' });
        }
    }
);

module.exports = router;
