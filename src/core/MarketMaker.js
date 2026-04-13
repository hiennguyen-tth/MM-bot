'use strict';

const SpreadEngine = require('./SpreadEngine');
const RegimeDetector = require('./RegimeDetector');
const QuoteEngine = require('./QuoteEngine');
const InventoryManager = require('../risk/InventoryManager');
const CircuitBreaker = require('../risk/CircuitBreaker');
const MetricsCollector = require('../metrics/MetricsCollector');
const logger = require('../metrics/Logger');
const TelegramAlert = require('../alerts/TelegramAlert');
const { roundTo } = require('../utils/math');

/**
 * MarketMaker v3 – Production-grade market-making loop.
 *
 * Cycle: T4 → regime filter → fetch data → spread (5 layers) →
 *        fair price (microprice + flow + decay) → T3 hedge check →
 *        multi-level quotes → fill poll (parallel) → metrics → sleep
 */
class MarketMaker {
    constructor(exchange, config) {
        this.exchange = exchange;
        this.config = config;
        this.symbol = config.symbol;

        this.spreadEngine = new SpreadEngine(
            config.spread,
            config.dynamicSpread,
            config.imbalance,
            config.fillRateFeedback
        );
        this.regime = new RegimeDetector(config.regime || { enabled: false });
        this.quoteEngine = new QuoteEngine(config.quoting || {});
        this.inventory = new InventoryManager(config.inventory);
        this.circuitBreaker = new CircuitBreaker(config.risk);
        this.metrics = new MetricsCollector();
        this.metrics.adverseFillWindow = config.risk.adverseFillWindow;
        this._telegram = new TelegramAlert(config.alert?.telegram ?? {});

        // ── Cache hot-path config to avoid repeated optional-chain lookups ──────
        this._rf = config.regimeFilter || {};
        this._latency = config.latency || {};
        this._flowEnabled = config.flow?.enabled !== false;
        this._flowAlpha = config.flow?.emaAlpha || 0.2;
        this._flowKappa = this._flowEnabled ? (config.flow?.kappa || 0.0002) : 0;
        this._decayGamma = config.inventory?.decayGamma || 0;
        this._maxSpreadFraction = config.dynamicSpread?.maxSpreadFraction ?? 0.05;
        this._adverseThreshold = config.risk.adverseFillThreshold;

        // ── Cancel-rate guard (avoids BingX 109400 cancel-rate ban) ──────────
        // Only cancel+replace when price or spread moved enough.
        // Carries live orders across ticks while quotes remain valid.
        this._requoteThreshold = config.requote?.priceThreshold ?? 0.0002;    // 2 bps min price drift
        this._spreadChangeMin = config.requote?.spreadChangeThreshold ?? 0.0001;
        this._minCancelMs = config.requote?.minCancelIntervalMs ?? 5_000;  // cooldown between cancels
        this._maxCancelPerMin = config.requote?.maxCancelPerMin ?? 20;         // hard cap/min
        this._maxOrderAgeMs = config.requote?.maxOrderAgeMs ?? 120_000;      // 2 min max order life
        this._lastCancelTime = 0;
        this._cancelCount = 0;
        this._cancelWindowStart = 0;
        this._lastQuotedSpread = 0;
        this._lastPlacedTime = 0;

        // ── v4: Inventory-based spread widening ───────────────────────────────────
        // spread += invSpreadK × |invRatio|  → wider when inventory is skewed
        this._invSpreadK = config.invSpread?.k ?? 0;

        // ── v4: Dynamic size (∝ 1/vol) ────────────────────────────────────────────
        // size_mult = clamp(targetVol / vol, minMult, maxMult)
        const ds = config.dynSize || {};
        this._dynSizeEnabled = ds.enabled === true;
        this._dynSizeTargetVol = ds.targetVol || 0.001;
        this._dynSizeMinMult = ds.minMult || 0.5;
        this._dynSizeMaxMult = ds.maxMult || 2.0;

        // ── v4: Funding rate bias ─────────────────────────────────────────────────
        // fairPrice -= fundingBiasK × fundingRate × mid  (positive funding → short bias)
        const fb = config.fundingBias || {};
        this._fundingBiasEnabled = fb.enabled === true;
        this._fundingBiasK = fb.k || 0.5;
        this._fundingBiasFetchInterval = fb.fetchIntervalMs || 60_000;
        this._fundingRate = 0;
        this._lastFundingFetch = 0;

        // ── v4: Toxic flow filter ─────────────────────────────────────────────────
        // Pause quoting briefly when large directional sweep detected in trade data
        const tf = config.toxicFlow || {};
        this._toxicFlowEnabled = tf.enabled === true;
        this._toxicSideRatio = tf.sideRatio || 0.82;
        this._toxicVwapThreshold = tf.vwapThreshold || 0.0004;
        this._toxicPauseMs = tf.pauseMs || 3_000;

        this.running = false;
        this._openOrders = [];
        this._lastMid = null;
        this._spreadWidened = false;
        this._flowEMA = 0;
        this._currentIntervalMs = config.loop.intervalMs;
        this._currentFillPollMs = config.loop.fillPollMs;
        this._pauseUntil = 0;
        this._midHistory = [];
        this._quotedMid = null;
        this._lastQuotedInvSign = undefined;
    }

