'use strict';
/**
 * botRunner.js — Runs as a child_process.fork() target.
 *
 * Receives all configuration via environment variables set by the worker:
 *   BOT_INSTANCE_ID, BOT_USER_ID, BOT_CONFIG (JSON), BOT_API_KEY, BOT_API_SECRET
 *
 * Sends metrics to the parent worker process every METRICS_INTERVAL_MS via process.send().
 * Calls process.exit() cleanly so the worker can update instance status.
 */

const path = require('path');

// Load .env from the saas/api root (for ENCRYPTION_KEY etc.)
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// ── Read configuration from env (set by worker before fork) ─────────────────
const instanceId = process.env.BOT_INSTANCE_ID;
const userId = process.env.BOT_USER_ID;
const apiKey = process.env.BOT_API_KEY;
const apiSecret = process.env.BOT_API_SECRET;
let botConfig;

try {
    botConfig = JSON.parse(process.env.BOT_CONFIG);
} catch (e) {
    process.send({ type: 'error', error: 'Invalid BOT_CONFIG JSON' });
    process.exit(1);
}

// ── Scrub secrets from env immediately after reading ────────────────────────
delete process.env.BOT_API_KEY;
delete process.env.BOT_API_SECRET;

// ── Import from core MM bot (relative to project root) ───────────────────────
const botRoot = path.join(__dirname, '../../../../');  // mm bot/
const { createExchange } = require(path.join(botRoot, 'src/exchange/ExchangeFactory'));
const MarketMaker = require(path.join(botRoot, 'src/core/MarketMaker'));

// ── Build the exchange + full bot config ─────────────────────────────────────
const exchangeConfig = {
    name: botConfig.EXCHANGE || 'bingx',
    apiKey: apiKey,
    secret: apiSecret,
    testnet: botConfig.TESTNET === 'true',
    marketType: botConfig.MARKET_TYPE || 'swap',
    positionMode: botConfig.POSITION_MODE || 'oneway',
};

