'use strict';

/**
 * T4 – Circuit Breaker (SVG top-most check, runs before EVERY loop iteration)
 *
 * Triggers SHUTDOWN when:
 *   - daily_loss > dailyLossLimit   (cumulative loss in quote currency, resets at midnight)
 *   - consecutiveLoss > consecutiveLossLimit  (losing trades in a row)
 */
class CircuitBreaker {
    /**
     * @param {object} config
     * @param {number} config.dailyLossLimit        – USDT max daily loss
     * @param {number} config.consecutiveLossLimit  – max consecutive losing fills
     */
    constructor(config) {
        this.dailyLossLimit = config.dailyLossLimit;
        this.consecutiveLossLimit = config.consecutiveLossLimit;

        this.dailyLoss = 0;
        this.consecutiveLoss = 0;
        this._dayStart = this._todayMidnight();
        this._triggered = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Record the PnL result of a fill.
     * Must be called AFTER each confirmed fill so the breaker stays current.
     * @param {number} pnl – positive = profit, negative = loss (quote currency)
     */
    recordFill(pnl) {
        this._rolloverDayIfNeeded();
        if (pnl < 0) {
            this.dailyLoss += Math.abs(pnl);
            this.consecutiveLoss++;
        } else {
            this.consecutiveLoss = 0; // profit resets the streak
        }
    }

    /**
     * Run the T4 check.
     * @returns {{ ok: boolean, reason?: string, value?: number }}
     */
    check() {
        this._rolloverDayIfNeeded();

        if (this._triggered) {
            return { ok: false, reason: 'already_triggered' };
        }

        if (this.dailyLoss > this.dailyLossLimit) {
            this._triggered = true;
            return {
                ok: false,
                reason: 'daily_loss_limit',
                value: this.dailyLoss,
            };
        }

        if (this.consecutiveLoss > this.consecutiveLossLimit) {
            this._triggered = true;
            return {
                ok: false,
                reason: 'consecutive_loss',
                value: this.consecutiveLoss,
            };
        }

        return { ok: true };
    }

    /** True if breaker has been permanently triggered this session. */
    isTriggered() {
        return this._triggered;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _todayMidnight() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    _rolloverDayIfNeeded() {
        const todayMs = this._todayMidnight();
        if (todayMs > this._dayStart) {
            this.dailyLoss = 0;
            this._dayStart = todayMs;
            // Do NOT reset consecutive loss – a losing streak spans midnight
        }
    }
}

module.exports = CircuitBreaker;
