'use strict';

/**
 * Tracks all runtime metrics required by the strategy spec (SVG):
 *   - Fill rate       : fills / quotes placed
 *   - Spread captured : avg profit per fill
 *   - Inventory drift : avg |inventory| / max
 *   - Realized PnL    : cumulative (also tracked hourly)
 *   - Max drawdown    : peak → trough PnL
 *   - Adverse fill ratio : fills where price moved against us after fill
 */
class MetricsCollector {
    constructor() {
        this._reset();
    }

    _reset() {
        this.quotesPlaced = 0;
        this.fills = 0;
        this.spreadCaptured = []; // profit per fill (FIFO, bounded by adverseFillWindow)
        this.inventorySnapshots = []; // |inventory| / max ratio at each fill
        this.realizedPnl = 0;
        this.peakPnl = 0;
        this.maxDrawdown = 0;

        // Adverse fill tracking (rolling window)
        this.fillEvents = []; // { isAdverse } – bounded list
        this.adverseFillWindow = 20;

        // Hourly PnL tracking
        this._hourlyPnlBase = 0;
        this._hourlyStart = Date.now();
    }

    /** Call each time we place a quote (one call per side). */
    recordQuote() {
        this.quotesPlaced++;
    }

    /**
     * Call each time a fill (partial or full) is detected.
     * @param {object} p
     * @param {number} p.profit       - Spread profit captured on this fill (quote currency)
     * @param {number} p.inventoryAbs - |inventory| after this fill
     * @param {number} p.inventoryMax - softMax for normalisation
     * @param {boolean} p.isAdverse   - True if price moved against us post-fill
     */
    recordFill({ profit, inventoryAbs, inventoryMax, isAdverse }) {
        this.fills++;

        this.spreadCaptured.push(profit);

        const drift = inventoryMax > 0 ? inventoryAbs / inventoryMax : 0;
        this.inventorySnapshots.push(drift);

        this.realizedPnl += profit;

        // Max drawdown
        if (this.realizedPnl > this.peakPnl) {
            this.peakPnl = this.realizedPnl;
        }
        const drawdown = this.peakPnl - this.realizedPnl;
        if (drawdown > this.maxDrawdown) {
            this.maxDrawdown = drawdown;
        }

        // Rolling adverse fill window
        this.fillEvents.push({ isAdverse });
        if (this.fillEvents.length > this.adverseFillWindow) {
            this.fillEvents.shift();
        }
    }

    // ── Computed metrics ─────────────────────────────────────────────────────

    getFillRate() {
        return this.quotesPlaced === 0 ? 0 : this.fills / this.quotesPlaced;
    }

    getAvgSpreadCaptured() {
        if (this.spreadCaptured.length === 0) return 0;
        return (
            this.spreadCaptured.reduce((a, b) => a + b, 0) /
            this.spreadCaptured.length
        );
    }

    getAvgInventoryDrift() {
        if (this.inventorySnapshots.length === 0) return 0;
        return (
            this.inventorySnapshots.reduce((a, b) => a + b, 0) /
            this.inventorySnapshots.length
        );
    }

    getAdverseFillRatio() {
        if (this.fillEvents.length === 0) return 0;
        const adverseCount = this.fillEvents.filter((e) => e.isAdverse).length;
        return adverseCount / this.fillEvents.length;
    }

    /** Returns a plain snapshot object for logging. */
    getSnapshot() {
        const now = Date.now();
        const hourlyPnl = this.realizedPnl - this._hourlyPnlBase;

        // Reset hourly baseline every 60 minutes
        if (now - this._hourlyStart >= 3_600_000) {
            this._hourlyPnlBase = this.realizedPnl;
            this._hourlyStart = now;
        }

        return {
            quotesPlaced: this.quotesPlaced,
            fills: this.fills,
            fillRate: this.getFillRate().toFixed(4),
            avgSpreadCaptured: this.getAvgSpreadCaptured().toFixed(8),
            avgInventoryDrift: this.getAvgInventoryDrift().toFixed(4),
            realizedPnl: this.realizedPnl.toFixed(8),
            hourlyPnl: hourlyPnl.toFixed(8),
            maxDrawdown: this.maxDrawdown.toFixed(8),
            adverseFillRatio: this.getAdverseFillRatio().toFixed(4),
        };
    }
}

module.exports = MetricsCollector;