// Map flat env-var style config (from configService) → nested bot config
function buildBotConfig(flat) {
    return {
        exchange: exchangeConfig,
        symbol: flat.SYMBOL || 'BTC/USDT:USDT',
        spread: {
            baseFraction: parseFloat(flat.BASE_SPREAD) || 0.002,
            fee: parseFloat(flat.FEE) || 0.001,
            volLookback: parseInt(flat.VOL_LOOKBACK, 10) || 20,
            volMultiplier: parseFloat(flat.VOL_MULTIPLIER) || 3,
            volSqBoost: parseFloat(flat.VOL_SQ_BOOST) || 0,
        },
        imbalance: {
            enabled: flat.IMBALANCE_ENABLED !== 'false',
            factor: parseFloat(flat.IMBALANCE_FACTOR) || 0.003,
        },
        dynamicSpread: {
            enabled: flat.DYNAMIC_SPREAD_ENABLED !== 'false',
            minMultiplier: parseFloat(flat.SPREAD_MIN_MULT) || 0.5,
            maxMultiplier: parseFloat(flat.SPREAD_MAX_MULT) || 3.0,
            maxSpreadFraction: parseFloat(flat.SPREAD_MAX_FRACTION) || 0.05,
            regimeMultiplier: {
                trending_up: parseFloat(flat.SPREAD_MULT_TREND_UP) || 1.5,
                trending_down: parseFloat(flat.SPREAD_MULT_TREND_DOWN) || 1.5,
                ranging: parseFloat(flat.SPREAD_MULT_RANGING) || 1.0,
                volatile: parseFloat(flat.SPREAD_MULT_VOLATILE) || 2.0,
            },
        },
        quoting: {
            levels: parseInt(flat.QUOTE_LEVELS, 10) || 3,
            spreadMultipliers: [1.0, 1.5, 2.0],
            sizeFractions: [0.5, 0.3, 0.2],
            skewSteepness: parseFloat(flat.SKEW_STEEPNESS) || 1.5,
        },
        adaptiveTiming: {
            enabled: flat.ADAPTIVE_TIMING_ENABLED !== 'false',
            minIntervalMs: parseInt(flat.TIMING_MIN_INTERVAL_MS, 10) || 500,
            maxIntervalMs: parseInt(flat.TIMING_MAX_INTERVAL_MS, 10) || 5000,
            fillPollMsVolatile: parseInt(flat.TIMING_FILL_POLL_FAST_MS, 10) || 250,
            fillPollMsQuiet: parseInt(flat.TIMING_FILL_POLL_SLOW_MS, 10) || 1000,
            volThresholdHigh: parseFloat(flat.TIMING_VOL_HIGH) || 0.005,
            volThresholdLow: parseFloat(flat.TIMING_VOL_LOW) || 0.001,
        },
        regime: {
            enabled: flat.REGIME_ENABLED !== 'false',
            momentumWindow: parseInt(flat.REGIME_MOMENTUM_WINDOW, 10) || 10,
            trendThreshold: parseFloat(flat.REGIME_TREND_THRESHOLD) || 0.002,
            volatileThreshold: parseFloat(flat.REGIME_VOLATILE_THRESHOLD) || 0.006,
        },
        regimeFilter: {
            enabled: flat.REGIME_FILTER_ENABLED !== 'false',
            maxMove1m: parseFloat(flat.REGIME_FILTER_MAX_MOVE) || 0.01,
            pauseMs: parseInt(flat.REGIME_FILTER_PAUSE_MS, 10) || 45000,
            intraCycleMaxMove: parseFloat(flat.INTRA_CYCLE_MAX_MOVE) || 0.003,
        },
        latency: {
            enabled: flat.LATENCY_PROTECTION_ENABLED !== 'false',
            cancelThreshold: parseFloat(flat.LATENCY_CANCEL_THRESHOLD) || 0.001,
        },
        inventory: {
            softMax: parseFloat(flat.SOFT_MAX) || 0.003,
            hardMax: parseFloat(flat.HARD_MAX) || 0.006,
            skewFactor: parseFloat(flat.SKEW_FACTOR) || 0.3,
            sizeFactor: parseFloat(flat.SIZE_FACTOR) || 0.8,
            baseSize: parseFloat(flat.BASE_SIZE) || 0.001,
            minOrderSize: parseFloat(flat.MIN_ORDER_SIZE) || 0.001,
            decayGamma: parseFloat(flat.INVENTORY_DECAY_GAMMA) || 0,
        },
        inventoryVaR: {
            enabled: flat.INV_VAR_ENABLED === 'true',
            capital: parseFloat(flat.CAPITAL_USDT) || 1000,
            varMultiplier: parseFloat(flat.VAR_MULTIPLIER) || 100,
        },
        risk: {
            dailyLossLimit: parseFloat(flat.DAILY_LOSS_LIMIT) || 20,
            consecutiveLossLimit: parseInt(flat.CONSECUTIVE_LOSS_LIMIT, 10) || 8,
            adverseFillThreshold: parseFloat(flat.ADVERSE_FILL_THRESHOLD) || 0.6,
            adverseFillWindow: parseInt(flat.ADVERSE_FILL_WINDOW, 10) || 20,
            unrealizedLossLimit: parseFloat(flat.UNREALIZED_LOSS_LIMIT) || Infinity,
        },
        hedging: {
            preferLimit: flat.HEDGE_PREFER_LIMIT !== 'false',
            limitTimeoutMs: parseInt(flat.HEDGE_LIMIT_TIMEOUT_MS, 10) || 2000,
        },
        flow: {
            enabled: flat.FLOW_ENABLED !== 'false',
            emaAlpha: parseFloat(flat.FLOW_EMA_ALPHA) || 0.2,
            kappa: parseFloat(flat.FLOW_KAPPA) || 0.0002,
        },
        invSpread: { k: parseFloat(flat.INV_SPREAD_K) || 0 },
        dynSize: {
            enabled: flat.DYN_SIZE_ENABLED === 'true',
            targetVol: parseFloat(flat.DYN_SIZE_TARGET_VOL) || 0.001,
            minMult: parseFloat(flat.DYN_SIZE_MIN_MULT) || 0.5,
            maxMult: parseFloat(flat.DYN_SIZE_MAX_MULT) || 2.0,
            invCouplingAlpha: parseFloat(flat.DYN_SIZE_INV_COUPLING) || 0,
        },
        fundingBias: {
            enabled: flat.FUNDING_BIAS_ENABLED === 'true',
            k: parseFloat(flat.FUNDING_BIAS_K) || 0.5,
            fetchIntervalMs: parseInt(flat.FUNDING_BIAS_FETCH_INTERVAL_MS, 10) || 60000,
        },
        toxicFlow: {
            enabled: flat.TOXIC_FLOW_ENABLED === 'true',
            sideRatio: parseFloat(flat.TOXIC_SIDE_RATIO) || 0.82,
            vwapThreshold: parseFloat(flat.TOXIC_VWAP_THRESHOLD) || 0.0004,
            pauseMs: parseInt(flat.TOXIC_PAUSE_MS, 10) || 3000,
        },
        fillRateFeedback: {
            enabled: flat.FILL_RATE_FEEDBACK_ENABLED === 'true',
            lambda: parseFloat(flat.FILL_RATE_LAMBDA) || 0.3,
            target: parseFloat(flat.FILL_RATE_TARGET) || 0.3,
            minMult: parseFloat(flat.FILL_RATE_MIN_MULT) || 0.7,
            maxMult: parseFloat(flat.FILL_RATE_MAX_MULT) || 1.5,
        },
        requote: {
            priceThreshold: parseFloat(flat.REQUOTE_PRICE_THRESHOLD) || 0.0002,
            spreadChangeThreshold: parseFloat(flat.REQUOTE_SPREAD_THRESHOLD) || 0.0001,
            minCancelIntervalMs: parseInt(flat.REQUOTE_MIN_CANCEL_MS, 10) || 5000,
            maxCancelPerMin: parseInt(flat.REQUOTE_MAX_CANCEL_PM, 10) || 20,
            maxOrderAgeMs: parseInt(flat.REQUOTE_MAX_ORDER_AGE_MS, 10) || 120000,
            queueDepthBps: parseFloat(flat.REQUOTE_QUEUE_DEPTH_BPS) || 0,
        },
        loop: {
            intervalMs: parseInt(flat.LOOP_INTERVAL_MS, 10) || 5000,
            fillPollMs: parseInt(flat.FILL_POLL_MS, 10) || 1000,
        },
        alert: {
            telegram: {
                // Platform bot token from server env; user's chat_id injected per-instance
                botToken: process.env.TELEGRAM_BOT_TOKEN || null,
                chatId: flat.TELEGRAM_CHAT_ID || null,
                metricsIntervalMs: 30 * 60 * 1000,
            },
        },
        timeOfDay: { enabled: false },
        smartKill: {
            enabled: flat.SMART_KILL_ENABLED === 'true',
            volThreshold: parseFloat(flat.SMART_KILL_VOL_THRESHOLD) || 0.008,
            fillRateMin: parseFloat(flat.SMART_KILL_FILL_RATE_MIN) || 0.001,
            minQuotes: parseInt(flat.SMART_KILL_MIN_QUOTES, 10) || 200,
        },
    };
}