    // ─── Public ───────────────────────────────────────────────────────────────

    async start() {
        this.running = true;
        logger.info('MarketMaker v3 starting', {
            symbol: this.symbol,
            testnet: this.config.exchange.testnet,
            quoteLevels: this.config.quoting?.levels ?? 3,
            dynamicSpread: this.config.dynamicSpread?.enabled ?? false,
            imbalanceSpread: this.config.imbalance?.enabled ?? false,
            adaptiveTiming: this.config.adaptiveTiming?.enabled ?? false,
            regimeDetection: this.config.regime?.enabled ?? false,
            regimeFilter: this.config.regimeFilter?.enabled ?? false,
            latencyProtect: this.config.latency?.enabled ?? false,
            inventoryVaR: this.config.inventoryVaR?.enabled ?? false,
            timeOfDay: this.config.timeOfDay?.enabled ?? false,
            flowSignal: this.config.flow?.enabled !== false,
            fillRateFeedback: this.config.fillRateFeedback?.enabled ?? false,
            skewSteepness: this.config.quoting?.skewSteepness ?? 1.5,
            invDecayGamma: this.config.inventory?.decayGamma ?? 0,
        });

        // ── Clean slate: cancel any orphaned orders from previous runs ──────────
        // Prevents stale orders accumulating across restarts (e.g. after a ban).
        try {
            await this.exchange.cancelAllOrders(this.symbol);
            logger.info('Startup: cancelled any existing open orders');
        } catch (err) {
            logger.warn('Startup: could not cancel existing orders (may be none)', { error: err.message });
        }

        // ── Sync inventory from exchange position (survives restarts) ───────────
        // Without this, after a restart the bot forgets existing positions and:
        //   - misquotes (no inventory skew)
        //   - sell orders try to open SHORT instead of close LONG → margin error
        try {
            const pos = await this.exchange.getPosition(this.symbol);
            if (pos.size !== 0) {
                this.inventory.setPosition(pos.size, pos.avgCost);
                logger.info('Startup: synced existing position from exchange', {
                    position: pos.size,
                    avgCost: pos.avgCost > 0 ? pos.avgCost.toFixed(2) : 'unknown',
                    invRatio: (pos.size / this.inventory.softMax).toFixed(3),
                    softMax: this.inventory.softMax,
                });
            } else {
                logger.info('Startup: no existing position (flat)');
            }
        } catch (err) {
            logger.warn('Startup: could not fetch position, starting from 0', { error: err.message });
        }

        while (this.running) {
            try {
                await this._tick();
            } catch (err) {
                logger.error('Unhandled error in tick, continuing', { error: err.message });
            }
            await this._sleep(this._currentIntervalMs);
        }
    }

    stop() {
        this.running = false;
        logger.info('MarketMaker stopped');
    }

    // ─── Main loop tick ───────────────────────────────────────────────────────

