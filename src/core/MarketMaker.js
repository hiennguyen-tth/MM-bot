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
        // 'oneway' (default) = BingX one-way mode, positionSide=BOTH
        // 'hedge'            = BingX Hedge Mode, separate LONG/SHORT positions
        this._positionMode = config.exchange?.positionMode || 'oneway';

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

        // ── Intra-cycle gap threshold ──────────────────────────────────────────────
        // Catch flash crashes / liquidation cascades not caught by the 1-min regime filter.
        // 0 = disabled (set INTRA_CYCLE_MAX_MOVE=0 to turn off).
        this._intraCycleMaxMove = config.regimeFilter?.intraCycleMaxMove ?? 0.003;
        // ── Minimum order size (exchange floor) ─────────────────────────────────────────────
        // BingX swap minimum is 0.0001 BTC. When inventory skew + dynamic sizing
        // brings per-level amounts below this floor, clamp up before placing.
        this._minOrderSize = config.inventory?.minOrderSize ?? 0.0001;
        // ── Unrealized loss limit (mark-to-market circuit breaker) ────────────────────────
        // Shutdown when open position is underwater by more than this many USDT.
        // Complements the consecutive-loss breaker which only fires on closing fills.
        // Infinity = disabled (default). Set via UNREALIZED_LOSS_LIMIT env var.
        this._unrealizedLossLimit = config.risk?.unrealizedLossLimit ?? Infinity;
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

        // ── v5: Inventory coupling in dynamic sizing ──────────────────────────
        // Multiplies effective size by (1 − |ratio|)^α — reduces size when position
        // is skewed, coupling risk exposure to inventory imbalance.
        // α=0 (default) disables. α=1 = linear taper. α=2 = quadratic.
        this._dynSizeInvAlpha = ds.invCouplingAlpha ?? 0;

        // ── v5: Queue position awareness ──────────────────────────────────────
        // Force a requote when our best resting order has slipped > N bps behind
        // the current best bid/ask (we fell back in the queue and lose priority).
        // 0 = disabled (default).
        this._requoteQueueDepthBps = config.requote?.queueDepthBps ?? 0;

        // ── v5: Smart kill-switch ─────────────────────────────────────────────
        // Two conditions (either can trigger shutdown):
        //   1. Vol spike with no edge: vol > threshold AND effectiveSpread < vol×1.5
        //   2. Fill-rate collapse: fills/quote < fillRateMin after minQuotes warmup
        const sk = config.smartKill || {};
        this._smartKillEnabled = sk.enabled === true;
        this._smartKillVolThreshold = sk.volThreshold || 0.008;
        this._smartKillFillRateMin = sk.fillRateMin || 0.001;
        this._smartKillMinQuotes = sk.minQuotes || 200;

        this.running = false;
        this._wsActive = false;
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
        logger.info('MarketMaker v4 starting', {
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
            fillDetection: this.exchange.hasWebSocket ? 'websocket+poll' : 'poll',
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

        // ── WebSocket order stream (BingX swap only) ────────────────────────────
        // Processes fills in <100ms vs ~1.5s average latency for REST polling.
        // REST polling still runs as a safety net — _processedQty guards double-count.
        if (this.exchange.hasWebSocket) {
            this._wsActive = true;
            this.exchange.watchOrders(this.symbol, order => this._handleWsOrderUpdate(order))
                .catch(err => {
                    logger.warn('WebSocket order stream terminated – relying on REST polling', {
                        error: err.message,
                    });
                    this._wsActive = false;
                });
            logger.info('WebSocket order stream started');
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
        if (this._wsActive) {
            this._wsActive = false;
            this.exchange.stopWatchOrders();
            logger.info('WebSocket order stream closed');
        }
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
        const prevCycleMid = this._lastMid; // save before overwrite — used for intra-cycle gap check
        this._lastMid = mid;

        // ── Unrealized P&L guard ──────────────────────────────────────────────────────────
        // Shuts down when the open position's mark-to-market loss exceeds
        // UNREALIZED_LOSS_LIMIT. Catches large underwater positions BEFORE any
        // closing fill, closing the gap in consecutive-loss circuit breaker.
        if (isFinite(this._unrealizedLossLimit)) {
            const inv = this.inventory.getInventory();
            const avgCost = this.inventory.getAvgCost();
            if (inv !== 0 && avgCost > 0) {
                // Long inv > 0: loss when mid < avgCost; short inv < 0: loss when mid > avgCost
                const unrealizedPnl = (mid - avgCost) * inv;
                if (unrealizedPnl < -this._unrealizedLossLimit) {
                    logger.error('Unrealized loss limit exceeded – shutting down', {
                        unrealized: unrealizedPnl.toFixed(4),
                        limit: this._unrealizedLossLimit,
                        inv,
                        avgCost,
                        mid,
                    });
                    await this._shutdown('unrealized_loss_limit', Math.abs(unrealizedPnl));
                    return;
                }
            }
        }

        // ── Intra-cycle gap check: catch flash crashes / liquidation cascades ────
        // The 1-min regime filter is too slow for a -2% gap in 5s.
        // Cancel immediately and impose the standard regime-filter pause.
        if (prevCycleMid !== null && this._intraCycleMaxMove > 0) {
            const gapMove = Math.abs(mid - prevCycleMid) / prevCycleMid;
            if (gapMove > this._intraCycleMaxMove) {
                logger.warn('Intra-cycle gap detected – cancelling quotes', {
                    gapMove: (gapMove * 100).toFixed(3) + '%',
                    threshold: (this._intraCycleMaxMove * 100).toFixed(1) + '%',
                });
                this._pauseUntil = now + this._rf.pauseMs;
                await this._cancelOpenOrders(true);
                return;
            }
        }

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

        // ── v4: Funding bias → inventory target ─────────────────────────────────────
        // Replaces the old price-shift approach (fundingAdj on fairPrice).
        // targetInv = −k × (fundingRate × 3)  [BTC; daily rate × k]
        // Shifts the perceived ratio so the bot behaves as if it already holds more
        // inventory when funding > 0 → sell bias, smaller size, wider sell skew.
        // Effect is naturally bounded: ratio clamped to [-1, 1] regardless of funding.
        //   K=0.5, normal funding (0.01%/8h): ~7.5% short bias at softMax=0.002
        //   K=0.5, high funding (0.1%/8h):    ~75% short bias (very strong)
        const fundingTargetInv = this._fundingBiasEnabled
            ? -this._fundingBiasK * (this._fundingRate * 3)
            : 0;

        // ── T2: inventory ratio + order size ───────────────────────────────────────
        const { ratio, orderSize } = this.inventory.compute(spread, fundingTargetInv);

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
        // When |invRatio| > 0.5 we're already skewed — cap at 1× to avoid amplifying
        // a one-sided position during calm (low-vol) periods.
        const dynSizeMaxMult = this._dynSizeEnabled && Math.abs(ratio) > 0.5
            ? 1.0
            : this._dynSizeMaxMult;
        const volSizeMult = this._dynSizeEnabled && vol > 0
            ? Math.max(this._dynSizeMinMult, Math.min(dynSizeMaxMult, this._dynSizeTargetVol / vol))
            : 1;
        // v5: Inventory coupling — shrink size proportionally to inventory skew.
        // (1 − |ratio|)^α: α=0 → no effect, α=1 → linear taper, α=2 → quadratic.
        const invCouplingMult = (this._dynSizeEnabled && this._dynSizeInvAlpha > 0)
            ? Math.pow(Math.max(0, 1 - Math.abs(ratio)), this._dynSizeInvAlpha)
            : 1;
        const effectiveSize = orderSize * tod.sizeMult * volSizeMult * invCouplingMult;

        // ── Fair price: microprice + flow + inventory decay ───────────────────────────
        //   flowAdj  = κ × flowEMA × mid          (aggressor flow signal)
        //   invDecay = −γ × ratio × vol × mid     (AS reservation price; ratio already
        //                                           includes funding target shift above)
        // Note: funding bias is expressed via fundingTargetInv (ratio shift), NOT as
        // a separate fairPrice adjustment. This gives a bounded, holistic bias across
        // size, skew AND price — much stronger than a pure price-shift at low rates.
        const flowAdj = this._flowKappa * this._flowEMA * mid;
        // v5: Adaptive γ — inventory decay steepens as position grows.
        // γ_eff = γ_base × (1 + |ratio|): doubles at full skew, natural at zero.
        const adaptiveGamma = this._decayGamma > 0
            ? this._decayGamma * (1 + Math.abs(ratio))
            : 0;
        const invDecay = adaptiveGamma > 0 ? -adaptiveGamma * ratio * vol * mid : 0;
        // v5: Regime-based fair price gating.
        //   volatile   → flow signal noisy, use only inventory correction
        //   trending   → amplify momentum (1.5× flow)
        //   ranging    → dampen flow to avoid whipsaws (0.5× flow)
        let fairPrice;
        if (regime === 'volatile') {
            fairPrice = microprice + invDecay;                      // kill flow in chaos
        } else if (regime === 'trending_up' || regime === 'trending_down') {
            fairPrice = microprice + 1.5 * flowAdj + invDecay;     // ride momentum
        } else {
            fairPrice = microprice + 0.5 * flowAdj + invDecay;     // ranging: half-weight
        }

        // ── v5: Smart kill-switch ─────────────────────────────────────────────────
        // Condition 1: vol spike + spread can't keep up → no edge, high adverse risk.
        // Condition 2: fill rate collapse after warmup → market moved away from quotes.
        if (this._smartKillEnabled) {
            if (vol > this._smartKillVolThreshold && effectiveSpread < vol * 1.5) {
                await this._shutdown('vol_spike_no_edge', vol);
                return;
            }
            if (this.metrics.quotesPlaced >= this._smartKillMinQuotes &&
                this.metrics.getFillRate() < this._smartKillFillRateMin) {
                await this._shutdown('fill_rate_collapse', this.metrics.getFillRate());
                return;
            }
        }

        // ── Latency arbitrage guard (pre-placement) ───────────────────────────────
        // If fairPrice drifted > cancelThreshold vs last quoted mid, cancel immediately.
        // Bypasses the requote cooldown — this is safety-critical, not a routine cancel.
        // After cancelling, falls through to place fresh quotes in the same tick.
        if (this._openOrders.length > 0 && this._quotedMid && this._latency?.enabled) {
            const fairDrift = Math.abs(fairPrice - this._quotedMid) / this._quotedMid;
            if (fairDrift > (this._latency.cancelThreshold ?? 0.002)) {
                logger.warn('Latency arbitrage guard – cancelling stale quotes', {
                    fairPrice: fairPrice.toFixed(2),
                    quotedMid: this._quotedMid.toFixed(2),
                    drift: (fairDrift * 100).toFixed(3) + '%',
                });
                await this._cancelOpenOrders(true);
                // Continue: place fresh quotes immediately (no return)
            }
        }

        // ── Build multi-level quotes ─────────────────────────────────────────────────
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

            // Force requote when inventory crosses zero.
            // In hedge mode  : existing orders have stale positionSide (SHORT vs LONG).
            // In oneway mode : inventory skew direction reverses → quotes need repricing.
            const currInvSign = Math.sign(this.inventory.getInventory());
            const invSignChanged = this._lastQuotedInvSign !== undefined &&
                this._lastQuotedInvSign !== 0 &&
                currInvSign !== this._lastQuotedInvSign;

            // v5: Queue position awareness — force requote if best resting order slipped
            // back > QUEUE_BPS from the current best bid/ask (lost queue priority).
            const QUEUE_BPS = this._requoteQueueDepthBps;
            let isDeepInQueue = false;
            if (QUEUE_BPS > 0) {
                const myBestBid = this._openOrders
                    .filter(o => o.side === 'buy')
                    .reduce((mx, o) => Math.max(mx, o.price || 0), 0);
                const myBestAsk = this._openOrders
                    .filter(o => o.side === 'sell')
                    .reduce((mn, o) => Math.min(mn, o.price || Infinity), Infinity);
                const bidGap = myBestBid > 0 ? (bid - myBestBid) / bid : 0;
                const askGap = myBestAsk < Infinity ? (myBestAsk - ask) / ask : 0;
                isDeepInQueue = bidGap > QUEUE_BPS || askGap > QUEUE_BPS;
            }

            // 1. Skip if price + spread haven't moved enough AND orders aren't stale
            if (!invSignChanged && !isDeepInQueue &&
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

        // Place new quotes BEFORE cancelling old ones (always-quoted).
        // If placement fails, old orders stay active — no gap exposure.
        const placed = await this._placeQuotes(quotes);
        if (placed.length === 0) {
            logger.error('All quote placements failed');
            return;
        }
        // New quotes are live; now cancel the previous cycle's orders.
        await this._cancelOpenOrders(false);

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
            fundingTargetInv: this._fundingBiasEnabled ? fundingTargetInv.toFixed(6) : undefined,
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
        // In hedge mode, closing a LONG position requires positionSide=LONG on sell (and vice versa).
        // In oneway mode, positionSide=BOTH is correct (default in adapter).
        const hedgeParams = this._positionMode === 'hedge'
            ? { positionSide: side === 'sell' ? 'LONG' : 'SHORT' }
            : { positionSide: 'BOTH' };

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
                    this.symbol, side, limitPrice, size, hedgeParams
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
            const hedgeOrder = await this.exchange.placeMarketOrder(this.symbol, side, size, hedgeParams);
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
        // ── positionSide per BingX position mode ──────────────────────────────────
        //
        // ONE-WAY mode (POSITION_MODE=oneway, BingX default):
        //   All orders use positionSide=BOTH. Position can go positive (long)
        //   or negative (short) naturally as fills happen. This is correct
        //   for symmetric MM that quotes both sides. Works without any special
        //   account setting.
        //
        // HEDGE mode (POSITION_MODE=hedge, requires Hedge Mode enabled in BingX):
        //   Separate LONG and SHORT position buckets:
        //     inv >= 0 → buy: open/add LONG   | sell: reduce/close LONG
        //     inv <  0 → buy: reduce SHORT     | sell: open/add SHORT
        //
        const inv = this.inventory.getInventory();
        const results = await Promise.allSettled(
            quotes.map(q => {
                let orderParams;
                if (this._positionMode === 'hedge') {
                    const positionSide = q.side === 'buy'
                        ? (inv < 0 ? 'SHORT' : 'LONG')   // close short OR open long
                        : (inv > 0 ? 'LONG' : 'SHORT');  // close long  OR open short
                    orderParams = { positionSide };
                } else {
                    // oneway: positionSide=BOTH, inventory flows naturally + and -
                    orderParams = { positionSide: 'BOTH' };
                }
                // Clamp amount to exchange minimum and round UP to step size.
                // BingX rejects if amount < minimum OR has floating-point under-precision.
                // Using Math.ceil ensures we never send a value that rounds down below the floor.
                const AMOUNT_STEP = 0.0001; // BTC step size on BingX
                const rawAmt = Math.max(q.amount, this._minOrderSize);
                const amount = Math.ceil(rawAmt / AMOUNT_STEP) * AMOUNT_STEP;
                return this.exchange.placeLimitOrder(
                    this.symbol, q.side, q.price, amount, orderParams
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
                // BingX error code 109400 covers TWO different issues — handle separately:
                if (msg.includes('109400')) {
                    // Case A: PositionSide conflict — account is in Hedge Mode but bot
                    // is sending positionSide=BOTH (oneway config). This will NEVER resolve
                    // on its own; a 15-min pause would just loop forever.
                    // Fix: set POSITION_MODE=hedge in .env to match your BingX account setting.
                    if (msg.includes('PositionSide') || msg.includes('Hedge mode') || msg.includes('positionSide')) {
                        logger.error(
                            'BingX 109400 – PositionSide config mismatch. ' +
                            'Your BingX account is in Hedge Mode but POSITION_MODE=oneway. ' +
                            'Add POSITION_MODE=hedge to your .env and restart.',
                            { error: msg }
                        );
                        await this._telegram.maybeSendAlert(
                            '🚨 BingX config error: account is Hedge Mode but bot uses oneway. ' +
                            'Set POSITION_MODE=hedge in .env and restart.'
                        );
                        await this._shutdown('positionMode_config_error', 109400);
                        return [];
                    }
                    // Case B: Cancel-rate ban (>99% cancel rate in rolling 10-min window).
                    // Pause for 15 min (window + 5 min buffer) then resume quoting.
                    const pauseMs = 15 * 60 * 1000;
                    this._pauseUntil = Date.now() + pauseMs;
                    logger.warn('BingX cancel-rate ban (109400) – pausing quoting for 15 minutes', {
                        resumeAt: new Date(this._pauseUntil).toISOString(),
                    });
                    await this._telegram.maybeSendAlert(
                        '⚠️ BingX cancel-rate ban (code 109400). Pausing 15 min. Existing positions are safe.'
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
            this._applyOrderUpdate(q, updated, midAtPlacement, 'poll');
            if (!['closed', 'canceled', 'expired'].includes(updated.status)) stillOpen.push(q);
        }

        this._openOrders = stillOpen;
    }

    // ─── Shared fill logic (used by both REST poll and WebSocket callback) ────

    /**
     * Process a fill event from either REST polling or WebSocket notification.
     * Guards against double-counting via q._processedQty.
     *
     * @param {object} q          – open order entry from this._openOrders
     * @param {object} updated    – latest order state { filled, average, price, status }
     * @param {number} midRef     – reference mid at order placement (for adverse detection)
     * @param {string} source     – 'poll' | 'websocket' (logged for diagnostics)
     */
    _applyOrderUpdate(q, updated, midRef, source = 'poll') {
        const filled = updated.filled || 0;
        const prev = q._processedQty || 0;
        const newFill = filled - prev;

        if (newFill <= 0) return; // already processed (WS beat the poll, or no new fill)

        const fillPrice = updated.average || updated.price || q.price;
        const fee = this.config.spread.fee;
        const prevInv = this.inventory.getInventory();
        const avgCost = this.inventory.getAvgCost();

        // ── True realized P&L using cost-basis ─────────────────────────────────
        // Opening a position: debit the maker fee (real cost).
        // Closing a position: (exit - entry) × qty − fee on both legs.
        //
        // This matches what BingX shows as "Lãi Lỗ đã thực hiện".
        let profit;
        const closingLong = q.side === 'sell' && prevInv > 0;
        const closingShort = q.side === 'buy' && prevInv < 0;

        if (closingLong) {
            const closeQty = Math.min(newFill, prevInv);
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
        const ref = this._lastMid || midRef;
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
            qty: newFill,
            fillPrice,
        });

        logger.info('Fill processed', {
            source,
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

    // ─── WebSocket fill handler ───────────────────────────────────────────────

    /**
     * Called by the BingX WebSocket stream whenever an order update arrives.
     * Matches the event to this._openOrders by order id, applies the fill,
     * and removes the entry if the order reached a terminal state.
     *
     * Double-processing is prevented by _applyOrderUpdate's _processedQty guard:
     * if REST poll fires after WS has already recorded the fill, newFill = 0 → no-op.
     *
     * @param {object} wsOrder  – order event from ccxt.pro watchOrders()
     */
    _handleWsOrderUpdate(wsOrder) {
        const q = this._openOrders.find(o => o.order && o.order.id === wsOrder.id);
        if (!q) return; // not one of our active quotes (already removed or hedge order)

        this._applyOrderUpdate(q, wsOrder, this._quotedMid, 'websocket');

        if (['closed', 'canceled', 'expired'].includes(wsOrder.status)) {
            this._openOrders = this._openOrders.filter(
                o => !(o.order && o.order.id === wsOrder.id)
            );
        }
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
        let buyVol = 0, sellVol = 0;  // v5: volume-weighted signed flow (VPIN)

        for (const t of trades) {
            if (t.side === 'buy') { buyCount++; buyVol += t.amount || 0; }
            else if (t.side === 'sell') { sellCount++; sellVol += t.amount || 0; }
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

        // v5: Volume-based VPIN — large directional volume imbalance confirms toxic flow.
        // Either count-based OR volume-based trigger (both require VWAP confirmation).
        const totalVol = buyVol + sellVol;
        const volumeToxicity = totalVol > 0
            ? Math.abs(buyVol - sellVol) / totalVol >= 0.70
            : false;

        const detected = (dominantFrac >= this._toxicSideRatio && vwapDev >= this._toxicVwapThreshold)
            || (volumeToxicity && vwapDev >= this._toxicVwapThreshold);
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
        if (!this.running) return; // already shutting down (prevent double-call)
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

        // Exit the process so process managers (PM2, Docker restart policies, etc.)
        // don't immediately restart a bot that deliberately hit its risk limits.
        // To allow auto-restart, remove this line or configure your process manager's
        // stop_exit_codes to exclude exit code 0.
        setTimeout(() => process.exit(0), 500);
    }

    _sleep(ms) {
        return new Promise((res) => setTimeout(res, ms));
    }
}

module.exports = MarketMaker;