// ── Start ─────────────────────────────────────────────────────────────────────
let bot = null;
const METRICS_INTERVAL_MS = 5000;

async function main() {
    const exchange = createExchange(exchangeConfig);
    const fullConfig = buildBotConfig(botConfig);
    bot = new MarketMaker(exchange, fullConfig);

    // Notify parent that the process is alive
    process.send({ type: 'ready', instanceId });

    // Periodic metrics push to parent
    const metricsTimer = setInterval(() => {
        if (!bot) return;
        try {
            const snap = bot.metrics.getSnapshot();
            process.send({
                type: 'metrics',
                instanceId,
                userId,
                data: {
                    realizedPnl: snap.realizedPnl,
                    hourlyPnl: snap.hourlyPnl,
                    maxDrawdown: snap.maxDrawdown,
                    inventory: bot.inventory.getInventory(),
                    fillRate: snap.fillRate,
                    quotesPlaced: snap.quotesPlaced,
                    fills: snap.fills,
                    adverseFillRatio: snap.adverseFillRatio,
                    regime: snap.regime,
                    status: 'running',
                },
            });
        } catch (_) { /* ignore during shutdown */ }
    }, METRICS_INTERVAL_MS);

    // Graceful stop on SIGTERM (sent by worker on user stop command)
    process.on('SIGTERM', () => {
        clearInterval(metricsTimer);
        if (bot) bot.stop();
        process.send({ type: 'stopped', instanceId, reason: 'user_stop' });
        setTimeout(() => process.exit(0), 1500);
    });

    process.on('uncaughtException', (err) => {
        process.send({ type: 'error', instanceId, error: err.message });
        clearInterval(metricsTimer);
        setTimeout(() => process.exit(1), 500);
    });

    await bot.start();  // blocks until running = false (shutdown)

    clearInterval(metricsTimer);
    process.send({ type: 'stopped', instanceId, reason: 'circuit_breaker' });
    // process.exit(0) is called by MarketMaker._shutdown() after 500ms
}

main().catch(err => {
    process.send && process.send({ type: 'error', instanceId, error: err.message });
    process.exit(1);
});
