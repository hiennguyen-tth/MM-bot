'use strict';

const InventoryManager = require('../../src/risk/InventoryManager');

const DEFAULT_CONFIG = {
    softMax: 0.1,
    hardMax: 0.2,
    skewFactor: 0.3,
    sizeFactor: 0.8,
    baseSize: 0.001,
};

describe('InventoryManager', () => {
    let mgr;

    beforeEach(() => {
        mgr = new InventoryManager(DEFAULT_CONFIG);
    });

    // ── Initial state ───────────────────────────────────────────────────────────

    test('starts at zero inventory', () => {
        expect(mgr.getInventory()).toBe(0);
    });

    // ── update() ───────────────────────────────────────────────────────────────

    test('buy increases inventory', () => {
        mgr.update(0.05, 'buy');
        expect(mgr.getInventory()).toBeCloseTo(0.05);
    });

    test('sell decreases inventory', () => {
        mgr.update(0.05, 'sell');
        expect(mgr.getInventory()).toBeCloseTo(-0.05);
    });

    test('successive buys accumulate', () => {
        mgr.update(0.03, 'buy');
        mgr.update(0.04, 'buy');
        expect(mgr.getInventory()).toBeCloseTo(0.07);
    });

    test('buy then sell can return to near zero', () => {
        mgr.update(0.1, 'buy');
        mgr.update(0.1, 'sell');
        expect(mgr.getInventory()).toBeCloseTo(0);
    });

    // ── T3: Hard limit ─────────────────────────────────────────────────────────

    test('isAtHardLimit() false when within hardMax', () => {
        mgr.update(0.19, 'buy'); // just under 0.2
        expect(mgr.isAtHardLimit()).toBe(false);
    });

    test('isAtHardLimit() false exactly at hardMax', () => {
        mgr.update(0.2, 'buy'); // exactly at limit (not over)
        expect(mgr.isAtHardLimit()).toBe(false);
    });

    test('isAtHardLimit() true when above hardMax (long)', () => {
        mgr.update(0.21, 'buy');
        expect(mgr.isAtHardLimit()).toBe(true);
    });

    test('isAtHardLimit() true when above hardMax (short)', () => {
        mgr.update(0.21, 'sell');
        expect(mgr.isAtHardLimit()).toBe(true);
    });

    test('hedgeSide() returns sell when long', () => {
        mgr.update(0.1, 'buy');
        expect(mgr.hedgeSide()).toBe('sell');
    });

    test('hedgeSide() returns buy when short', () => {
        mgr.update(0.1, 'sell');
        expect(mgr.hedgeSide()).toBe('buy');
    });

    test('hedgeSize() returns excess above softMax', () => {
        mgr.update(0.15, 'buy'); // 0.05 excess over 0.1 softMax
        expect(mgr.hedgeSize()).toBeCloseTo(0.05);
    });

    test('hedgeSize() returns 0 when within softMax', () => {
        mgr.update(0.08, 'buy');
        expect(mgr.hedgeSize()).toBe(0);
    });

    // ── T2: Skew computation ───────────────────────────────────────────────────

    test('compute() skewOffset is 0 at zero inventory', () => {
        const { skewOffset } = mgr.compute(0.002);
        expect(skewOffset).toBe(0);
    });

    test('compute() ratio clamped to +1 even above softMax', () => {
        mgr.update(0.5, 'buy'); // far above softMax=0.1
        const { ratio } = mgr.compute(0.002);
        expect(ratio).toBe(1);
    });

    test('compute() ratio clamped to -1 for large short', () => {
        mgr.update(0.5, 'sell');
        const { ratio } = mgr.compute(0.002);
        expect(ratio).toBe(-1);
    });

    test('compute() positive skewOffset when long (shifts quotes down)', () => {
        mgr.update(0.05, 'buy'); // 50% of softMax
        const { skewOffset } = mgr.compute(0.002);
        expect(skewOffset).toBeGreaterThan(0);
    });

    test('compute() negative skewOffset when short (shifts quotes up)', () => {
        mgr.update(0.05, 'sell'); // 50% of softMax short
        const { skewOffset } = mgr.compute(0.002);
        expect(skewOffset).toBeLessThan(0);
    });

    test('compute() skewOffset formula: ratio × spread × skewFactor', () => {
        mgr.inventory = 0.05; // ratio = 0.05/0.1 = 0.5
        const spread = 0.004;
        const { skewOffset } = mgr.compute(spread);
        // expected = 0.5 × 0.004 × 0.3 = 0.0006
        expect(skewOffset).toBeCloseTo(0.5 * 0.004 * 0.3, 8);
    });

    test('compute() orderSize decreases as inventory fills up', () => {
        const { orderSize: full } = mgr.compute(0.002);
        mgr.update(0.08, 'buy'); // ratio ≈ 0.8
        const { orderSize: reduced } = mgr.compute(0.002);
        expect(reduced).toBeLessThan(full);
    });

    test('compute() orderSize formula: baseSize × (1 − |ratio| × sizeFactor)', () => {
        mgr.inventory = 0.05; // ratio = 0.5
        const { orderSize } = mgr.compute(0.002);
        const expected = 0.001 * (1 - 0.5 * 0.8); // = 0.0006
        expect(orderSize).toBeCloseTo(expected, 8);
    });

    test('compute() orderSize never falls below 10% of baseSize', () => {
        mgr.inventory = 9999; // extreme inventory
        const { orderSize } = mgr.compute(0.002);
        expect(orderSize).toBeGreaterThanOrEqual(0.001 * 0.1);
    });
});
