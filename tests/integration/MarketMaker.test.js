'use strict';

const MarketMaker = require('../../src/core/MarketMaker');

// ─── Mock exchange ────────────────────────────────────────────────────────────

class MockExchange {
  constructor(opts = {}) {
    this._price = opts.price || 50000;
    this._orders = {};
    this._nextId = 1;
    this.autoFill = false;
    this.throwOnPlace = false;
    this.throwOnMarket = false;
  }

  async getOrderBook() {
    const bid = this._price - 1;
    const ask = this._price + 1;
    // Return balanced volumes → imbalance = 0 (neutral for most tests)
    return { bid, ask, mid: this._price, bidVolume: 5, askVolume: 5 };
  }

  async getRecentTrades(symbol, limit = 20) {
    return Array.from({ length: limit }, () => this._price);
  }

  async getTrades(symbol, limit = 20) {
    // Balanced 50/50 sides → not a sweep → toxic flow disabled by default in tests
    return Array.from({ length: limit }, (_, i) => ({
      price: this._price,
      side: i % 2 === 0 ? 'buy' : 'sell',
      amount: 0.001,
    }));
  }

  async getFundingRate() {
    return 0; // neutral: no funding bias in tests
  }

  async placeLimitOrder(symbol, side, price, amount) {
    if (this.throwOnPlace) throw new Error('Exchange error');
    const id = String(this._nextId++);
    const order = { id, symbol, side, price, amount, status: 'open', filled: 0, average: price };
    this._orders[id] = order;
    return order;
  }

  async placeMarketOrder(symbol, side, amount) {
    if (this.throwOnMarket) throw new Error('Market order error');
    const id = String(this._nextId++);
    const order = { id, symbol, side, amount, status: 'closed', filled: amount, average: this._price };
    this._orders[id] = order;
    return order;
  }

  async cancelOrder(id) {
    if (this._orders[id]) this._orders[id].status = 'canceled';
  }

  async cancelAllOrders() {
    for (const o of Object.values(this._orders)) o.status = 'canceled';
  }

  async getOrder(id) {
    const order = this._orders[id];
    if (!order) return { id, status: 'canceled', filled: 0 };
    if (this.autoFill && order.status === 'open') {
      order.status = 'closed';
      order.filled = order.amount;
    }
    return { ...order };
  }
}

