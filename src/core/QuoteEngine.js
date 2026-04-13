'use strict';

const { roundTo } = require('../utils/math');

/**
 * QuoteEngine v3 – Multi-level quoting with asymmetric skew + fair price centering.
 *
 * ── Why multi-level? ─────────────────────────────────────────────────────────
 * A single bid/ask at L1 captures the most volume but misses larger moves.
 * L2/L3 sit further out as passive insurance: if the market sweeps through
 * L1, L2 fills at a better price and acts as a natural mean-reversion bet.
 *
 *   Level  │ Spread mult │ Size fraction │ Purpose
 *   ───────┼─────────────┼───────────────┼──────────────────────────────────
 *   L1     │ 1.0×        │ 50%           │ Tight; highest fill probability
 *   L2     │ 1.5×        │ 30%           │ Mid; fills on moderate moves
 *   L3     │ 2.0×        │ 20%           │ Wide; passive / asymmetric capture
 *
 * ── Fair price centering (v3) ─────────────────────────────────────────────────
 * Instead of centering quotes on plain mid, MarketMaker computes a "fair price"
 * that incorporates:
 *   - Microprice: (bid × askVol + ask × bidVol) / totalVol — volume-weighted fair
 *   - Flow signal: EMA of orderbook imbalance → direction of aggressor flow
 *   - Inventory decay: AS-style reservation price shift (pushes toward flat)
 *
 *   fairPrice = microprice + φ × flowEMA × mid − γ × ratio × vol × mid
 *
 * ── Nonlinear skew via tanh (v3) ─────────────────────────────────────────────
 * Linear skew can become extreme near hard inventory limits.
 * tanh saturates smoothly:
 *
 *   skewAbs = tanh(|ratio| × steepness) × halfSpread × skewFactor
 *
 * At ratio = 0: zero skew (same as before).
 * At ratio = 0.5, steepness=1.5: tanh(0.75)≈0.635 vs linear=0.5 (slightly more)
 * At ratio = 1.0, steepness=1.5: tanh(1.5)≈0.905 vs linear=1.0 (saturates, prevents extreme skew)
 *
 * ── Asymmetric skew ──────────────────────────────────────────────────────────
 * When LONG (want to sell):
 *   bid = fairPrice - halfSpread × mult - skewAbs   (lower → less likely to add)
 *   ask = fairPrice + halfSpread × mult + skewAbs   (higher → capture more per fill)
 *
 * When SHORT (want to buy):
 *   bid = fairPrice - halfSpread × mult + skewAbs   (higher → fill sooner on dips)
 *   ask = fairPrice + halfSpread × mult - skewAbs   (lower → passive sell)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   const qe = new QuoteEngine(config.quoting);
 *   const quotes = qe.buildQuotes({ mid, spread, ratio, skewFactor, orderSize, fairPrice });
 *   // → Array<{ side, price, amount, level }>
 */
class QuoteEngine {
    /**
     * @param {object} config
     * @param {number}   config.levels            – number of levels per side (default 3)
     * @param {number[]} config.spreadMultipliers  – spread multiplier per level
     * @param {number[]} config.sizeFractions      – fraction of orderSize per level
     * @param {number}   config.skewSteepness      – tanh steepness (default 1.5)
     */
    constructor(config = {}) {
        this.levels = config.levels || 3;
        this.spreadMultipliers = config.spreadMultipliers || [1.0, 1.5, 2.0];
        this.sizeFractions = config.sizeFractions || [0.5, 0.3, 0.2];
        // Upgrade #4: tanh steepness — higher = closer to linear at low inventory,
        // faster saturation at high inventory (prevents extreme skew near hard limits)
        this.skewSteepness = config.skewSteepness || 1.5;
    }

    /**
     * Build all quote orders for one tick.
     *
     * @param {object} params
     * @param {number} params.mid          – current mid price (used for spread width calc)
     * @param {number} params.spread       – fractional spread (e.g. 0.002 = 0.2%)
     * @param {number} params.ratio        – inventory ratio ∈ [-1, 1]; positive = long
     * @param {number} params.skewFactor   – config.inventory.skewFactor
     * @param {number} params.orderSize    – base order size (from InventoryManager)
     * @param {number} [params.priceDp]    – decimal places for price rounding (default 2)
     * @param {number|null} [params.fairPrice] – center quotes here instead of mid.
     *   Computed by MarketMaker as: microprice + flow_adjustment + inventory_decay.
     *   Defaults to mid when null.
     *
     * @returns {Array<{ side: 'buy'|'sell', price: number, amount: number, level: number }>}
     */
    buildQuotes({ mid, spread, ratio, skewFactor, orderSize, priceDp = 2, fairPrice = null }) {
        // Center of quotes: fairPrice if provided, else plain mid
        const refPrice = fairPrice !== null ? fairPrice : mid;

        // halfBase uses mid for spread-width calculation (spread is a fraction of mid)
        const halfBase = (spread * mid) / 2;

        // Upgrade #4: nonlinear skew via tanh — saturates near inventory limit,
        // avoids extreme bid/ask separation when position is at max
        const skewAbs = Math.tanh(Math.abs(ratio) * this.skewSteepness) * halfBase * skewFactor;
        // skewSign: +1 when long (push bid down, ask up), -1 when short (reverse)
        const skewSign = ratio >= 0 ? 1 : -1;

        const quotes = [];

        for (let i = 0; i < this.levels; i++) {
            const mult = this.spreadMultipliers[i] ?? 1.0;
            const frac = this.sizeFractions[i] ?? (1 / this.levels);
            const half = halfBase * mult;
            const amount = orderSize * frac;

            if (amount <= 0) continue;

            // Upgrade #1/#2/#5: quote centered on refPrice (microprice + flow + decay)
            // instead of plain mid. Asymmetric skew still applied outward.
            const bidPrice = roundTo(refPrice - half - skewSign * skewAbs, priceDp);
            const askPrice = roundTo(refPrice + half + skewSign * skewAbs, priceDp);

            if (askPrice <= bidPrice) continue; // sanity guard

            quotes.push({ side: 'buy', price: bidPrice, amount, level: i + 1 });
            quotes.push({ side: 'sell', price: askPrice, amount, level: i + 1 });
        }

        return quotes;
    }
}

module.exports = QuoteEngine;
