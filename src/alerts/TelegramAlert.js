'use strict';

const https = require('https');
const logger = require('../metrics/Logger');

/**
 * Telegram alert service – replaces webhook-based alerts.
 *
 * Setup:
 *   1. Tạo bot tại @BotFather trên Telegram → lấy BOT_TOKEN
 *   2. Nhắn bất kỳ gì cho bot → vào https://api.telegram.org/bot<TOKEN>/getUpdates → lấy chat_id
 *   3. Điền vào .env:
 *        TELEGRAM_BOT_TOKEN=<token>
 *        TELEGRAM_CHAT_ID=<chat_id>
 *
 * Messages sent:
 *   - Shutdown alerts  (ngay lập tức khi circuit breaker kích hoạt)
 *   - Periodic metrics (theo TELEGRAM_METRICS_INTERVAL_MS, mặc định 30 phút)
 *
 * No-op khi token/chatId chưa được config.
 */
class TelegramAlert {
    /**
     * @param {object} cfg
     * @param {string|null} cfg.botToken
     * @param {string|null} cfg.chatId
     * @param {number}      cfg.metricsIntervalMs
     */
    constructor(cfg = {}) {
        this._token = cfg.botToken || null;
        this._chatId = cfg.chatId || null;
        this._metricsIntervalMs = cfg.metricsIntervalMs || 30 * 60 * 1000; // 30 min
        this._lastMetricsSent = 0;
    }

    /** True only when both token and chat_id are configured. */
    _ready() {
        return Boolean(this._token && this._chatId);
    }

    /**
     * Send a raw text message to the configured Telegram chat.
     * Supports Markdown formatting (bold **text**, code `text`).
     * @param {string} text
     * @returns {Promise<void>}
     */
    async send(text) {
        if (!this._ready()) return;

        const body = JSON.stringify({
            chat_id: this._chatId,
            text,
            parse_mode: 'Markdown',
        });

        return new Promise((resolve) => {
            const req = https.request(
                {
                    hostname: 'api.telegram.org',
                    port: 443,
                    path: `/bot${this._token}/sendMessage`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    logger.debug('Telegram alert sent', { status: res.statusCode });
                    resolve();
                }
            );
            req.on('error', (err) => {
                logger.error('Telegram alert failed', { error: err.message });
                resolve(); // never throw – alert failure must not kill the bot
            });
            req.write(body);
            req.end();
        });
    }

    /**
     * Send a shutdown alert immediately.
     * Called when the circuit breaker fires (T4).
     * @param {string} reason  – e.g. 'daily_loss_limit'
     * @param {number} value   – triggering value
     * @param {object} metrics – snapshot from MetricsCollector.getSnapshot()
     */
    async sendShutdown(reason, value, metrics) {
        const text =
            `🚨 *MM BOT SHUTDOWN*\n` +
            `Reason: \`${reason}\` (${value})\n` +
            `PnL: \`${metrics.realizedPnl}\` USDT\n` +
            `DrawDown: \`${metrics.maxDrawdown}\` USDT\n` +
            `Fills: ${metrics.fills} | Adverse: ${metrics.adverseFillRatio}`;
        await this.send(text);
    }

    /**
     * Send a plain alert message immediately (no throttle).
     * @param {string} text
     */
    async maybeSendAlert(text) {
        await this.send(text);
    }

    /**
     * Send a periodic metrics digest if the interval has elapsed.
     * Call this every tick → it is self-throttled.
     * @param {object} metrics – snapshot from MetricsCollector.getSnapshot()
     * @param {string} regime
     */
    async maybeSendMetrics(metrics, regime) {
        if (!this._ready()) return;
        const now = Date.now();
        if (now - this._lastMetricsSent < this._metricsIntervalMs) return;
        this._lastMetricsSent = now;

        const text =
            `📊 *MM Bot – Periodic Report*\n` +
            `PnL (total): \`${metrics.realizedPnl}\` USDT\n` +
            `PnL (hourly): \`${metrics.hourlyPnl}\` USDT\n` +
            `Fill Rate: ${metrics.fillRate} | Fills: ${metrics.fills}\n` +
            `Adverse Ratio: ${metrics.adverseFillRatio}\n` +
            `Max Drawdown: \`${metrics.maxDrawdown}\` USDT\n` +
            `Avg Spread Captured: ${metrics.avgSpreadCaptured}\n` +
            `Regime: ${regime}`;
        await this.send(text);
    }
}

module.exports = TelegramAlert;
