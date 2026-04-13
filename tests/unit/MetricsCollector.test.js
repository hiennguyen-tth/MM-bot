'use strict';

const MetricsCollector = require('../../src/metrics/MetricsCollector');

const defaultFill = (overrides = {}) => ({
    profit: 0.5,
    inventoryAbs: 0.02,
    inventoryMax: 0.1,
    isAdverse: false,
    ...overrides,
});

describe('MetricsCollector', () => {
    let mc;

    beforeEach(() => {
        mc = new MetricsCollector();
    });

    // ── Initial state ───────────────────────────────────────────────────────────

    test('fillRate is 0 with no data', () => {
        expect(mc.getFillRate()).toBe(0);
    });

    test('avgSpreadCaptured is 0 with no fills', () => {
        expect(mc.getAvgSpreadCaptured()).toBe(0);
    });

    test('avgInventoryDrift is 0 with no fills', () => {
        expect(mc.getAvgInventoryDrift()).toBe(0);
    });

    test('adverseFillRatio is 0 with no fills', () => {
        expect(mc.getAdverseFillRatio()).toBe(0);
    });

    // ── recordQuote + recordFill ────────────────────────────────────────────────

    test('fillRate = fills / quotes', () => {
        mc.recordQuote();
        mc.recordQuote();
        mc.recordFill(defaultFill());
        expect(mc.getFillRate()).toBeCloseTo(0.5);
    });

    test('fillRate is 0 when no quotes placed', () => {
        expect(mc.getFillRate()).toBe(0);
    });

    test('avgSpreadCaptured is mean of profits', () => {
        mc.recordFill(defaultFill({ profit: 1.0 }));
        mc.recordFill(defaultFill({ profit: 3.0 }));
        expect(mc.getAvgSpreadCaptured()).toBeCloseTo(2.0);
    });

    test('avgInventoryDrift = avg of |inv| / max', () => {
        mc.recordFill(defaultFill({ inventoryAbs: 0.05, inventoryMax: 0.1 })); // 0.5
        mc.recordFill(defaultFill({ inventoryAbs: 0.1, inventoryMax: 0.1 }));  // 1.0
        expect(mc.getAvgInventoryDrift()).toBeCloseTo(0.75);
    });

    // ── PnL and drawdown ────────────────────────────────────────────────────────

    test('realizedPnl accumulates profits', () => {
        mc.recordFill(defaultFill({ profit: 5 }));
        mc.recordFill(defaultFill({ profit: 3 }));
        expect(mc.realizedPnl).toBeCloseTo(8);
    });

    test('realizedPnl decreases on loss', () => {
        mc.recordFill(defaultFill({ profit: 10 }));
        mc.recordFill(defaultFill({ profit: -4 }));
        expect(mc.realizedPnl).toBeCloseTo(6);
    });

    test('maxDrawdown: peak → trough', () => {
        mc.recordFill(defaultFill({ profit: 10 }));  // peak = 10
        mc.recordFill(defaultFill({ profit: -15 })); // trough = -5, drawdown = 15
        expect(mc.maxDrawdown).toBeCloseTo(15);
    });

    test('maxDrawdown does not decrease on recovery', () => {
        mc.recordFill(defaultFill({ profit: 10 }));
        mc.recordFill(defaultFill({ profit: -8 }));  // drawdown = 8
        mc.recordFill(defaultFill({ profit: 20 }));  // new peak, but old maxDrawdown stays
        expect(mc.maxDrawdown).toBeCloseTo(8);
    });

    test('maxDrawdown is 0 when only profits', () => {
        mc.recordFill(defaultFill({ profit: 5 }));
        mc.recordFill(defaultFill({ profit: 5 }));
        expect(mc.maxDrawdown).toBe(0);
    });

    // ── Adverse fill ratio ──────────────────────────────────────────────────────

    test('adverseFillRatio = adverse fills / total fills', () => {
        mc.recordFill(defaultFill({ isAdverse: true }));
        mc.recordFill(defaultFill({ isAdverse: false }));
        mc.recordFill(defaultFill({ isAdverse: true }));
        expect(mc.getAdverseFillRatio()).toBeCloseTo(2 / 3);
    });

    test('adverseFillRatio is 0 with no adverse fills', () => {
        mc.recordFill(defaultFill({ isAdverse: false }));
        expect(mc.getAdverseFillRatio()).toBe(0);
    });

    test('adverseFillRatio rolling window drops old entries', () => {
        mc.adverseFillWindow = 3;
        mc.recordFill(defaultFill({ isAdverse: true }));  // oldest, will be evicted
        mc.recordFill(defaultFill({ isAdverse: false }));
        mc.recordFill(defaultFill({ isAdverse: false }));
        mc.recordFill(defaultFill({ isAdverse: false })); // 4th pushes out first
        // Window: [false, false, false] → ratio = 0
        expect(mc.getAdverseFillRatio()).toBe(0);
    });

    // ── getSnapshot ─────────────────────────────────────────────────────────────

    test('getSnapshot has all required fields', () => {
        const snap = mc.getSnapshot();
        expect(snap).toHaveProperty('quotesPlaced');
        expect(snap).toHaveProperty('fills');
        expect(snap).toHaveProperty('fillRate');
        expect(snap).toHaveProperty('avgSpreadCaptured');
        expect(snap).toHaveProperty('avgInventoryDrift');
        expect(snap).toHaveProperty('realizedPnl');
        expect(snap).toHaveProperty('hourlyPnl');
        expect(snap).toHaveProperty('maxDrawdown');
        expect(snap).toHaveProperty('adverseFillRatio');
    });

    test('getSnapshot values are strings (formatted for logging)', () => {
        const snap = mc.getSnapshot();
        expect(typeof snap.fillRate).toBe('string');
        expect(typeof snap.realizedPnl).toBe('string');
    });
});