    async _tick() {
        // ── T4: Circuit breaker ────────────────────────────────────────────────
        const cbResult = this.circuitBreaker.check();
        if (!cbResult.ok) {
            await this._shutdown(cbResult.reason, cbResult.value);
            return;
        }

        // ── Regime filter: still in pause window? ─────────────────────────────
        const now = Date.now();
        if (now < this._pauseUntil) {
            logger.debug('Quoting paused by regime filter', {
                resumeIn: Math.round((this._pauseUntil - now) / 1000) + 's',
            });
            return;
        }

        // ── Fetch market data in parallel (critical + optional) ────────────────────
        const needFunding = this._fundingBiasEnabled &&
            now - this._lastFundingFetch >= this._fundingBiasFetchInterval;

        let orderBook, trades, fullTrades;
        {
            const [obRes, tradesRes, fullTradesRes, fundingRes] = await Promise.allSettled([
                this.exchange.getOrderBook(this.symbol),
                this.exchange.getRecentTrades(this.symbol, this.config.spread.volLookback),
                this._toxicFlowEnabled
                    ? this.exchange.getTrades(this.symbol, 20)
                    : Promise.resolve([]),
                needFunding
                    ? this.exchange.getFundingRate(this.symbol)
                    : Promise.resolve(null),
            ]);

            if (obRes.status === 'rejected' || tradesRes.status === 'rejected') {
                logger.error('Failed to fetch market data', {
                    error: (obRes.reason ?? tradesRes.reason)?.message,
                });
                return;
            }

            orderBook = obRes.value;
            trades = tradesRes.value;
            fullTrades = fullTradesRes.status === 'fulfilled' ? fullTradesRes.value : [];

            if (needFunding && fundingRes.status === 'fulfilled' && fundingRes.value !== null) {
                this._fundingRate = fundingRes.value;
                this._lastFundingFetch = now;
                logger.debug('Funding rate updated', { fundingRate: this._fundingRate.toFixed(6) });
            }
        }

        const { bid, ask, mid, bidVolume = 0, askVolume = 0 } = orderBook;
        this._lastMid = mid;

        // Microprice: volume-weighted fair value (better reference than plain mid)
        const topVolTotal = bidVolume + askVolume;
        const microprice = topVolTotal > 0
            ? (bid * askVolume + ask * bidVolume) / topVolTotal
            : mid;

        // ── Track mid history for regime filter (ring-buffer style) ───────────
        this._midHistory.push({ t: now, mid });
        // Trim expired entries from front (O(k) where k=expired, not O(n))
        while (this._midHistory.length > 0 && now - this._midHistory[0].t >= 90_000) {
            this._midHistory.shift();
        }

        // ── Regime filter: check 1-minute price move ───────────────────────────
        if (this._rf.enabled && this._midHistory.length > 1) {
            const oldest = this._midHistory.find(e => e.t >= now - 60_000);
            if (oldest && oldest.mid !== 0) {
                const move1m = Math.abs(mid - oldest.mid) / oldest.mid;
                if (move1m > this._rf.maxMove1m) {
                    logger.warn('Regime filter triggered – pausing quoting', {
                        move1m: (move1m * 100).toFixed(3) + '%',
                        threshold: (this._rf.maxMove1m * 100).toFixed(1) + '%',
                        pauseMs: this._rf.pauseMs,
                    });
                    this._pauseUntil = now + this._rf.pauseMs;
                    await this._cancelOpenOrders(true);
                    return;
                }
            }
        }

        // ── Feed trade prices into spread engine (batch) ───────────────────────
        this.spreadEngine.addPriceBatch(trades);

        // ── Orderbook imbalance + flow EMA ─────────────────────────────────────
        const totalVol = bidVolume + askVolume;
        const imbalance = totalVol > 0 ? (bidVolume - askVolume) / totalVol : 0;

        if (this._flowEnabled) {
            this._flowEMA = this._flowAlpha * imbalance + (1 - this._flowAlpha) * this._flowEMA;
        }

        // ── Regime detection ───────────────────────────────────────────────────
        const dryVol = this._computeDryVol(mid);
        const detectedRegime = this.regime.detect(this.spreadEngine.priceHistory, dryVol);

        // ── Compute adaptive spread ────────────────────────────────────────────
        this.spreadEngine.fillRate = this.metrics.getFillRate();
        const { spread, vol, regime } = this.spreadEngine.compute(mid, detectedRegime, imbalance);

        // ── Adaptive timing ────────────────────────────────────────────────────
        this._updateAdaptiveTiming(vol);

        // ── Inventory VaR limit + T3 guard ────────────────────────────────────
        const varLimit = this.inventory.computeVarLimit(vol, this.config.inventoryVaR);
        if (this.inventory.isAtHardLimit(varLimit)) {
            await this._hedgeInventory(mid, varLimit);
            return;
        }

        // ── T2: inventory ratio + order size ───────────────────────────────────
        const { ratio, orderSize } = this.inventory.compute(spread);

        // ── Time-of-day multipliers ────────────────────────────────────────────
        const tod = this._getTimeOfDayMults();

        // ── v4 Layer 6: inventory-based spread widening ───────────────────────
        // spread += invSpreadK × |ratio|  (wider spread when position is skewed)
        const invSpreadAdj = this._invSpreadK * Math.abs(ratio);
        const effectiveSpread = Math.min(
            spread * tod.spreadMult + invSpreadAdj,
            this._maxSpreadFraction
        );

        // ── v4: Dynamic size (∝ 1/vol) ────────────────────────────────────────
        // In high vol → smaller size (risk cut). In low vol → larger (more edge).
        const volSizeMult = this._dynSizeEnabled && vol > 0
            ? Math.max(this._dynSizeMinMult, Math.min(this._dynSizeMaxMult, this._dynSizeTargetVol / vol))
            : 1;
        const effectiveSize = orderSize * tod.sizeMult * volSizeMult;

        // ── Fair price: microprice + flow + inventory decay + funding bias ─────────
        //   flowAdj     = κ × flowEMA × mid   (aggressor flow signal)
        //   invDecay    = −γ × ratio × vol × mid  (AS reservation price)
        //   fundingAdj  = −fundingBiasK × fundingRate × mid  (funding cost signal)
        //                 positive funding → longs pay → bias short → lower fairPrice
        const flowAdj = this._flowKappa * this._flowEMA * mid;
        const invDecay = this._decayGamma > 0 ? -this._decayGamma * ratio * vol * mid : 0;
        const fundingAdj = this._fundingBiasEnabled
            ? -this._fundingBiasK * this._fundingRate * mid
            : 0;
        const fairPrice = microprice + flowAdj + invDecay + fundingAdj;

        // ── Build multi-level quotes ───────────────────────────────────────────
        const quotes = this.quoteEngine.buildQuotes({
            mid,
            spread: effectiveSpread,
            ratio,
            skewFactor: this.config.inventory.skewFactor,
            orderSize: effectiveSize,
            fairPrice,
        });

        if (quotes.length === 0) {
            logger.warn('No valid quotes generated, skipping cycle');
            return;
        }

        // ── v4: Toxic flow filter ──────────────────────────────────────────────────
        // If recent trades show a large directional sweep (e.g. whale buying),
        // we hold our existing quotes and wait rather than refreshing into bad fills.
        // We still poll fills so any resting orders can complete.
        if (this._toxicFlowEnabled && this._detectToxicFlow(fullTrades, mid)) {
            await this._sleep(this._toxicPauseMs);
            await this._pollFills(mid);
            return;
        }

        // ── Requote guard: skip cancel+replace when quotes are still valid ────────
        // Core anti-ban logic: BingX bans if cancel rate > 99% in 1 hour.
        // Only cancel+replace when meaningfully needed.
        if (this._openOrders.length > 0) {
            const priceDrift = this._quotedMid
                ? Math.abs(mid - this._quotedMid) / this._quotedMid
                : 1;
            const spreadDrift = Math.abs(effectiveSpread - this._lastQuotedSpread);
            const orderAge = now - this._lastPlacedTime;

            // Force requote when inventory crosses zero: existing orders have
            // stale positionSide (e.g. SHORT-sell placed when flat, but now LONG)
            // which causes BingX "No position to close" errors.
            const currInvSign = Math.sign(this.inventory.getInventory());
            const invSignChanged = this._lastQuotedInvSign !== undefined &&
                this._lastQuotedInvSign !== 0 &&
                currInvSign !== this._lastQuotedInvSign;

            // 1. Skip if price + spread haven't moved enough AND orders aren't stale
            if (!invSignChanged &&
                priceDrift < this._requoteThreshold &&
                spreadDrift < this._spreadChangeMin &&
                orderAge < this._maxOrderAgeMs) {
                logger.debug('Requote skipped – quotes still valid', {
                    priceDrift: (priceDrift * 10_000).toFixed(1) + ' bps',
                    ageS: Math.round(orderAge / 1000),
                });
                await this._pollFills(mid);
                return;
            }

            // 2. Cancel cooldown: enforce minimum interval between cancels
            if (now - this._lastCancelTime < this._minCancelMs) {
                logger.debug('Requote skipped – cancel cooldown active', {
                    waitMs: this._minCancelMs - (now - this._lastCancelTime),
                });
                await this._pollFills(mid);
                return;
            }

            // 3. Hard cap: max cancels per minute
            if (now - this._cancelWindowStart > 60_000) {
                this._cancelCount = 0;
                this._cancelWindowStart = now;
            }
            if (this._cancelCount >= this._maxCancelPerMin) {
                logger.warn('Cancel rate cap reached – holding existing quotes', {
                    count: this._cancelCount,
                    maxPerMin: this._maxCancelPerMin,
                });
                await this._pollFills(mid);
                return;
            }
        }

        // Cancel previous cycle then place new quotes
        await this._cancelOpenOrders(false);
        const placed = await this._placeQuotes(quotes);
        if (placed.length === 0) {
            logger.error('All quote placements failed');
            return;
        }

        this._openOrders = placed;
        this._quotedMid = mid;
        this._lastQuotedSpread = effectiveSpread;
        this._lastPlacedTime = now;
        this._lastQuotedInvSign = Math.sign(this.inventory.getInventory());

        const bidL1 = quotes.find(q => q.side === 'buy' && q.level === 1)?.price;
        const askL1 = quotes.find(q => q.side === 'sell' && q.level === 1)?.price;
        logger.info('Quotes placed', {
            orders: placed.length,
            bidL1,
            askL1,
            spread: effectiveSpread.toFixed(6),
            invSpreadAdj: invSpreadAdj.toFixed(6),
            imbalance: imbalance.toFixed(3),
            flowEMA: this._flowEMA.toFixed(4),
            microprice: microprice.toFixed(2),
            fairPrice: fairPrice.toFixed(2),
            invDecay: invDecay.toFixed(4),
            fundingRate: this._fundingBiasEnabled ? this._fundingRate.toFixed(6) : undefined,
            dynSizeMult: volSizeMult.toFixed(3),
            vol: vol.toFixed(6),
            regime,
            invRatio: ratio.toFixed(3),
            fillRate: this.spreadEngine.fillRate.toFixed(4),
            intervalMs: this._currentIntervalMs,
        });

        // ── Monitor fills (with latency protection) ────────────────────────────
        const deadline = now + this.config.loop.orderTtlMs;
        while (Date.now() < deadline && this._openOrders.length > 0) {
            await this._sleep(this._currentFillPollMs);

            if (this._shouldCancelOnLatency()) {
                logger.warn('Latency protection: mid drifted, cancelling quotes', {
                    quotedMid: this._quotedMid,
                    lastMid: this._lastMid,
                    threshold: (this._latency.cancelThreshold ?? 0.001) * 100 + '%',
                });
                await this._cancelOpenOrders(true);
                break;
            }

            await this._pollFills(mid);
        }

        // ── Carry-forward: keep orders alive if still young, reduce cancel count ─
        // Only cancel at end-of-TTL if orders genuinely stale (age > maxOrderAge).
        // Otherwise carry to next tick; the requote guard will decide then.
        if (this._openOrders.length > 0) {
            const orderAge = Date.now() - this._lastPlacedTime;
            if (orderAge >= this._maxOrderAgeMs) {
                await this._cancelOpenOrders(true); // stale — must cancel
            } else {
                logger.debug('Orders carried to next tick – quotes still young', {
                    ageS: Math.round(orderAge / 1000),
                });
                // _openOrders intact — next tick's guard will re-evaluate
            }
        }

        // ── Metrics + adaptive adverse multiplier ──────────────────────────────
        const snap = this.metrics.getSnapshot();
        logger.info('Metrics', { ...snap, regime });
        await this._telegram.maybeSendMetrics(snap, regime);

        const adverseRatio = parseFloat(snap.adverseFillRatio);
        if (adverseRatio > this._adverseThreshold) {
            if (!this._spreadWidened) {
                logger.warn('Adverse fill ratio high – widening spread adaptively', {
                    adverseRatio,
                    adverseMultiplier: (1 + adverseRatio).toFixed(3),
                });
                this._spreadWidened = true;
            }
            this.spreadEngine.adverseMultiplier = 1 + adverseRatio;
        } else {
            if (this._spreadWidened) {
                logger.info('Adverse fill ratio normalised – restoring spread');
                this._spreadWidened = false;
            }
            this.spreadEngine.adverseMultiplier = 1.0;
        }
    }


