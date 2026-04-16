'use strict';

const { stdDev } = require('../utils/math');

/**
 * Adaptive spread engine v3
 *
 * Spread formula (stacked layers, applied in order):
 *
 *   1. Base vol spread:
 *        vol    = std(last_N prices) / mid
 *        spread = max(2 × fee, baseFraction × (1 + volMultiplier × vol))
 *
 *   2. Imbalance layer (when imbalanceCfg.enabled):
 *        imbalance = (bidVol - askVol) / totalVol  ∈ [-1, 1]
 *        spread    = max(spread, imbalanceFactor × |imbalance|)
 *        → Widens on lopsided books (avoids run-over risk)
 *
 *   3. Dynamic (regime) layer (when dynamic.enabled):
 *        spread *= regimeMultiplier[regime]
 *        spread  = clamp(spread, base × minMult, base × maxMult)
 *        spread  = min(spread, maxSpreadFraction)
 *
 *   4. Adverse-fill layer:
 *        spread *= adverseMultiplier          (set externally; default 1.0)
 *        spread  = min(spread, maxSpreadFraction)
 *        → Adaptive: set to (1 + adverseRatio) instead of fixed 1.5×
 *
 *   5. Fill-rate feedback layer (when fillRateCfg.enabled):
 *        adj    = 1 + λ × (fillRate − target)
 *        spread *= clamp(adj, minMult, maxMult)
 *        → fillRate > target (getting picked off) → widen
 *        → fillRate < target (spread too wide) → tighten toward market
 *
 * Spread is expressed as a fraction of mid price.
 * E.g. spread = 0.003 → bot places bid/ask ±0.15% from mid.
 */
class SpreadEngine {
  /**
   * @param {object} config           – config.spread
   * @param {object} [dynamicConfig]  – config.dynamicSpread (optional)
   * @param {object} [imbalanceCfg]   – config.imbalance (optional)
   * @param {object} [fillRateCfg]    – config.fillRateFeedback (optional)
   */
  constructor(config, dynamicConfig = {}, imbalanceCfg = {}, fillRateCfg = {}) {
    this.fee = config.fee;
    this.baseFraction = config.baseFraction;
    this.volLookback = config.volLookback;
    this.volMultiplier = config.volMultiplier;
    // Additive quadratic vol term: spread += volSqBoost × vol²
    // Disabled by default (0). Risk scales as variance (vol²) is theoretically
    // correct vs linear vol; amplifies spread rapidly at high-vol regimes.
    // Recommend: 100–500 for meaningful effect on BTC/USDT (vol ≈ 0.001–0.005).
    this.volSqBoost = config.volSqBoost || 0;

    this._originalBaseFraction = config.baseFraction;

    this.dynamic = {
      enabled: dynamicConfig.enabled !== false,
      minMultiplier: dynamicConfig.minMultiplier || 0.5,
      maxMultiplier: dynamicConfig.maxMultiplier || 3.0,
      maxSpreadFraction: dynamicConfig.maxSpreadFraction || 0.05,
      regimeMultiplier: Object.assign(
        { trending_up: 1.5, trending_down: 1.5, ranging: 1.0, volatile: 2.0 },
        dynamicConfig.regimeMultiplier || {}
      ),
    };

    this.imbalanceCfg = {
      enabled: imbalanceCfg.enabled !== false,
      factor: imbalanceCfg.factor || 0.003,
    };

    /**
     * Fill-rate feedback layer (Layer 5). Updated externally by MarketMaker:
     *   spreadEngine.fillRate = metrics.getFillRate()   (called before compute())
     * Disabled by default — must explicitly set enabled: true in config.
     */
    this.fillRateCfg = {
      enabled: fillRateCfg.enabled === true,  // opt-in only
      lambda: fillRateCfg.lambda || 0.3,
      target: fillRateCfg.target || 0.3,
      minMult: fillRateCfg.minMult || 0.7,
      maxMult: fillRateCfg.maxMult || 1.5,
    };
    this.fillRate = 0; // updated externally before each compute()

    /**
     * Adverse-fill multiplier. Set externally by MarketMaker:
     *   spreadEngine.adverseMultiplier = 1 + adverseRatio   (adaptive)
     * Reset to 1.0 when ratio normalises.
     */
    this.adverseMultiplier = 1.0;

    this.priceHistory = [];
  }

