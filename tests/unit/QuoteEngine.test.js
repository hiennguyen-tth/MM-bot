'use strict';

const QuoteEngine = require('../../src/core/QuoteEngine');

const defaultCfg = {
    levels: 3,
    spreadMultipliers: [1.0, 1.5, 2.0],
    sizeFractions: [0.5, 0.3, 0.2],
};

describe('QuoteEngine', () => {
    let qe;

    beforeEach(() => {
        qe = new QuoteEngine(defaultCfg);
    });

    // ── Output shape ───────────────────────────────────────────────────────────

    test('returns 6 quotes for 3 levels (3 buy + 3 sell)', () => {
        const quotes = qe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        expect(quotes).toHaveLength(6);
        expect(quotes.filter(q => q.side === 'buy').length).toBe(3);
        expect(quotes.filter(q => q.side === 'sell').length).toBe(3);
    });

    test('each quote has side, price, amount, level fields', () => {
        const quotes = qe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        for (const q of quotes) {
            expect(q).toHaveProperty('side');
            expect(q).toHaveProperty('price');
            expect(q).toHaveProperty('amount');
            expect(q).toHaveProperty('level');
        }
    });

    test('levels are numbered 1..N', () => {
        const quotes = qe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        const levels = [...new Set(quotes.map(q => q.level))].sort((a, b) => a - b);
        expect(levels).toEqual([1, 2, 3]);
    });

    // ── Single level ───────────────────────────────────────────────────────────

    test('single level returns 2 quotes', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0] });
        const quotes = singleQe.buildQuotes({ mid: 50000, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        expect(quotes).toHaveLength(2);
    });

    // ── Spread layout ─────────────────────────────────────────────────────────

    test('ask > bid for all levels at zero inventory', () => {
        const quotes = qe.buildQuotes({ mid: 50000, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        for (let i = 1; i <= 3; i++) {
            const bid = quotes.find(q => q.side === 'buy' && q.level === i);
            const ask = quotes.find(q => q.side === 'sell' && q.level === i);
            expect(ask.price).toBeGreaterThan(bid.price);
        }
    });

    test('L2 spread is wider than L1 spread', () => {
        const quotes = qe.buildQuotes({ mid: 50000, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        const l1Bid = quotes.find(q => q.side === 'buy' && q.level === 1).price;
        const l1Ask = quotes.find(q => q.side === 'sell' && q.level === 1).price;
        const l2Bid = quotes.find(q => q.side === 'buy' && q.level === 2).price;
        const l2Ask = quotes.find(q => q.side === 'sell' && q.level === 2).price;
        expect(l1Ask - l1Bid).toBeLessThan(l2Ask - l2Bid);
    });

    test('L3 spread is wider than L2 spread', () => {
        const quotes = qe.buildQuotes({ mid: 50000, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        const l2Spread = quotes.find(q => q.side === 'sell' && q.level === 2).price
            - quotes.find(q => q.side === 'buy' && q.level === 2).price;
        const l3Spread = quotes.find(q => q.side === 'sell' && q.level === 3).price
            - quotes.find(q => q.side === 'buy' && q.level === 3).price;
        expect(l3Spread).toBeGreaterThan(l2Spread);
    });

    // ── Asymmetric skew ──────────────────────────────────────────────────────

    test('neutral inventory (ratio=0) places bid and ask symmetrically around mid', () => {
        const mid = 50000;
        const quotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        const l1Bid = quotes.find(q => q.side === 'buy' && q.level === 1).price;
        const l1Ask = quotes.find(q => q.side === 'sell' && q.level === 1).price;
        // mid should be exactly halfway between bid and ask
        expect((l1Bid + l1Ask) / 2).toBeCloseTo(mid, 0);
    });

    test('long inventory (ratio>0) lowers bid below neutral', () => {
        const mid = 50000;
        const neutralQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        const longQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0.5, skewFactor: 0.3, orderSize: 0.001 });

        const neutralBid = neutralQuotes.find(q => q.side === 'buy' && q.level === 1).price;
        const longBid = longQuotes.find(q => q.side === 'buy' && q.level === 1).price;
        expect(longBid).toBeLessThan(neutralBid);
    });

    test('long inventory (ratio>0) raises ask above neutral (asymmetric)', () => {
        const mid = 50000;
        const neutralQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        const longQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0.5, skewFactor: 0.3, orderSize: 0.001 });

        const neutralAsk = neutralQuotes.find(q => q.side === 'sell' && q.level === 1).price;
        const longAsk = longQuotes.find(q => q.side === 'sell' && q.level === 1).price;
        // Asymmetric: when long, ask goes UP (unlike old band-shift where ask went DOWN)
        expect(longAsk).toBeGreaterThan(neutralAsk);
    });

    test('short inventory (ratio<0) raises bid above neutral', () => {
        const mid = 50000;
        const neutralQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0.3, orderSize: 0.001 });
        const shortQuotes = qe.buildQuotes({ mid, spread: 0.002, ratio: -0.5, skewFactor: 0.3, orderSize: 0.001 });

        const neutralBid = neutralQuotes.find(q => q.side === 'buy' && q.level === 1).price;
        const shortBid = shortQuotes.find(q => q.side === 'buy' && q.level === 1).price;
        expect(shortBid).toBeGreaterThan(neutralBid);
    });

    test('skewFactor=0 produces symmetric quotes regardless of inventory', () => {
        const mid = 50000;
        const quotes = qe.buildQuotes({ mid, spread: 0.002, ratio: 0.9, skewFactor: 0, orderSize: 0.001 });
        const bid = quotes.find(q => q.side === 'buy' && q.level === 1).price;
        const ask = quotes.find(q => q.side === 'sell' && q.level === 1).price;
        expect((bid + ask) / 2).toBeCloseTo(mid, 0);
    });

    // ── Size fractions ────────────────────────────────────────────────────────

    test('L1 order size is 50% of orderSize', () => {
        const orderSize = 0.002;
        const quotes = qe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0, orderSize });
        const l1Buy = quotes.find(q => q.side === 'buy' && q.level === 1);
        expect(l1Buy.amount).toBeCloseTo(orderSize * 0.5, 10);
    });

    test('L2 order size is 30% of orderSize', () => {
        const orderSize = 0.002;
        const quotes = qe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0, orderSize });
        const l2Buy = quotes.find(q => q.side === 'buy' && q.level === 2);
        expect(l2Buy.amount).toBeCloseTo(orderSize * 0.3, 10);
    });

    // ── Edge cases ────────────────────────────────────────────────────────────

    test('returns empty array if all quotes produce askPrice <= bidPrice', () => {
        const tinyQe = new QuoteEngine({ levels: 1, spreadMultipliers: [0.0], sizeFractions: [1.0] });
        // Zero spread → bid = ask = mid → no valid quotes
        const quotes = tinyQe.buildQuotes({ mid: 100, spread: 0, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        expect(quotes).toHaveLength(0);
    });

    test('skips levels with zero or negative amount', () => {
        const zeroQe = new QuoteEngine({ levels: 2, spreadMultipliers: [1.0, 1.5], sizeFractions: [1.0, 0] });
        const quotes = zeroQe.buildQuotes({ mid: 100, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        // Only L1 produces non-zero amounts
        expect(quotes).toHaveLength(2);
        expect(quotes.every(q => q.level === 1)).toBe(true);
    });

    // ── Upgrade #4: tanh nonlinear skew ──────────────────────────────────────

    test('tanh skew saturates: ratio=1 skew is less than 2× ratio=0.5 skew', () => {
        const mid = 50000;
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0], skewSteepness: 1.5 });
        const halfBase = 0.002 * mid / 2;

        const q1 = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0.5, skewFactor: 1.0, orderSize: 0.001 });
        const q2 = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 1.0, skewFactor: 1.0, orderSize: 0.001 });

        // skewAbs at 0.5 = tanh(0.5 × 1.5) × halfBase = tanh(0.75) × halfBase ≈ 0.635 × halfBase
        // skewAbs at 1.0 = tanh(1.0 × 1.5) × halfBase = tanh(1.5) × halfBase ≈ 0.905 × halfBase
        // Linear would give exactly 2×. tanh gives < 2× → saturation confirmed.
        const skew1 = q1.find(q => q.side === 'sell').price - (mid + halfBase);
        const skew2 = q2.find(q => q.side === 'sell').price - (mid + halfBase);
        expect(skew2).toBeLessThan(2 * skew1);
        expect(skew2).toBeGreaterThan(0); // still applies skew
    });

    test('tanh skew produces zero at ratio=0 (same as before)', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0] });
        const mid = 50000;
        const q = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0.5, orderSize: 0.001 });
        const bid = q.find(q => q.side === 'buy').price;
        const ask = q.find(q => q.side === 'sell').price;
        expect((bid + ask) / 2).toBeCloseTo(mid, 0);
    });

    test('skewSteepness=0 produces zero skew regardless of ratio', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0], skewSteepness: 0 });
        const mid = 50000;
        const q = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 1.0, skewFactor: 0.5, orderSize: 0.001 });
        const bid = q.find(q => q.side === 'buy').price;
        const ask = q.find(q => q.side === 'sell').price;
        expect((bid + ask) / 2).toBeCloseTo(mid, 0);
    });

    test('skewSteepness defaults to 1.5', () => {
        const qe = new QuoteEngine({});
        expect(qe.skewSteepness).toBe(1.5);
    });

    // ── Upgrade #1/#2/#5: fairPrice centering ─────────────────────────────────

    test('fairPrice=null falls back to mid (backward compatible)', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0] });
        const mid = 50000;
        const q1 = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001, fairPrice: null });
        const q2 = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 }); // no fairPrice
        expect(q1[0].price).toBe(q2[0].price);
        expect(q1[1].price).toBe(q2[1].price);
    });

    test('fairPrice centers quotes away from mid when provided', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0] });
        const mid = 50000;
        const fairPrice = 50010; // $10 above mid

        const normal = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        const shifted = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001, fairPrice });

        const normalCenter = (normal[0].price + normal[1].price) / 2;
        const shiftedCenter = (shifted[0].price + shifted[1].price) / 2;

        expect(shiftedCenter).toBeGreaterThan(normalCenter);
        expect(shiftedCenter).toBeCloseTo(fairPrice, 0);
    });

    test('fairPrice below mid shifts quotes downward (inventory decay scenario)', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0] });
        const mid = 50000;
        const fairPrice = 49995; // $5 below mid (long position decay)

        const normal = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001 });
        const decayed = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0, skewFactor: 0, orderSize: 0.001, fairPrice });

        expect(decayed.find(q => q.side === 'sell').price).toBeLessThan(normal.find(q => q.side === 'sell').price);
        expect(decayed.find(q => q.side === 'buy').price).toBeLessThan(normal.find(q => q.side === 'buy').price);
    });

    test('fairPrice × skew combined: long+decay pushes bid down, ask partially down', () => {
        const singleQe = new QuoteEngine({ levels: 1, spreadMultipliers: [1.0], sizeFractions: [1.0], skewSteepness: 1.5 });
        const mid = 50000;
        const fairPrice = 49995; // decay pulls center down

        const q = singleQe.buildQuotes({ mid, spread: 0.002, ratio: 0.8, skewFactor: 0.3, orderSize: 0.001, fairPrice });
        // Long + decay: bid should be below fairPrice - halfBase (skew pushes bid further down)
        const halfBase = 0.002 * mid / 2;
        const bid = q.find(q => q.side === 'buy').price;
        expect(bid).toBeLessThan(fairPrice - halfBase);
    });
});
