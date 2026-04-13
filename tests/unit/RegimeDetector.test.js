'use strict';

const RegimeDetector = require('../../src/core/RegimeDetector');

const defaultConfig = {
    enabled: true,
    momentumWindow: 5,
    trendThreshold: 0.002,
    volatileThreshold: 0.006,
};

describe('RegimeDetector', () => {
    let rd;

    beforeEach(() => {
        rd = new RegimeDetector(defaultConfig);
    });

    // ── Default / disabled ────────────────────────────────────────────────────

    test('returns ranging when disabled', () => {
        const disabled = new RegimeDetector({ ...defaultConfig, enabled: false });
        const result = disabled.detect([100, 101, 102, 103], 0.001);
        expect(result).toBe('ranging');
    });

    test('returns ranging with fewer than 2 prices', () => {
        expect(rd.detect([100], 0.001)).toBe('ranging');
        expect(rd.detect([], 0.001)).toBe('ranging');
    });

    // ── Volatile detection ────────────────────────────────────────────────────

    test('volatile overrides trend when vol exceeds threshold', () => {
        // Strongly uptrending but vol is above threshold
        expect(rd.detect([100, 102, 104, 106, 108], 0.007)).toBe('volatile');
    });

    test('exactly at volatileThreshold IS volatile (>= boundary)', () => {
        const result = rd.detect([100, 100, 100, 100, 100], 0.006);
        // 0.006 >= 0.006 → volatile
        expect(result).toBe('volatile');
    });

    test('just below volatileThreshold is NOT volatile', () => {
        expect(rd.detect([100, 100, 100, 100, 100], 0.0059)).toBe('ranging');
    });

    // ── Trend detection ───────────────────────────────────────────────────────

    test('trending_up when price rises above trendThreshold', () => {
        // Momentum = (105 - 100) / 100 = 0.05 > 0.002
        const result = rd.detect([100, 101, 102, 103, 105], 0.001);
        expect(result).toBe('trending_up');
    });

    test('trending_down when price falls below -trendThreshold', () => {
        // Momentum = (95 - 100) / 100 = -0.05 < -0.002
        const result = rd.detect([100, 99, 98, 97, 95], 0.001);
        expect(result).toBe('trending_down');
    });

    test('ranging when movement is within trendThreshold', () => {
        // Momentum < 0.002 (tiny move)
        const result = rd.detect([100, 100.1, 100.05, 100.1, 100.1], 0.0005);
        expect(result).toBe('ranging');
    });

    // ── Momentum window ───────────────────────────────────────────────────────

    test('uses only last momentumWindow prices for calculation', () => {
        // History has 10 prices but first 5 show downtrend, last 5 show uptrend
        // With momentumWindow=5, should see the recent uptrend
        const history = [100, 95, 90, 85, 80,   // first 5: drop
            80, 85, 90, 95, 100];    // last 5: rise back to 100
        // momentumWindow=5: slice = [80,85,90,95,100] → momentum = (100-80)/80 = 0.25 → trending_up
        const result = rd.detect(history, 0.001);
        expect(result).toBe('trending_up');
    });

    test('first price of zero falls back to ranging', () => {
        const result = rd.detect([0, 1, 2, 3, 4], 0.001);
        expect(result).toBe('ranging');
    });

    // ── current() ────────────────────────────────────────────────────────────

    test('current() returns last detected regime', () => {
        rd.detect([100, 105, 110, 115, 120], 0.001);
        expect(rd.current()).toBe('trending_up');
    });

    test('current() starts as ranging', () => {
        expect(rd.current()).toBe('ranging');
    });
});
