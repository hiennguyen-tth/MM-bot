'use strict';

const CircuitBreaker = require('../../src/risk/CircuitBreaker');

describe('CircuitBreaker (T4)', () => {
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker({
      dailyLossLimit: 50,
      consecutiveLossLimit: 5,
    });
  });

  // ── Initial state ───────────────────────────────────────────────────────────

  test('passes check with no fills recorded', () => {
    const result = cb.check();
    expect(result.ok).toBe(true);
  });

  test('is not triggered initially', () => {
    expect(cb.isTriggered()).toBe(false);
  });

  // ── Daily loss ──────────────────────────────────────────────────────────────

  test('triggers when daily_loss exceeds limit', () => {
    cb.recordFill(-60); // 60 USDT loss > 50 limit
    const result = cb.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('daily_loss_limit');
    expect(result.value).toBeCloseTo(60);
  });

  test('accumulates daily losses across multiple fills', () => {
    cb.recordFill(-20);
    cb.recordFill(-20);
    cb.recordFill(-20); // total = 60 > 50
    expect(cb.check().ok).toBe(false);
  });

  test('does NOT trigger on losses exactly at limit', () => {
    cb.recordFill(-50); // exactly at limit, not over
    expect(cb.check().ok).toBe(true);
  });

  test('profits do not reduce daily loss counter', () => {
    cb.recordFill(-40);
    cb.recordFill(+100); // big profit – but daily loss stays at 40
    expect(cb.dailyLoss).toBeCloseTo(40);
    expect(cb.check().ok).toBe(true);
  });

  // ── Consecutive loss ────────────────────────────────────────────────────────

  test('triggers when consecutiveLoss > limit (6 losing trades)', () => {
    for (let i = 0; i < 6; i++) cb.recordFill(-1);
    const result = cb.check();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('consecutive_loss');
    expect(result.value).toBe(6);
  });

  test('does NOT trigger at exactly limit (5 losing trades)', () => {
    for (let i = 0; i < 5; i++) cb.recordFill(-1);
    expect(cb.check().ok).toBe(true);
  });

  test('profit resets consecutive loss counter', () => {
    cb.recordFill(-1);
    cb.recordFill(-1);
    cb.recordFill(-1);
    cb.recordFill(+5); // resets streak
    cb.recordFill(-1);
    expect(cb.consecutiveLoss).toBe(1);
    expect(cb.check().ok).toBe(true);
  });

  test('streak restarts after reset and can re-trigger', () => {
    cb.recordFill(-1);
    cb.recordFill(-1);
    cb.recordFill(+5); // reset
    for (let i = 0; i < 6; i++) cb.recordFill(-1); // 6 more loses
    expect(cb.check().ok).toBe(false);
  });

  // ── Once triggered, stays triggered ────────────────────────────────────────

  test('stays triggered after initial breach', () => {
    for (let i = 0; i < 6; i++) cb.recordFill(-1);
    cb.check(); // first check – triggers
    const result = cb.check(); // second check
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('already_triggered');
  });

  test('isTriggered() returns true after breach', () => {
    cb.recordFill(-100);
    cb.check(); // trigger it
    expect(cb.isTriggered()).toBe(true);
  });

  // ── Pure profit path ────────────────────────────────────────────────────────

  test('never triggers on profits only', () => {
    for (let i = 0; i < 20; i++) cb.recordFill(+5);
    expect(cb.check().ok).toBe(true);
  });
});
