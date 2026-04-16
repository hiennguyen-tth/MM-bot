'use strict';

const { Queue } = require('bullmq');
const { getRedis } = require('./redisClient');
const db = require('../db/client');

const QUEUE_NAME = 'bot-jobs';

let _queue = null;

function _getQueue() {
    if (!_queue) {
        _queue = new Queue(QUEUE_NAME, {
            connection: getRedis(),
            defaultJobOptions: { removeOnComplete: 50, removeOnFail: 50 },
        });
    }
    return _queue;
}

/**
 * Enqueue a bot-start job.
 * API keys are passed in-memory (never written to queue storage —
 * BullMQ persists job data in Redis, so keys are temporarily in Redis
 * encrypted at rest if Redis auth is configured).
 */
async function startBot({ instanceId, userId, configJson, apiKey, apiSecret }) {
    const q = _getQueue();
    await q.add(
        'start',
        { instanceId, userId, configJson, apiKey, apiSecret },
        { jobId: `start-${instanceId}` }
    );
}

/**
 * Signal the worker to stop this bot instance via Redis pub/sub.
 * The stop channel is watched by the worker running that instance.
 */
async function stopBot(instanceId) {
    const redis = getRedis();
    await redis.publish(`bot:stop:${instanceId}`, '1');
}

/**
 * Update bot_instance status in DB.
 * Called by orchestrator and workers.
 */
async function setInstanceStatus(instanceId, status, extra = {}) {
    const fields = ['status = $2'];
    const values = [instanceId, status];
    let idx = 3;

    if (extra.stopReason !== undefined) { fields.push(`stop_reason = $${idx++}`); values.push(extra.stopReason); }
    if (extra.jobId !== undefined) { fields.push(`job_id = $${idx++}`); values.push(extra.jobId); }
    if (status === 'running') { fields.push(`started_at = NOW()`); }
    if (['stopped', 'error', 'circuit_breaker'].includes(status)) { fields.push(`stopped_at = NOW()`); }

    await db.query(
        `UPDATE bot_instances SET ${fields.join(', ')} WHERE id = $1`,
        values
    );
}

/**
 * Insert a metrics snapshot row.
 */
async function saveMetrics(instanceId, userId, snap) {
    await db.query(
        `INSERT INTO bot_metrics
            (instance_id, user_id, realized_pnl, hourly_pnl, max_drawdown,
             inventory, fill_rate, quotes_placed, fills, adverse_fill_ratio, regime)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
            instanceId, userId,
            snap.realizedPnl ?? 0,
            snap.hourlyPnl ?? 0,
            snap.maxDrawdown ?? 0,
            snap.inventory ?? 0,
            snap.fillRate ?? 0,
            snap.quotesPlaced ?? 0,
            snap.fills ?? 0,
            snap.adverseFillRatio ?? 0,
            snap.regime ?? null,
        ]
    );
}

/** Get the latest metrics snapshot for an instance. */
async function getLatestMetrics(instanceId) {
    const { rows } = await db.query(
        `SELECT * FROM bot_metrics
         WHERE instance_id = $1
         ORDER BY recorded_at DESC LIMIT 1`,
        [instanceId]
    );
    return rows[0] || null;
}

/** Get the currently running instance for a user (at most one). */
async function getRunningInstance(userId) {
    const { rows } = await db.query(
        `SELECT * FROM bot_instances
         WHERE user_id = $1 AND status IN ('pending','running')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

async function close() {
    if (_queue) { await _queue.close(); _queue = null; }
}

module.exports = {
    startBot,
    stopBot,
    setInstanceStatus,
    saveMetrics,
    getLatestMetrics,
    getRunningInstance,
    close,
};
