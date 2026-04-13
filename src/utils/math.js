'use strict';

/**
 * Standard deviation of an array of numbers.
 * Used for volatility: vol = std(last_20_prices) / mid
 */
function stdDev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance =
        values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

/**
 * Clamp a number within [min, max].
 * Used for inventory ratio: ratio ∈ [-1, +1]
 */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Round to N decimal places (avoids floating point drift in order prices).
 */
function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

module.exports = { stdDev, clamp, roundTo };
