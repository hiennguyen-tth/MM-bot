'use strict';

const { stdDev } = require('../utils/math');

/**
 * Detects current market regime from price history.
 *
 * Regimes:
 *   'trending_up'   – consistent upward momentum (price rising steadily)
 *   'trending_down' – consistent downward momentum
 *   'volatile'      – high std-dev, no clear direction (noisy / choppy)
 *   'ranging'       – low vol, mean-reverting sideways market (default)
 *
 * How it works:
 *   1. If vol > volatileThreshold → 'volatile'  (overrides trend check)
 *   2. momentum = (last − first) / first  over a window of prices
 *      If |momentum| > trendThreshold → 'trending_up' or 'trending_down'
 *   3. Otherwise → 'ranging'
 *
 * Usage tip:
 *   Feed the same priceHistory as SpreadEngine (last N trade prices).
 *   Call detect() after SpreadEngine.compute() so vol is already known.
 */
class RegimeDetector {
    /**
     * @param {object} config
     * @param {boolean} config.enabled          – if false, always 'ranging'
     * @param {number}  config.momentumWindow   – how many prices for momentum
     * @param {number}  config.trendThreshold   – fraction for trend detection
     * @param {number}  config.volatileThreshold – vol (std/mid) above = volatile
     */
    constructor(config) {
        this.enabled = config.enabled !== false;
        this.momentumWindow = config.momentumWindow || 10;
        this.trendThreshold = config.trendThreshold || 0.002;
        this.volatileThreshold = config.volatileThreshold || 0.006;

        this._current = 'ranging';
    }

    /**
     * Detect regime given a price history array and current vol.
     *
     * @param {number[]} priceHistory – recent prices (newest = last element)
     * @param {number}   vol          – current vol = stdDev / mid (from SpreadEngine)
     * @returns {'ranging'|'volatile'|'trending_up'|'trending_down'}
     */
    detect(priceHistory, vol) {
        if (!this.enabled || priceHistory.length < 2) {
            return (this._current = 'ranging');
        }

        // 1. Volatile check (highest priority)
        if (vol >= this.volatileThreshold) {
            return (this._current = 'volatile');
        }

        // 2. Momentum check
        const window = Math.min(this.momentumWindow, priceHistory.length);
        const windowPrices = priceHistory.slice(-window);
        const first = windowPrices[0];
        const last = windowPrices[windowPrices.length - 1];

        if (first === 0) return (this._current = 'ranging');

        const momentum = (last - first) / first;

        if (momentum > this.trendThreshold) {
            return (this._current = 'trending_up');
        }
        if (momentum < -this.trendThreshold) {
            return (this._current = 'trending_down');
        }

        // 3. Default
        return (this._current = 'ranging');
    }

    /** Last detected regime (cached between calls). */
    current() {
        return this._current;
    }
}

module.exports = RegimeDetector;
