'use strict';

const { clamp } = require('../utils/math');

/**
 * Manages net inventory position and provides:
 *   T3 – Hard inventory guard (emergency hedge trigger)
 *   T2 – Inventory skew + order size reduction
 *
 * Formulas (SVG):
 *   ratio       = inventory / softMax          ∈ [-1, +1]
 *   skewOffset  = ratio × spread × skewFactor
 *   orderSize   = baseSize × (1 − |ratio| × sizeFactor)
 *
 * Quote skew (T1):
 *   bid = mid − spread/2 − skewOffset
 *   ask = mid + spread/2 − skewOffset
 *
 * Both bid AND ask are shifted down when long (ratio > 0), incentivising
 * buys to slow and sells to accelerate – without changing the spread width.
 */
class InventoryManager {
    /**
     * @param {object} config
     * @param {number} config.softMax    – soft inventory limit in base currency
     * @param {number} config.hardMax    – hard inventory limit in base currency
     * @param {number} config.skewFactor – 0.3 per spec
     * @param {number} config.sizeFactor – 0.8 per spec
     * @param {number} config.baseSize   – nominal order size per quote
     */
    constructor(config) {
        this.softMax = config.softMax;
        this.hardMax = config.hardMax;
        this.skewFactor = config.skewFactor;
        this.sizeFactor = config.sizeFactor;
        this.baseSize = config.baseSize;

        this.inventory = 0; // signed: positive = long, negative = short
        this._avgCost = 0;  // weighted average entry price for current position
    }

    // ── T3: Hard limit ────────────────────────────────────────────────────────

    /**
     * Compute the effective hard limit, optionally reduced by VaR.
     * @param {number} [varLimit] – VaR-based limit (from computeVarLimit())
     */
    effectiveHardMax(varLimit = Infinity) {
        return Math.min(this.hardMax, varLimit);
    }

    /**
     * Compute VaR-based position limit.
     *   effectiveMax = capital / (vol × varMultiplier)
     * Returns Infinity when disabled or vol is zero.
     * @param {number} vol – fractional vol = std/mid
     * @param {object} [varConfig] – config.inventoryVaR
     */
    computeVarLimit(vol, varConfig) {
        if (!varConfig?.enabled || vol <= 0) return Infinity;
        return varConfig.capital / (vol * varConfig.varMultiplier);
    }

    /** Returns true when |inventory| exceeds hardMax (adjusted by VaR). */
    isAtHardLimit(varLimit = Infinity) {
        return Math.abs(this.inventory) > this.effectiveHardMax(varLimit);
    }

    /** Which side to place the emergency order to reduce position. */
    hedgeSide() {
        return this.inventory > 0 ? 'sell' : 'buy';
    }

    /**
     * How much to hedge: cut excess back to softMax (respecting VaR limit).
     * E.g. inventory = 0.25, softMax = 0.1 → hedge 0.15
     * @param {number} [varLimit] – VaR-based limit
     */
    hedgeSize(varLimit = Infinity) {
        const target = Math.min(this.softMax, this.effectiveHardMax(varLimit));
        return Math.max(Math.abs(this.inventory) - target, 0);
    }

    // ── T2: Skew + size ───────────────────────────────────────────────────────

    /**
     * Compute skew offset and adjusted order size given the current spread.
     * @param {number} spread – fractional spread from SpreadEngine
     * @returns {{ ratio: number, skewOffset: number, orderSize: number }}
     */
    /**
     * @param {number} [targetInv=0] – desired inventory level (BTC).
     *   When non-zero, ratio is computed as (inventory − targetInv) / softMax.
     *   Used by MarketMaker to inject funding-rate bias: a negative targetInv
     *   (when funding > 0) makes the bot behave as if it holds more inventory
     *   than it does → natural short bias without modifying fairPrice.
     */
    compute(spread, targetInv = 0) {
        const ratio = clamp((this.inventory - targetInv) / this.softMax, -1, 1);
        const skewOffset = ratio * spread * this.skewFactor;
        const orderSize = this.baseSize * (1 - Math.abs(ratio) * this.sizeFactor);
        return {
            ratio,
            skewOffset,
            // Prevent size rounding to zero
            orderSize: Math.max(orderSize, this.baseSize * 0.1),
        };
    }

    // ── State update ──────────────────────────────────────────────────────────

    /**
     * Update inventory after a confirmed fill.
     * @param {number} qty       – absolute quantity filled
     * @param {'buy'|'sell'} side
     * @param {number} [fillPrice=0] – fill price (for avg cost tracking)
     */
    update(qty, side, fillPrice = 0) {
        const prevInv = this.inventory;
        if (side === 'buy') {
            if (fillPrice > 0) {
                if (prevInv >= 0) {
                    // Adding to / opening long: update weighted avg cost
                    const newInv = prevInv + qty;
                    this._avgCost = (this._avgCost * prevInv + fillPrice * qty) / newInv;
                } else if (prevInv + qty > 0) {
                    // Closing short that overshoots to long: new long cost = fillPrice
                    this._avgCost = fillPrice;
                }
                // If closing short partially (stays short): avg cost unchanged
            }
            this.inventory += qty;
        } else {
            if (fillPrice > 0) {
                if (prevInv <= 0) {
                    // Adding to / opening short: update weighted avg cost
                    const newInv = Math.abs(prevInv) + qty;
                    this._avgCost = (this._avgCost * Math.abs(prevInv) + fillPrice * qty) / newInv;
                } else if (prevInv - qty < 0) {
                    // Closing long that overshoots to short: new short cost = fillPrice
                    this._avgCost = fillPrice;
                }
                // If closing long partially (stays long): avg cost unchanged
            }
            this.inventory -= qty;
        }
        if (Math.abs(this.inventory) < 1e-10) {
            this.inventory = 0;
            this._avgCost = 0;
        }
    }

    getInventory() {
        return this.inventory;
    }

    getAvgCost() {
        return this._avgCost;
    }

    /** Set position + avg cost directly (used on startup sync from exchange). */
    setPosition(size, avgCost = 0) {
        this.inventory = size;
        this._avgCost = avgCost;
    }
}

module.exports = InventoryManager;
