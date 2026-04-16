'use strict';
/**
 * botWorker.js — BullMQ Worker process.
 *
 * Runs as a standalone process (pm2 ecosystem "worker" app).
 * Picks up 'start' jobs from the queue, forks botRunner.js per user,
 * relays metrics to the API via Redis pub/sub, and handles stop signals.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const { Worker } = require('bullmq');
const { fork } = require('child_process');
const { getRedis, getSubscriber } = require('../services/redisClient');
const orchestrator = require('../services/orchestratorService');
const telegram = require('../services/telegramService');

const QUEUE_NAME = 'bot-jobs';
const RUNNER_PATH = path.join(__dirname, 'botRunner.js');

// Map: instanceId → { child, userId }
const _procs = new Map();

// Throttle metrics Telegram notifications (30 min per user)
const _lastTgMetrics = new Map();   // userId → timestamp
const TG_METRICS_INTERVAL_MS = 30 * 60 * 1000;

// ── Stop-signal subscriber ────────────────────────────────────────────────────
// API publishes to 'bot:stop:<instanceId>' → worker sends SIGTERM to child
const sub = getSubscriber();
sub.psubscribe('bot:stop:*', (err) => {
    if (err) console.error('[Worker] psubscribe error:', err.message);
});
sub.on('pmessage', (_pattern, channel, _msg) => {
    const instanceId = channel.replace('bot:stop:', '');
    const proc = _procs.get(instanceId);
    if (proc) {
        console.log(`[Worker] Sending SIGTERM to bot ${instanceId}`);
        proc.child.kill('SIGTERM');
    }
});

// ── BullMQ Worker ─────────────────────────────────────────────────────────────
const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
        if (job.name !== 'start') return;
        const { instanceId, userId, configJson, apiKey, apiSecret } = job.data;

        if (_procs.has(instanceId)) {
            console.log(`[Worker] Bot ${instanceId} already running, skipping`);
            return;
        }

        console.log(`[Worker] Starting bot ${instanceId} for user ${userId}`);

        // Fork botRunner with secrets in env (never in args / command line)
        const child = fork(RUNNER_PATH, [], {
            env: {
                ...process.env,
                BOT_INSTANCE_ID: instanceId,
                BOT_USER_ID: userId,
                BOT_CONFIG: JSON.stringify(configJson),
                BOT_API_KEY: apiKey,
                BOT_API_SECRET: apiSecret,
            },
            silent: false,  // inherit stdout/stderr → appears in PM2 logs
        });

        _procs.set(instanceId, { child, userId });

        // ── IPC messages from botRunner ────────────────────────────────────────
        child.on('message', async (msg) => {
            if (!msg || !msg.type) return;

            const redis = getRedis();

            if (msg.type === 'ready') {
                await orchestrator.setInstanceStatus(instanceId, 'running', { jobId: String(job.id) });
                console.log(`[Worker] Bot ${instanceId} is running`);
                telegram.notifyBotStarted(userId, {
                    symbol: configJson.SYMBOL || 'BTC/USDT:USDT',
                    riskLevel: configJson.RISK_LEVEL || 'custom',
                    capital: configJson.CAPITAL_USDT || '?',
                }).catch(() => { });
            }

            if (msg.type === 'metrics') {
                // Write to DB (non-blocking)
                orchestrator.saveMetrics(instanceId, userId, msg.data).catch(e =>
                    console.error('[Worker] saveMetrics error:', e.message)
                );
                // Broadcast to API layer via Redis pub/sub
                redis.publish(`bot:metrics:${userId}`, JSON.stringify({
                    instanceId,
                    ...msg.data,
                })).catch(() => { });
            }

            if (msg.type === 'stopped') {
                const reason = msg.reason || 'unknown';
                const status = reason === 'user_stop' ? 'stopped' : 'circuit_breaker';
                await orchestrator.setInstanceStatus(instanceId, status, { stopReason: reason });
                console.log(`[Worker] Bot ${instanceId} stopped (${reason})`);
            }

            if (msg.type === 'error') {
                console.error(`[Worker] Bot ${instanceId} error: ${msg.error}`);
            }
        });

        // ── Child process exit ─────────────────────────────────────────────────
        child.on('exit', async (code, signal) => {
            _procs.delete(instanceId);
            const currentStatus = code === 0 ? 'stopped' : 'error';

            // Only update if not already set by IPC 'stopped' message
            try {
                await orchestrator.setInstanceStatus(instanceId, currentStatus, {
                    stopReason: signal || (code !== 0 ? `exit_code_${code}` : 'clean_exit'),
                });
            } catch (_) { }

            // Notify frontends via Redis
            getRedis().publish(`bot:metrics:${userId}`, JSON.stringify({
                instanceId,
                status: currentStatus,
            })).catch(() => { });

            console.log(`[Worker] Child ${instanceId} exited (code=${code}, signal=${signal})`);
        });

        child.on('error', (err) => {
            console.error(`[Worker] Failed to fork bot ${instanceId}:`, err.message);
            _procs.delete(instanceId);
        });
    },
    {
        connection: getRedis(),
        concurrency: 50,  // max 50 simultaneous bots per worker process
    }
);

worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
    if (job?.data?.instanceId) {
        orchestrator.setInstanceStatus(job.data.instanceId, 'error', { stopReason: err.message })
            .catch(() => { });
    }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
    console.log(`[Worker] ${signal} received – stopping all bots gracefully`);

    // Signal all active children
    for (const [id, { child }] of _procs.entries()) {
        console.log(`[Worker] Stopping child ${id}`);
        child.kill('SIGTERM');
    }

    // Give children 5s to clean up
    await new Promise(r => setTimeout(r, 5000));

    await worker.close();
    await sub.quit();
    console.log('[Worker] Shutdown complete');
    process.exit(0);
}
// Throttled Telegram metrics digest (every 30 min)
const lastSent = _lastTgMetrics.get(userId) || 0;
if (Date.now() - lastSent > TG_METRICS_INTERVAL_MS) {
    _lastTgMetrics.set(userId, Date.now());
    telegram.notifyMetrics(userId, msg.data).catch(() => { });
}
telegram.notifyBotStopped(userId, {
    reason,
    symbol: configJson.SYMBOL || 'BTC/USDT:USDT',
}).catch(() => { });
telegram.notifyBotError(userId, msg.error).catch(() => { });

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[Worker] BullMQ worker started, waiting for jobs…');
