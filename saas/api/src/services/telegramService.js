'use strict';
/**
 * telegramService.js — SaaS-level Telegram notification service.
 *
 * Architecture:
 *   - Platform owns ONE Telegram bot (TELEGRAM_BOT_TOKEN in server env).
 *   - Each user registers their own chat_id via PUT /auth/telegram.
 *   - This service looks up the user's chat_id from DB and sends messages.
 *
 * This is separate from the per-bot TelegramAlert (which handles immediate
 * circuit-breaker alerts from inside the bot process). This service handles
 * SaaS-level events: bot started, bot stopped, periodic metrics digest.
 *
 * Setup for users:
 *   1. User starts a chat with your bot on Telegram (@YourBotUsername)
 *   2. User sends any message to the bot
 *   3. User goes to: https://api.telegram.org/bot<TOKEN>/getUpdates → copy chat.id
 *   4. User calls PUT /auth/telegram  { "chatId": "<their_chat_id>" }
 */

const path = require('path');
const db = require('../db/client');

// Reuse the core TelegramAlert sender (pure HTTPS, no logger deps)
const BOT_ROOT = path.join(__dirname, '../../../../');
const TelegramAlert = require(path.join(BOT_ROOT, 'src/alerts/TelegramAlert'));

// Lazy singleton — created once when first needed
let _alert = null;

function _getAlert() {
    if (!_alert) {
        _alert = new TelegramAlert({
            botToken: process.env.TELEGRAM_BOT_TOKEN || null,
            chatId: '__placeholder__',  // overridden per call
            metricsIntervalMs: Infinity,           // throttle handled externally
        });
    }
    return _alert;
}

/** Fetch user's telegram_chat_id from DB. Returns null if not configured. */
async function _getChatId(userId) {
    const { rows } = await db.query(
        'SELECT telegram_chat_id FROM users WHERE id = $1',
        [userId]
    );
    return rows[0]?.telegram_chat_id || null;
}

/**
 * Send an arbitrary text message to a user.
 * No-op if user hasn't configured a chat_id or platform bot token is missing.
 */
async function sendToUser(userId, text) {
    try {
        const chatId = await _getChatId(userId);
        if (!chatId) return;
        const alert = _getAlert();
        if (!alert._token) return;

        alert._chatId = chatId;
        await alert.send(text);
    } catch (err) {
        // Never throw — notification failure must not affect the bot
        console.error('[telegram] sendToUser error:', err.message);
    }
}

// ── Notification helpers ──────────────────────────────────────────────────────

async function notifyBotStarted(userId, { symbol, riskLevel, capital }) {
    await sendToUser(
        userId,
        `✅ *Bot Started*\n` +
        `Symbol: \`${symbol}\`\n` +
        `Risk: \`${riskLevel}\` | Capital: \`${capital} USDT\``
    );
}

async function notifyBotStopped(userId, { reason, symbol }) {
    const emoji = reason === 'circuit_breaker' ? '🛑' : '⏹';
    const label = reason === 'circuit_breaker'
        ? 'Circuit breaker triggered (daily loss limit)'
        : reason === 'user_stop' ? 'Stopped by user' : reason;
    await sendToUser(
        userId,
        `${emoji} *Bot Stopped*\n` +
        `Symbol: \`${symbol || 'N/A'}\`\n` +
        `Reason: ${label}`
    );
}

async function notifyBotError(userId, errorMsg) {
    await sendToUser(userId, `🚨 *Bot Error*\n\`${errorMsg}\``);
}

async function notifyMetrics(userId, metrics) {
    const pnl = Number(metrics.realizedPnl ?? 0).toFixed(4);
    const dd = Number(metrics.maxDrawdown ?? 0).toFixed(4);
    const hr = Number(metrics.hourlyPnl ?? 0).toFixed(4);
    const fr = Number(metrics.fillRate ?? 0).toFixed(4);
    const pnlEmoji = Number(pnl) >= 0 ? '📈' : '📉';

    await sendToUser(
        userId,
        `${pnlEmoji} *Metrics Update*\n` +
        `PnL (total): \`${pnl} USDT\`\n` +
        `PnL (hourly): \`${hr} USDT\`\n` +
        `Max Drawdown: \`${dd} USDT\`\n` +
        `Fill Rate: ${fr}\n` +
        `Regime: ${metrics.regime ?? 'n/a'}`
    );
}

module.exports = {
    sendToUser,
    notifyBotStarted,
    notifyBotStopped,
    notifyBotError,
    notifyMetrics,
};