    // ─── T3: Hedge inventory ──────────────────────────────────────────────────

    /**
     * Emergency inventory reduction.
     * Tries a passive limit order first (lower fee + slippage), then falls
     * back to market order if limit doesn't fill within hedging.limitTimeoutMs.
     */
    async _hedgeInventory(mid, varLimit = Infinity) {
        const side = this.inventory.hedgeSide();
        const size = this.inventory.hedgeSize(varLimit);

        logger.warn('T3 hard limit triggered – hedging', {
            inventory: this.inventory.getInventory(),
            side,
            size,
            varLimit: isFinite(varLimit) ? varLimit.toFixed(4) : 'off',
        });

        const hedging = this.config.hedging;

        if (hedging?.preferLimit) {
            // Price just inside mid to get passive fill quickly
            const limitPrice = side === 'sell'
                ? roundTo(mid * (1 - this.config.spread.fee), 2)
                : roundTo(mid * (1 + this.config.spread.fee), 2);

            try {
                const limitOrder = await this.exchange.placeLimitOrder(
                    this.symbol, side, limitPrice, size
                );

                // Poll until filled or timeout
                const deadline = Date.now() + (hedging.limitTimeoutMs || 2000);
                while (Date.now() < deadline) {
                    await this._sleep(200);
                    const ord = await this.exchange.getOrder(limitOrder.id, this.symbol);
                    if ((ord.status === 'closed' || ord.filled >= size * 0.9) && ord.filled > 0) {
                        this.inventory.update(ord.filled, side, ord.average || ord.price || 0);
                        logger.info('Limit hedge filled', { side, filled: ord.filled, price: ord.average });
                        return;
                    }
                }

                // Cancel unfilled limit and fall through to market
                await this.exchange.cancelOrder(limitOrder.id, this.symbol).catch(() => { });
                logger.warn('Limit hedge timed out – falling back to market order');
            } catch (err) {
                logger.warn('Limit hedge failed – falling back to market order', { error: err.message });
            }
        }

        // Market hedge fallback
        try {
            const hedgeOrder = await this.exchange.placeMarketOrder(this.symbol, side, size);
            const filled = hedgeOrder.filled || size;
            const fillPrice = hedgeOrder.average || hedgeOrder.price || 0;
            this.inventory.update(filled, side, fillPrice);
            logger.info('Market hedge filled', { side, filled, price: fillPrice });
        } catch (err) {
            logger.error('Hedge order failed', { error: err.message });
        }
    }