  addPrice(price) {
    this.priceHistory.push(price);
    if (this.priceHistory.length > this.volLookback) {
      this.priceHistory.shift();
    }
  }

  // Batch variant: fewer shifts, single slice if overflow
  addPriceBatch(prices) {
    for (const p of prices) this.priceHistory.push(p);
    if (this.priceHistory.length > this.volLookback) {
      this.priceHistory = this.priceHistory.slice(-this.volLookback);
    }
  }

  /**
   * Compute adaptive spread.
   *
   * @param {number} mid         – current mid price
   * @param {string} [regime]    – market regime from RegimeDetector
   * @param {number} [imbalance] – orderbook imbalance = (bidVol-askVol)/total ∈[-1,1]
   * @returns {{ spread: number, vol: number, regime: string }}
   */
  compute(mid, regime = 'ranging', imbalance = 0) {
    this.addPrice(mid);

    const vol =
      this.priceHistory.length >= 2
        ? stdDev(this.priceHistory) / mid
        : 0;

    // ── Layer 1: base vol spread ──────────────────────────────────────────────────
    // Linear term: spread = max(2×fee, baseFraction × (1 + volMultiplier × vol))
    // Quadratic boost (when volSqBoost > 0): adds volSqBoost × vol²
    //   At vol=0.001: boost = volSqBoost × 0.000001 (negligible)
    //   At vol=0.003: boost = volSqBoost × 0.000009 (moderate with boost=500: +4.5 bps)
    //   At vol=0.005: boost = volSqBoost × 0.000025 (strong with boost=500: +12.5 bps)
    let spread = Math.max(
      2 * this.fee,
      this.baseFraction * (1 + this.volMultiplier * vol) + this.volSqBoost * vol * vol
    );

    // ── Layer 2: imbalance ────────────────────────────────────────────────────
    if (this.imbalanceCfg.enabled && imbalance !== 0) {
      spread = Math.max(spread, this.imbalanceCfg.factor * Math.abs(imbalance));
    }

    // ── Layer 3: dynamic (regime) ─────────────────────────────────────────────
    if (this.dynamic.enabled) {
      const regimeMult = this.dynamic.regimeMultiplier[regime] ?? 1.0;
      spread *= regimeMult;

      const baseRaw = Math.max(
        2 * this.fee,
        this._originalBaseFraction * (1 + this.volMultiplier * vol)
      );
      spread = Math.max(spread, baseRaw * this.dynamic.minMultiplier);
      spread = Math.min(spread, baseRaw * this.dynamic.maxMultiplier);
      spread = Math.min(spread, this.dynamic.maxSpreadFraction);
    }

    // ── Layer 4: adverse-fill multiplier ──────────────────────────────────────
    if (this.adverseMultiplier !== 1.0) {
      spread = Math.min(
        spread * this.adverseMultiplier,
        this.dynamic.maxSpreadFraction
      );
    }

    // ── Layer 5: fill-rate feedback ────────────────────────────────────────────
    // Upgrade #3: adaptive spread based on realized fill rate.
    //   fillRate > target → widen (likely getting picked off by informed flow)
    //   fillRate < target → tighten (spread may be too wide, missing edge)
    if (this.fillRateCfg.enabled) {
      const adj = 1 + this.fillRateCfg.lambda * (this.fillRate - this.fillRateCfg.target);
      const clamped = Math.max(this.fillRateCfg.minMult, Math.min(this.fillRateCfg.maxMult, adj));
      spread = Math.min(spread * clamped, this.dynamic.maxSpreadFraction);
    }

    return { spread, vol, regime };
  }

  resetBaseFraction() {
    this.baseFraction = this._originalBaseFraction;
  }
}

module.exports = SpreadEngine;