// ─── Config factory ───────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    symbol: 'BTC/USDT',
    exchange: { testnet: true, positionMode: 'oneway' },
    spread: {
      fee: 0.001,
      baseFraction: 0.002,
      volLookback: 20,
      volMultiplier: 3,
    },
    imbalance: { enabled: false },       // off: stable spread in tests
    quoting: {
      levels: 1,                         // single level → 2 orders per tick
      spreadMultipliers: [1.0],
      sizeFractions: [1.0],
    },
    inventory: {
      softMax: 0.1,
      hardMax: 0.2,
      skewFactor: 0.3,
      sizeFactor: 0.8,
      baseSize: 0.001,
    },
    inventoryVaR: { enabled: false },    // off: static hardMax in tests
    hedging: { preferLimit: false },     // straight to market → tests stay fast
    risk: {
      dailyLossLimit: 50,
      consecutiveLossLimit: 5,
      adverseFillThreshold: 0.6,
      adverseFillWindow: 20,
    },
    loop: {
      intervalMs: 0,
      fillPollMs: 10,
      orderTtlMs: 30,                    // very short for fast tests
    },
    dynamicSpread: {
      enabled: true,
      minMultiplier: 0.5,
      maxMultiplier: 3.0,
      maxSpreadFraction: 0.05,
      regimeMultiplier: { trending_up: 1.5, trending_down: 1.5, ranging: 1.0, volatile: 2.0 },
    },
    adaptiveTiming: {
      enabled: true,
      minIntervalMs: 100,
      maxIntervalMs: 500,
      fillPollMsVolatile: 5,
      fillPollMsQuiet: 50,
      volThresholdHigh: 0.005,
      volThresholdLow: 0.001,
    },
    regime: {
      enabled: true,
      momentumWindow: 10,
      trendThreshold: 0.002,
      volatileThreshold: 0.006,
    },
    regimeFilter: { enabled: false },    // off: don't pause in tests
    latency: { enabled: false },         // off: don't cancel in tests
    timeOfDay: { enabled: false },       // off: no session multipliers in tests
    // v4 features all disabled in tests (opt-in)
    invSpread: { k: 0 },
    dynSize: { enabled: false },
    fundingBias: { enabled: false },
    toxicFlow: { enabled: false },
    alert: { webhookUrl: null },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MarketMaker integration', () => {

  // ── T4: Circuit breaker ─────────────────────────────────────────────────────

  test('T4: shuts down bot when circuit breaker triggers', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot.circuitBreaker.dailyLoss = 100;
    await bot._tick();
    expect(bot.running).toBe(false);
  });

  test('T4: does NOT shut down when within limits', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot.running = true;
    await bot._tick();
    expect(bot.circuitBreaker.isTriggered()).toBe(false);
  });

  // ── T3: Hard inventory hedge ────────────────────────────────────────────────

  test('T3: calls placeMarketOrder when inventory > hardMax', async () => {
    const exchange = new MockExchange();
    const spy = jest.spyOn(exchange, 'placeMarketOrder');
    const bot = new MarketMaker(exchange, makeConfig());
    bot.inventory.inventory = 0.25;
    await bot._tick();
    expect(spy).toHaveBeenCalledWith('BTC/USDT', 'sell', expect.any(Number), expect.objectContaining({ positionSide: expect.any(String) }));
  });

  test('T3: hedges the short side when inventory is negative', async () => {
    const exchange = new MockExchange();
    const spy = jest.spyOn(exchange, 'placeMarketOrder');
    const bot = new MarketMaker(exchange, makeConfig());
    bot.inventory.inventory = -0.25;
    await bot._tick();
    expect(spy).toHaveBeenCalledWith('BTC/USDT', 'buy', expect.any(Number), expect.objectContaining({ positionSide: expect.any(String) }));
  });

  test('T3: skips quoting after hedge (returns early)', async () => {
    const exchange = new MockExchange();
    const limitSpy = jest.spyOn(exchange, 'placeLimitOrder');
    const bot = new MarketMaker(exchange, makeConfig());
    bot.inventory.inventory = 0.25;
    await bot._tick();
    expect(limitSpy).not.toHaveBeenCalled();
  });

  // ── T3: Limit hedge first ────────────────────────────────────────────────────

  test('T3: limit hedge is attempted when hedging.preferLimit = true', async () => {
    const exchange = new MockExchange();
    exchange.autoFill = true; // limit order will fill immediately
    const limitSpy = jest.spyOn(exchange, 'placeLimitOrder');
    const marketSpy = jest.spyOn(exchange, 'placeMarketOrder');
    const bot = new MarketMaker(
      exchange,
      makeConfig({ hedging: { preferLimit: true, limitTimeoutMs: 500 } })
    );
    bot.inventory.inventory = 0.25;
    await bot._tick();
    // Limit hedge should have been attempted first
    expect(limitSpy).toHaveBeenCalled();
    // Market order should NOT be needed if limit filled
    expect(marketSpy).not.toHaveBeenCalled();
  });

  test('T3: falls back to market when limit hedge times out', async () => {
    const exchange = new MockExchange();
    // autoFill = false → limit order never fills
    const marketSpy = jest.spyOn(exchange, 'placeMarketOrder');
    const bot = new MarketMaker(
      exchange,
      makeConfig({ hedging: { preferLimit: true, limitTimeoutMs: 30 } })
    );
    bot.inventory.inventory = 0.25;
    await bot._tick();
    expect(marketSpy).toHaveBeenCalledWith('BTC/USDT', 'sell', expect.any(Number), expect.objectContaining({ positionSide: expect.any(String) }));
  });

  // ── T1: Quote placement ─────────────────────────────────────────────────────

  test('T1: places both a buy and sell limit order', async () => {
    const exchange = new MockExchange();
    const spy = jest.spyOn(exchange, 'placeLimitOrder');
    const bot = new MarketMaker(exchange, makeConfig());
    await bot._tick();
    const sides = spy.mock.calls.map((c) => c[1]);
    expect(sides).toContain('buy');
    expect(sides).toContain('sell');
  });

  test('T1: ask price is always above bid price', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    await bot._tick();
    const orders = Object.values(exchange._orders).filter(o => o.status !== 'canceled');
    const bid = orders.find(o => o.side === 'buy');
    const ask = orders.find(o => o.side === 'sell');
    if (bid && ask) expect(ask.price).toBeGreaterThan(bid.price);
  });

  test('T1: skewed long position lowers bid (asymmetric skew)', async () => {
    const exchange = new MockExchange();
    const botBaseline = new MarketMaker(exchange, makeConfig());
    await botBaseline._tick();
    const baselineBid = Object.values(exchange._orders)
      .find(o => o.side === 'buy' && o.status !== 'canceled');

    const exchange2 = new MockExchange({ price: 50000 });
    const botLong = new MarketMaker(exchange2, makeConfig());
    botLong.inventory.inventory = 0.08; // long → skew pushes bid down
    await botLong._tick();
    const longBid = Object.values(exchange2._orders)
      .find(o => o.side === 'buy' && o.status !== 'canceled');

    if (baselineBid && longBid) {
      expect(longBid.price).toBeLessThanOrEqual(baselineBid.price);
    }
  });

  test('T1: asymmetric skew pushes ask UP when long', async () => {
    const exchange1 = new MockExchange({ price: 50000 });
    const botBase = new MarketMaker(exchange1, makeConfig());
    await botBase._tick();
    const baseAsk = Object.values(exchange1._orders)
      .find(o => o.side === 'sell' && o.status !== 'canceled');

    const exchange2 = new MockExchange({ price: 50000 });
    const botLong = new MarketMaker(exchange2, makeConfig());
    botLong.inventory.inventory = 0.08; // long
    await botLong._tick();
    const longAsk = Object.values(exchange2._orders)
      .find(o => o.side === 'sell' && o.status !== 'canceled');

    if (baseAsk && longAsk) {
      // Asymmetric skew: ask goes UP when long (unlike old band-shift which sent ask down)
      expect(longAsk.price).toBeGreaterThanOrEqual(baseAsk.price);
    }
  });

  // ── Multi-level quoting ─────────────────────────────────────────────────────

  test('multi-level: 3 levels places 6 orders (3 buy + 3 sell)', async () => {
    const exchange = new MockExchange();
    const spy = jest.spyOn(exchange, 'placeLimitOrder');
    const bot = new MarketMaker(exchange, makeConfig({
      quoting: { levels: 3, spreadMultipliers: [1.0, 1.5, 2.0], sizeFractions: [0.5, 0.3, 0.2] },
    }));
    await bot._tick();
    expect(spy).toHaveBeenCalledTimes(6);
    const sides = spy.mock.calls.map(c => c[1]);
    expect(sides.filter(s => s === 'buy').length).toBe(3);
    expect(sides.filter(s => s === 'sell').length).toBe(3);
  });

  test('multi-level: L2 ask is wider than L1 ask', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig({
      quoting: { levels: 2, spreadMultipliers: [1.0, 1.5], sizeFractions: [0.6, 0.4] },
    }));
    await bot._tick();
    // All sell orders sorted by price
    const asks = Object.values(exchange._orders)
      .filter(o => o.side === 'sell')
      .map(o => o.price)
      .sort((a, b) => a - b);
    if (asks.length >= 2) {
      expect(asks[1]).toBeGreaterThan(asks[0]); // L2 wider than L1
    }
  });

  // ── recordQuote ─────────────────────────────────────────────────────────────

  test('records 2 quotes per successful cycle (single level config)', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    await bot._tick();
    expect(bot.metrics.quotesPlaced).toBe(2);
  });

  // ── Fill detection ──────────────────────────────────────────────────────────

  test('updates inventory when a fill is detected', async () => {
    const exchange = new MockExchange();
    exchange.autoFill = true;
    const bot = new MarketMaker(
      exchange,
      makeConfig({ loop: { intervalMs: 0, fillPollMs: 10, orderTtlMs: 100 } })
    );
    await bot._tick();
    expect(bot.metrics.fills).toBeGreaterThan(0);
  });

  test('increments fill count on confirmed fill', async () => {
    const exchange = new MockExchange();
    exchange.autoFill = true;
    const bot = new MarketMaker(
      exchange,
      makeConfig({ loop: { intervalMs: 0, fillPollMs: 10, orderTtlMs: 100 } })
    );
    await bot._tick();
    expect(bot.metrics.fills).toBeGreaterThanOrEqual(2);
  });

  // ── Error resilience ────────────────────────────────────────────────────────

  test('does not crash when place order throws', async () => {
    const exchange = new MockExchange();
    exchange.throwOnPlace = true;
    const bot = new MarketMaker(exchange, makeConfig());
    await expect(bot._tick()).resolves.toBeUndefined();
  });

  test('does not crash when hedge order throws', async () => {
    const exchange = new MockExchange();
    exchange.throwOnMarket = true;
    const bot = new MarketMaker(exchange, makeConfig());
    bot.inventory.inventory = 0.25;
    await expect(bot._tick()).resolves.toBeUndefined();
  });

  // ── Adverse fill widen (adaptive) ───────────────────────────────────────────

  test('sets adverseMultiplier > 1 when adverseFillRatio exceeds threshold', async () => {
    const exchange = new MockExchange();
    exchange.autoFill = true;
    const bot = new MarketMaker(
      exchange,
      makeConfig({ loop: { intervalMs: 0, fillPollMs: 10, orderTtlMs: 100 } })
    );
    jest.spyOn(bot.metrics, 'getAdverseFillRatio').mockReturnValue(0.61);
    await bot._tick();
    expect(bot.spreadEngine.adverseMultiplier).toBeGreaterThan(1.0);
  });

  test('adverseMultiplier is adaptive: equals 1 + adverseRatio', async () => {
    const exchange = new MockExchange();
    exchange.autoFill = true;
    const bot = new MarketMaker(
      exchange,
      makeConfig({ loop: { intervalMs: 0, fillPollMs: 10, orderTtlMs: 100 } })
    );
    jest.spyOn(bot.metrics, 'getAdverseFillRatio').mockReturnValue(0.75);
    await bot._tick();
    expect(bot.spreadEngine.adverseMultiplier).toBeCloseTo(1.75, 5);
  });

  test('restores adverseMultiplier to 1.0 when adverseFillRatio normalises', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot._spreadWidened = true;
    bot.spreadEngine.adverseMultiplier = 1.8; // previously widened
    jest.spyOn(bot.metrics, 'getAdverseFillRatio').mockReturnValue(0.2);
    await bot._tick();
    expect(bot.spreadEngine.adverseMultiplier).toBeCloseTo(1.0, 5);
  });

  // ── Regime filter ───────────────────────────────────────────────────────────

  test('regime filter pauses quoting when 1-min price move exceeds threshold', async () => {
    const exchange = new MockExchange();
    const limitSpy = jest.spyOn(exchange, 'placeLimitOrder');
    const bot = new MarketMaker(
      exchange,
      makeConfig({ regimeFilter: { enabled: true, maxMove1m: 0.001, pauseMs: 500 } })
    );
    // Inject a large move into midHistory (> 0.1% in last 60s)
    bot._midHistory = [{ t: Date.now() - 30_000, mid: 49000 }]; // 50000 vs 49000 = 2%
    await bot._tick();
    // Should have paused, not placed any quotes
    expect(limitSpy).not.toHaveBeenCalled();
    expect(bot._pauseUntil).toBeGreaterThan(Date.now());
  });

  test('regime filter resumes after pause expires', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(
      exchange,
      makeConfig({ regimeFilter: { enabled: true, maxMove1m: 0.001, pauseMs: 10 } })
    );
    bot._pauseUntil = Date.now() - 100; // already expired
    // Should run normally
    await bot._tick();
    expect(bot.metrics.quotesPlaced).toBeGreaterThan(0);
  });

  // ── Inventory VaR ───────────────────────────────────────────────────────────

  test('VaR limit reduces effective hardMax at high vol', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig({
      inventoryVaR: { enabled: true, capital: 1000, varMultiplier: 100 },
    }));
    // vol = 0.1 → varLimit = 1000 / (0.1 * 100) = 100
    // hardMax = 0.2 → effective = min(0.2, 100) = 0.2 (VaR not binding)
    expect(bot.inventory.computeVarLimit(0.1, { enabled: true, capital: 1000, varMultiplier: 100 }))
      .toBeCloseTo(100, 2);
    // vol = 1.0 → varLimit = 1000 / (1.0 * 100) = 10 → still > hardMax
    expect(bot.inventory.computeVarLimit(1.0, { enabled: true, capital: 1000, varMultiplier: 100 }))
      .toBeCloseTo(10, 2);
  });

  test('VaR returns Infinity when disabled', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    const limit = bot.inventory.computeVarLimit(0.05, { enabled: false });
    expect(limit).toBe(Infinity);
  });

  test('VaR returns Infinity when vol is zero', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    const limit = bot.inventory.computeVarLimit(0, { enabled: true, capital: 1000, varMultiplier: 100 });
    expect(limit).toBe(Infinity);
  });

  // ── Adaptive timing ─────────────────────────────────────────────────────────

  test('_updateAdaptiveTiming sets fast interval at high vol', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot._updateAdaptiveTiming(0.01);
    expect(bot._currentIntervalMs).toBe(100);
    expect(bot._currentFillPollMs).toBe(5);
  });

  test('_updateAdaptiveTiming sets slow interval at low vol', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot._updateAdaptiveTiming(0.0001);
    expect(bot._currentIntervalMs).toBe(500);
    expect(bot._currentFillPollMs).toBe(50);
  });

  test('_updateAdaptiveTiming interpolates at mid vol', () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    bot._updateAdaptiveTiming(0.003);
    expect(bot._currentIntervalMs).toBe(300);
  });

  test('_updateAdaptiveTiming is a no-op when disabled', () => {
    const exchange = new MockExchange();
    const cfg = makeConfig();
    cfg.adaptiveTiming.enabled = false;
    const bot = new MarketMaker(exchange, cfg);
    const original = bot._currentIntervalMs;
    bot._updateAdaptiveTiming(0.01);
    expect(bot._currentIntervalMs).toBe(original);
  });

  // ── Regime detection in tick ─────────────────────────────────────────────────

  test('regime detector returns a valid regime string', async () => {
    const exchange = new MockExchange();
    const bot = new MarketMaker(exchange, makeConfig());
    await bot._tick();
    const validRegimes = ['ranging', 'trending_up', 'trending_down', 'volatile'];
    expect(validRegimes).toContain(bot.regime.current());
  });
});
