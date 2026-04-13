'use strict';

const SpreadEngine = require('../../src/core/SpreadEngine');

describe('SpreadEngine', () => {
    let engine;

    beforeEach(() => {
        engine = new SpreadEngine({
            fee: 0.001,
            baseFraction: 0.002,
            volLookback: 20,
            volMultiplier: 3,
        });
    });

    // ── Price history management ────────────────────────────────────────────────

    test('starts with empty price history', () => {
        expect(engine.priceHistory).toHaveLength(0);
    });

    test('addPrice appends to history', () => {
        engine.addPrice(50000);
        expect(engine.priceHistory).toHaveLength(1);
    });

    test('priceHistory is bounded to volLookback', () => {
        for (let i = 0; i < 25; i++) {
            engine.addPrice(50000 + i);
        }
        expect(engine.priceHistory).toHaveLength(20);
        // Most recent prices kept
        expect(engine.priceHistory[19]).toBe(50024);
    });

    test('compute() feeds mid into price history', () => {
        engine.compute(50000);
        expect(engine.priceHistory).toContain(50000);
    });

    // ── Spread formula ─────────────────────────────────────────────────────────

    test('returns minimum 2×fee when only one price (zero vol)', () => {
        const { spread } = engine.compute(50000);
        // With one data point, vol = 0 → spread = max(0.002, 0.002*(1+0)) = 0.002
        expect(spread).toBeCloseTo(0.002, 6);
    });

    test('spread ≥ 2×fee always (zero vol)', () => {
        // Feed identical prices → std = 0 → vol = 0
        for (let i = 0; i < 5; i++) engine.compute(100);
        const { spread } = engine.compute(100);
        expect(spread).toBeGreaterThanOrEqual(2 * 0.001);
    });

    test('spread increases with higher volatility', () => {
        // Low-vol engine
        for (let i = 0; i < 5; i++) engine.compute(50000 + i * 0.1);
        const { spread: lowVol } = engine.compute(50000);

        // High-vol engine
        const hiEngine = new SpreadEngine({
            fee: 0.001,
            baseFraction: 0.002,
            volLookback: 20,
            volMultiplier: 3,
        });
        const volatilePrices = [50000, 51500, 49000, 52000, 48500, 51000];
        for (const p of volatilePrices) hiEngine.compute(p);
        const { spread: highVol } = hiEngine.compute(50000);

        expect(highVol).toBeGreaterThan(lowVol);
    });

    test('spread formula exact: max(2×fee, base×(1+3×vol))', () => {
        // Force a known history to compute deterministic vol
        engine.priceHistory = [100, 100, 100]; // std=0, vol=0
        const { spread } = engine.compute(100);
        // vol ≈ 0 → spread = max(0.002, 0.002*(1+0)) = 0.002
        expect(spread).toBeCloseTo(0.002, 8);
    });

    test('baseFraction can be updated externally (adverse fill widen)', () => {
        engine.baseFraction = 0.003; // simulate adverse widen
        const { spread } = engine.compute(100);
        expect(spread).toBeGreaterThanOrEqual(0.003);
    });

    // ── compute() return shape ──────────────────────────────────────────────

    test('compute() returns { spread, vol, regime } shape', () => {
        const result = engine.compute(50000);
        expect(result).toHaveProperty('spread');
        expect(result).toHaveProperty('vol');
        expect(result).toHaveProperty('regime');
    });

    test('compute() regime defaults to ranging', () => {
        const { regime } = engine.compute(50000);
        expect(regime).toBe('ranging');
    });

    test('compute() passes regime parameter through', () => {
        const { regime } = engine.compute(50000, 'volatile');
        expect(regime).toBe('volatile');
    });

    // ── Dynamic spread: regime multipliers ─────────────────────────────────

    test('volatile regime widens spread vs ranging baseline', () => {
        const dynamicCfg = {
            enabled: true,
            minMultiplier: 0.5,
            maxMultiplier: 3.0,
            maxSpreadFraction: 0.05,
            regimeMultiplier: { ranging: 1.0, volatile: 2.0, trending_up: 1.5, trending_down: 1.5 },
        };
        const dynEngine = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            dynamicCfg
        );
        // Seed some vol so spread > 2*fee baseline
        [100, 102, 98, 103, 97].forEach(p => dynEngine.addPrice(p));
        const { spread: rangingSpread } = dynEngine.compute(100, 'ranging');

        const dynEngine2 = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            dynamicCfg
        );
        [100, 102, 98, 103, 97].forEach(p => dynEngine2.addPrice(p));
        const { spread: volatileSpread } = dynEngine2.compute(100, 'volatile');

        expect(volatileSpread).toBeGreaterThan(rangingSpread);
    });

    test('maxSpreadFraction absolute cap is respected', () => {
        const dynamicCfg = {
            enabled: true,
            minMultiplier: 0.5,
            maxMultiplier: 999,       // very high max
            maxSpreadFraction: 0.003, // hard cap at 0.3%
            regimeMultiplier: { ranging: 1.0, volatile: 999, trending_up: 1.0, trending_down: 1.0 },
        };
        const cappedEngine = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 100 },
            dynamicCfg
        );
        // Add high-volatility prices
        [100, 110, 90, 115, 85].forEach(p => cappedEngine.addPrice(p));
        const { spread } = cappedEngine.compute(100, 'volatile');
        expect(spread).toBeLessThanOrEqual(0.003);
    });

    test('minMultiplier floor prevents spread from falling too low', () => {
        const dynamicCfg = {
            enabled: true,
            minMultiplier: 2.0,       // minimum 2× base
            maxMultiplier: 3.0,
            maxSpreadFraction: 0.05,
            regimeMultiplier: { ranging: 0.1, volatile: 2.0, trending_up: 1.0, trending_down: 1.0 },
        };
        const floorEngine = new SpreadEngine(
            { fee: 0.0001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            dynamicCfg
        );
        // Zero vol → base = 0.002; regime multiplier = 0.1 → would be 0.0002
        // but minMultiplier = 2.0 → floor = 0.002 * 2 = 0.004
        const { spread } = floorEngine.compute(100, 'ranging');
        const expectedFloor = 0.002 * 2.0;
        expect(spread).toBeGreaterThanOrEqual(expectedFloor * 0.99); // allow fp rounding
    });

    test('_originalBaseFraction is preserved when baseFraction is mutated externally', () => {
        const original = engine._originalBaseFraction;
        engine.baseFraction = 0.999; // adverse fill widen
        expect(engine._originalBaseFraction).toBe(original);
    });

    // ── Dynamic spread disabled passthrough ─────────────────────────────────

    test('when dynamic disabled, regime has no effect on spread magnitude', () => {
        const staticEngine = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false }
        );
        [100, 102, 98, 103, 97].forEach(p => staticEngine.addPrice(p));
        const { spread: ranging } = staticEngine.compute(100, 'ranging');

        const staticEngine2 = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false }
        );
        [100, 102, 98, 103, 97].forEach(p => staticEngine2.addPrice(p));
        const { spread: volatile_ } = staticEngine2.compute(100, 'volatile');

        expect(ranging).toBeCloseTo(volatile_, 10);
    });

    // ── Imbalance layer ───────────────────────────────────────────────────────

    test('imbalance widens spread when book is lopsided', () => {
        const imbalEngine = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },                // disable dynamic for isolation
            { enabled: true, factor: 0.01 }   // imbalance factor 1%
        );
        // Zero vol → base spread = 0.002
        const { spread: balanced } = imbalEngine.compute(100, 'ranging', 0);
        const { spread: lopsided } = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: true, factor: 0.01 }
        ).compute(100, 'ranging', 0.8); // strong bid imbalance
        // 0.01 × 0.8 = 0.008 > 0.002 → imbalance dominates
        expect(lopsided).toBeGreaterThan(balanced);
        expect(lopsided).toBeCloseTo(0.008, 5);
    });

    test('imbalance has no effect when disabled', () => {
        const noImbal = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: false, factor: 0.01 }
        );
        const { spread: s1 } = noImbal.compute(100, 'ranging', 0);
        const { spread: s2 } = new SpreadEngine(
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: false, factor: 0.01 }
        ).compute(100, 'ranging', 0.9);
        expect(s1).toBeCloseTo(s2, 10);
    });

    test('imbalance uses |imbalance| (symmetric: negative same as positive)', () => {
        const cfg = [
            { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: true, factor: 0.01 },
        ];
        const e1 = new SpreadEngine(...cfg);
        const e2 = new SpreadEngine(...cfg);
        const { spread: s1 } = e1.compute(100, 'ranging', +0.6);
        const { spread: s2 } = e2.compute(100, 'ranging', -0.6);
        expect(s1).toBeCloseTo(s2, 10);
    });

    // ── adverseMultiplier ────────────────────────────────────────────────────

    test('adverseMultiplier starts at 1.0', () => {
        expect(engine.adverseMultiplier).toBe(1.0);
    });

    test('adverseMultiplier widens spread when set above 1', () => {
        engine.priceHistory = [100, 100, 100];
        const { spread: base } = engine.compute(100);

        const engine2 = new SpreadEngine({ fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 });
        engine2.priceHistory = [100, 100, 100];
        engine2.adverseMultiplier = 1.61;
        const { spread: widened } = engine2.compute(100);

        expect(widened).toBeGreaterThan(base);
    });

    test('adverseMultiplier of 1.0 has no effect on spread', () => {
        engine.priceHistory = [100, 100, 100];
        engine.adverseMultiplier = 1.0;
        const { spread: s1 } = engine.compute(100);

        const engine2 = new SpreadEngine({ fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 });
        engine2.priceHistory = [100, 100, 100];
        const { spread: s2 } = engine2.compute(100);

        expect(s1).toBeCloseTo(s2, 10);
    });

    // ── Upgrade #3: fill-rate feedback (Layer 5) ──────────────────────────────

    test('fillRateCfg.enabled is false by default (opt-in)', () => {
        expect(engine.fillRateCfg.enabled).toBe(false);
    });

    test('fillRate property initialized to 0', () => {
        expect(engine.fillRate).toBe(0);
    });

    test('fill-rate layer disabled: spread unchanged regardless of fillRate', () => {
        const e1 = new SpreadEngine({ fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 });
        e1.priceHistory = [100, 100, 100];
        e1.fillRate = 0.0;
        const { spread: s1 } = e1.compute(100);

        const e2 = new SpreadEngine({ fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 });
        e2.priceHistory = [100, 100, 100];
        e2.fillRate = 0.9;
        const { spread: s2 } = e2.compute(100);

        expect(s1).toBeCloseTo(s2, 10);
    });

    test('fill-rate layer widens spread when fillRate > target (getting picked off)', () => {
        const makeFREngine = (fillRate) => {
            const e = new SpreadEngine(
                { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
                { enabled: false },
                { enabled: false },
                { enabled: true, lambda: 0.5, target: 0.3, minMult: 0.5, maxMult: 2.0 }
            );
            e.priceHistory = [100, 100, 100];
            e.fillRate = fillRate;
            return e;
        };
        const { spread: highFill } = makeFREngine(0.9).compute(100);  // 0.9 >> target=0.3 → widen
        const { spread: atTarget } = makeFREngine(0.3).compute(100);  // exactly at target → no change
        expect(highFill).toBeGreaterThan(atTarget);
    });

    test('fill-rate layer tightens spread when fillRate < target (too wide)', () => {
        const makeFREngine = (fillRate) => {
            const e = new SpreadEngine(
                { fee: 0.001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
                { enabled: false },
                { enabled: false },
                { enabled: true, lambda: 0.5, target: 0.5, minMult: 0.5, maxMult: 2.0 }
            );
            e.priceHistory = [100, 100, 100];
            e.fillRate = fillRate;
            return e;
        };
        const { spread: noFill } = makeFREngine(0.0).compute(100);  // 0 << target=0.5 → tighten
        const { spread: atTarget } = makeFREngine(0.5).compute(100); // at target → base spread
        expect(noFill).toBeLessThan(atTarget);
    });

    test('fill-rate layer respects minMult floor', () => {
        const e = new SpreadEngine(
            { fee: 0.0001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: false },
            { enabled: true, lambda: 999, target: 0.9, minMult: 0.8, maxMult: 2.0 }
        );
        e.priceHistory = [100, 100, 100]; // zero vol → base spread = 0.002
        e.fillRate = 0;  // far below 0.9 → heavy tighten, but floored at 0.8×
        const { spread } = e.compute(100);
        expect(spread).toBeCloseTo(0.002 * 0.8, 5);
    });

    test('fill-rate layer respects maxMult ceiling', () => {
        const e = new SpreadEngine(
            { fee: 0.0001, baseFraction: 0.002, volLookback: 20, volMultiplier: 3 },
            { enabled: false },
            { enabled: false },
            { enabled: true, lambda: 999, target: 0.0, minMult: 0.5, maxMult: 1.2 }
        );
        e.priceHistory = [100, 100, 100];
        e.fillRate = 1.0;  // far above target=0 → heavy widen, but capped at 1.2×
        const { spread } = e.compute(100);
        expect(spread).toBeLessThanOrEqual(0.002 * 1.2 * 1.001); // allow tiny fp error
    });
});