    // ─── Quote placement ──────────────────────────────────────────────────────

    async _placeQuotes(quotes) {
        // ── Two-sided positionSide for BingX Hedge Mode ───────────────────────
        // Determines correct BingX positionSide per quote based on current inventory:
        //
        //   inventory >= 0  →  buy: open/add LONG   │  sell: reduce/close LONG
        //   inventory <  0  →  buy: reduce/close SHORT │  sell: open/add SHORT
        //
        // This gives the bot true two-sided MM: it opens LONG on buy fills when
        // flat, and opens SHORT on sell fills when flat (hedged, two-directional).
        const inv = this.inventory.getInventory();
        const results = await Promise.allSettled(
            quotes.map(q => {
                const positionSide = q.side === 'buy'
                    ? (inv < 0 ? 'SHORT' : 'LONG')   // close short OR open long
                    : (inv > 0 ? 'LONG' : 'SHORT');  // close long  OR open short
                return this.exchange.placeLimitOrder(
                    this.symbol, q.side, q.price, q.amount, { positionSide }
                );
            })
        );

        const placed = [];
        for (let i = 0; i < quotes.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                placed.push({ ...quotes[i], order: r.value, _processedQty: 0 });
                this.metrics.recordQuote();
            } else {
                const msg = r.reason?.message || '';
                // BingX error 109400: cancel rate >99% in the rolling window → banned.
                // Pause for the full window duration (BingX window ≈ 10 min).
                // We use 12 min (2 min buffer) so the window has fully cleared
                // before we produce any new cancel/place events.
                if (msg.includes('109400')) {
                    const pauseMs = 12 * 60 * 1000; // 12 min (BingX 10-min window + 2 min buffer)
                    this._pauseUntil = Date.now() + pauseMs;
                    logger.warn('BingX cancel-rate ban detected – pausing quoting for 12 minutes', {
                        resumeAt: new Date(this._pauseUntil).toISOString(),
                    });
                    await this._telegram.maybeSendAlert(
                        '⚠️ BingX cancel-rate ban (code 109400). Pausing 12 min. Existing positions are safe.'
                    );
                    return []; // stop placing, let existing position stay
                }
                logger.error('Failed to place level quote', {
                    side: quotes[i].side,
                    level: quotes[i].level,
                    error: msg,
                });
            }
        }
        return placed;
    }

    // ─── Latency protection ───────────────────────────────────────────────────

    _shouldCancelOnLatency(midAtPlacement) {
        const lc = this.config.latency;
        if (!lc?.enabled || !this._lastMid || !this._quotedMid) return false;
        const drift = Math.abs(this._lastMid - this._quotedMid) / this._quotedMid;
        return drift > (lc.cancelThreshold ?? 0.001);
    }

    // ─── Fill polling ─────────────────────────────────────────────────────────

    async _pollFills(midAtPlacement) {
        // Fetch all orders in parallel — 1 round-trip regardless of order count
        const results = await Promise.allSettled(
            this._openOrders.map(q =>
                q.order ? this.exchange.getOrder(q.order.id, this.symbol) : Promise.resolve(null)
            )
        );

        const stillOpen = [];
        for (let i = 0; i < this._openOrders.length; i++) {
            const q = this._openOrders[i];
            if (!q.order) continue;

            const r = results[i];
            if (r.status === 'rejected') {
                logger.error('Error fetching order status', { id: q.order.id, error: r.reason?.message });
                stillOpen.push(q);
                continue;
            }

            const updated = r.value;
            const filled = updated.filled || 0;
            const prev = q._processedQty || 0;
            const newFill = filled - prev;

            if (newFill > 0) {
                const fillPrice = updated.average || updated.price || q.price;
                const fee = this.config.spread.fee;
                const prevInv = this.inventory.getInventory();
                const avgCost = this.inventory.getAvgCost();

                // ── True realized P&L using cost-basis ─────────────────────────
                // Opening a position: debit the maker fee (real cost).
                // Closing a position: (exit - entry) × qty − fee on both legs.
                //
                // This matches what BingX shows as "Lãi Lỗ đã thực hiện".
                // Unlike the old approach (profit vs midAtPlacement), this
                // accounts for price drift between buy-fill and sell-fill.
                let profit;
                const closingLong = q.side === 'sell' && prevInv > 0;
                const closingShort = q.side === 'buy' && prevInv < 0;

                if (closingLong) {
                    const closeQty = Math.min(newFill, prevInv);
                    // round-trip fees: open fee (at avgCost) + close fee (at fillPrice)
                    profit = (fillPrice - avgCost) * closeQty
                        - fee * avgCost * closeQty
                        - fee * fillPrice * closeQty;
                } else if (closingShort) {
                    const closeQty = Math.min(newFill, Math.abs(prevInv));
                    profit = (avgCost - fillPrice) * closeQty
                        - fee * avgCost * closeQty
                        - fee * fillPrice * closeQty;
                } else {
                    // Opening / adding to position: only the maker fee is a real cost
                    profit = -fee * fillPrice * newFill;
                }

                // Adverse = maker got a bad fill:
                //   closing long (sell) → filled below mid = bad
                //   closing short (buy) → filled above mid = bad
                const ref = this._lastMid || midAtPlacement;
                const isAdverse = closingLong
                    ? fillPrice < ref
                    : closingShort
                        ? fillPrice > ref
                        : false;

                this.inventory.update(newFill, q.side, fillPrice);
                // Only record CLOSING fills in circuit breaker (real realized P&L).
                // Opening fills have profit = −fee (always negative);
                // counting them as "losses" would unfairly trip consecutiveLossLimit.
                if (closingLong || closingShort) {
                    this.circuitBreaker.recordFill(profit);
                }
                this.metrics.recordFill({
                    profit,
                    inventoryAbs: Math.abs(this.inventory.getInventory()),
                    inventoryMax: this.inventory.softMax,
                    isAdverse,
                });

                logger.info('Fill processed', {
                    side: q.side,
                    level: q.level,
                    qty: newFill,
                    price: fillPrice,
                    avgCost: avgCost > 0 ? avgCost.toFixed(2) : 'n/a',
                    profit: profit.toFixed(8),
                    isAdverse,
                    inventory: this.inventory.getInventory().toFixed(6),
                });

                q._processedQty = filled;
            }

            if (!['closed', 'canceled', 'expired'].includes(updated.status)) stillOpen.push(q);
        }

        this._openOrders = stillOpen;
    }

    // ─── Cancel open orders ───────────────────────────────────────────────────

    async _cancelOpenOrders(log = false) {
        const toCancel = this._openOrders.filter(q => q.order);
        if (toCancel.length === 0) { this._openOrders = []; return; }

        // Track all cancels (BingX counts all, not just routine ones)
        const now = Date.now();
        if (now - this._cancelWindowStart > 60_000) {
            this._cancelCount = 0;
            this._cancelWindowStart = now;
        }
        this._cancelCount += toCancel.length;
        this._lastCancelTime = now;

        await Promise.allSettled(
            toCancel.map(q =>
                this.exchange.cancelOrder(q.order.id, this.symbol).then(() => {
                    if (log) logger.debug('Order cancelled', { side: q.side, level: q.level, id: q.order.id });
                })
            )
        );
        this._openOrders = [];
    }

    // ─── Adaptive timing ──────────────────────────────────────────────────────

    _updateAdaptiveTiming(vol) {
        const at = this.config.adaptiveTiming;
        if (!at || !at.enabled) return;

        const { minIntervalMs, maxIntervalMs, volThresholdHigh, volThresholdLow } = at;

        let t;
        if (vol >= volThresholdHigh) t = 1;
        else if (vol <= volThresholdLow) t = 0;
        else t = (vol - volThresholdLow) / (volThresholdHigh - volThresholdLow);

        this._currentIntervalMs = Math.round(maxIntervalMs - t * (maxIntervalMs - minIntervalMs));
        this._currentFillPollMs = Math.round(
            at.fillPollMsQuiet - t * (at.fillPollMsQuiet - at.fillPollMsVolatile)
        );
    }

    // ─── Time-of-day ─────────────────────────────────────────────────────────

    _getTimeOfDayMults() {
        const tod = this.config.timeOfDay;
        if (!tod?.enabled) return { spreadMult: 1, sizeMult: 1 };

        const hourUtc = new Date().getUTCHours();
        const us = tod.sessions?.us;
        if (us && hourUtc >= us.startHourUtc && hourUtc < us.endHourUtc) {
            return { spreadMult: us.spreadMult ?? 1.5, sizeMult: us.sizeMult ?? 0.7 };
        }
        return { spreadMult: 1, sizeMult: 1 };
    }

    // ─── Dry vol (estimate without mutating price history) ───────────────────

    _computeDryVol(mid) {
        const h = this.spreadEngine.priceHistory;
        const n = h.length;
        if (n < 2) return 0;
        // Welford single-pass online variance (avoids two-pass mean then variance)
        let mean = 0, M2 = 0;
        for (let i = 0; i < n; i++) {
            const delta = h[i] - mean;
            mean += delta / (i + 1);
            M2 += delta * (h[i] - mean);
        }
        return Math.sqrt(M2 / n) / mid;
    }

    // ─── v4: Toxic flow detection ─────────────────────────────────────────────
    //
    // Sweep criteria (both must be true):
    //   1. Dominant side ≥ sideRatio of all trades (e.g. 82%+ buys)
    //   2. Trade VWAP deviates > vwapThreshold from current mid
    //      (confirms trades were executed at off-mid prices = aggressive)
    //
    // On detection: caller sleeps toxicPauseMs, polls fills, returns early.
    // We do NOT cancel existing orders — they may be resting at good prices.
    _detectToxicFlow(trades, mid) {
        if (!trades || trades.length === 0) return false;

        let buyCount = 0, sellCount = 0;
        let vwapNum = 0, vwapDen = 0;

        for (const t of trades) {
            if (t.side === 'buy') buyCount++;
            else if (t.side === 'sell') sellCount++;
            if (t.amount > 0) {
                vwapNum += t.price * t.amount;
                vwapDen += t.amount;
            }
        }

        const total = buyCount + sellCount;
        if (total === 0) return false;

        const dominantFrac = Math.max(buyCount, sellCount) / total;
        const vwap = vwapDen > 0 ? vwapNum / vwapDen : mid;
        const vwapDev = mid > 0 ? Math.abs(vwap - mid) / mid : 0;

        const detected = dominantFrac >= this._toxicSideRatio && vwapDev >= this._toxicVwapThreshold;
        if (detected) {
            const side = buyCount >= sellCount ? 'BUY' : 'SELL';
            logger.warn('Toxic flow detected – holding quotes', {
                side,
                dominantFrac: dominantFrac.toFixed(3),
                vwapDev: (vwapDev * 10_000).toFixed(1) + ' bps',
                vwap: vwap.toFixed(2),
                mid: mid.toFixed(2),
                pauseMs: this._toxicPauseMs,
            });
        }
        return detected;
    }

    // ─── Shutdown ─────────────────────────────────────────────────────────────

    async _shutdown(reason, value) {
        this.running = false;
        logger.error('SHUTDOWN triggered', { reason, value });

        try {
            await this.exchange.cancelAllOrders(this.symbol);
            logger.info('All open orders cancelled');
        } catch (err) {
            logger.error('Failed to cancel orders on shutdown', { error: err.message });
        }

        const snap = this.metrics.getSnapshot();
        logger.info('Final metrics on shutdown', snap);
        await this._telegram.sendShutdown(reason, value, snap);
    }

    _sleep(ms) {
        return new Promise((res) => setTimeout(res, ms));
    }
}

module.exports = MarketMaker;
