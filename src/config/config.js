'use strict';

require('dotenv').config();

/**
 * All configuration is loaded from environment variables.
 * Copy .env.example → .env and fill in your values.
 */
module.exports = {
    exchange: {
        // Supported: 'binance' | 'bingx'
        name: process.env.EXCHANGE || 'binance',
        apiKey: process.env.API_KEY || '',
        secret: process.env.API_SECRET || '',
        testnet: process.env.TESTNET !== 'false', // default: true (safe)
        // BingX only: 'spot' | 'swap' (perpetual futures)
        marketType: process.env.MARKET_TYPE || 'spot',
        // BingX swap position mode (must match account setting in BingX → Settings → Position Mode):
        //   'oneway'  – BingX default, one position per symbol, uses positionSide=BOTH
        //   'hedge'   – separate LONG/SHORT positions, requires Hedge Mode enabled in account
        // If unsure, leave 'oneway' (safe default).
        positionMode: process.env.POSITION_MODE || 'oneway',
    },

    symbol: process.env.SYMBOL || 'BTC/USDT',

    // ── Spread engine ──────────────────────────────────────────────────────────
    // Base: spread = max(2×fee, base × (1 + volMultiplier × vol))
    //       vol    = std(last_N trade prices) / mid
    spread: {
        baseFraction: parseFloat(process.env.BASE_SPREAD) || 0.002,
        fee: parseFloat(process.env.FEE) || 0.001,
        volLookback: parseInt(process.env.VOL_LOOKBACK, 10) || 20,
        volMultiplier: parseFloat(process.env.VOL_MULTIPLIER) || 3,
        // Quadratic vol boost: additive spread term ∝ vol²
        // Disabled by default (0). Theory: risk ∝ variance, so spread should too.
        // Recommend: 100–500 for BTC/USDT. At vol=0.003, boost=200 adds ~1.2 bps.
        volSqBoost: parseFloat(process.env.VOL_SQ_BOOST) || 0,
    },

    // ── Orderbook imbalance spread ─────────────────────────────────────────────
    // imbalance = (bidVol - askVol) / totalVol  ∈ [-1, +1]
    // spread    = max(base_vol_spread, imbalanceFactor × |imbalance|)
    // → Widens automatically when book is lopsided (avoids run-over risk)
    imbalance: {
        enabled: process.env.IMBALANCE_ENABLED !== 'false', // default: on
        factor: parseFloat(process.env.IMBALANCE_FACTOR) || 0.003,
    },

    // ── Dynamic spread (regime-aware) ──────────────────────────────────────────
    // Applies per-regime multipliers on top of the base+imbalance spread.
    dynamicSpread: {
        enabled: process.env.DYNAMIC_SPREAD_ENABLED !== 'false', // default: on
        minMultiplier: parseFloat(process.env.SPREAD_MIN_MULT) || 0.5,
        maxMultiplier: parseFloat(process.env.SPREAD_MAX_MULT) || 3.0,
        // Hard cap: spread fraction never exceeds this (e.g. 0.05 = 5%)
        maxSpreadFraction: parseFloat(process.env.SPREAD_MAX_FRACTION) || 0.05,
        regimeMultiplier: {
            trending_up: parseFloat(process.env.SPREAD_MULT_TREND_UP) || 1.5,
            trending_down: parseFloat(process.env.SPREAD_MULT_TREND_DOWN) || 1.5,
            ranging: parseFloat(process.env.SPREAD_MULT_RANGING) || 1.0,
            volatile: parseFloat(process.env.SPREAD_MULT_VOLATILE) || 2.0,
        },
    },

    // ── Multi-level quoting ────────────────────────────────────────────────────
    // Places N bid/ask pairs at increasing spread multiples.
    // More fills at tighter spreads + wider levels as passive insurance.
    //
    // Default (3 levels):
    //   L1: 1.0× spread, 50% size  ← tightest, highest volume
    //   L2: 1.5× spread, 30% size
    //   L3: 2.0× spread, 20% size  ← widest, captures large moves
    quoting: {
        levels: parseInt(process.env.QUOTE_LEVELS, 10) || 3,
        // Spread multiplier per level (config in code, not per-env for simplicity)
        spreadMultipliers: [1.0, 1.5, 2.0],
        // Fraction of orderSize per level (must be balanced with levels count)
        sizeFractions: [0.5, 0.3, 0.2],
        // Upgrade #4: tanh steepness for nonlinear inventory skew.
        // Higher = skew saturates faster (prevents extreme prices near hard limit).
        // At ratio=0.8, steepness=1.5: tanh(1.2)≈0.834 vs linear=0.8 (slightly more)
        // At ratio=1.0, steepness=1.5: tanh(1.5)≈0.905 vs linear=1.0 (hard cap)
        skewSteepness: parseFloat(process.env.SKEW_STEEPNESS) || 1.5,
    },

    // ── Adaptive timing ────────────────────────────────────────────────────────
    adaptiveTiming: {
        enabled: process.env.ADAPTIVE_TIMING_ENABLED !== 'false', // default: on
        minIntervalMs: parseInt(process.env.TIMING_MIN_INTERVAL_MS, 10) || 500,
        maxIntervalMs: parseInt(process.env.TIMING_MAX_INTERVAL_MS, 10) || 5000,
        fillPollMsVolatile: parseInt(process.env.TIMING_FILL_POLL_FAST_MS, 10) || 250,
        fillPollMsQuiet: parseInt(process.env.TIMING_FILL_POLL_SLOW_MS, 10) || 1000,
        volThresholdHigh: parseFloat(process.env.TIMING_VOL_HIGH) || 0.005,
        volThresholdLow: parseFloat(process.env.TIMING_VOL_LOW) || 0.001,
    },

    // ── Regime detection ───────────────────────────────────────────────────────
    regime: {
        enabled: process.env.REGIME_ENABLED !== 'false', // default: on
        momentumWindow: parseInt(process.env.REGIME_MOMENTUM_WINDOW, 10) || 10,
        trendThreshold: parseFloat(process.env.REGIME_TREND_THRESHOLD) || 0.002,
        volatileThreshold: parseFloat(process.env.REGIME_VOLATILE_THRESHOLD) || 0.006,
    },

    // ── Regime filter (pause quoting on sudden price moves) ────────────────────
    // If price moves > maxMove1m within 1 minute, cancel all quotes and pause.
    // Protects against toxic flow / news events.
    regimeFilter: {
        enabled: process.env.REGIME_FILTER_ENABLED !== 'false', // default: on
        // Pause if mid changes more than this fraction within 1 minute
        maxMove1m: parseFloat(process.env.REGIME_FILTER_MAX_MOVE) || 0.01,
        // How long to pause quoting after trigger (ms)
        pauseMs: parseInt(process.env.REGIME_FILTER_PAUSE_MS, 10) || 45000,
        // Intra-cycle gap: cancel+pause immediately if mid moves > X% vs previous cycle
        // Catches flash crashes / liquidation cascades that the 1-min filter misses.
        // Set to 0 to disable.
        intraCycleMaxMove: parseFloat(process.env.INTRA_CYCLE_MAX_MOVE) || 0.003,
    },

    // ── Latency protection ─────────────────────────────────────────────────────
    // If mid drifts more than cancelThreshold while quotes are live,
    // cancel all orders immediately (stale quote pick-off risk).
    latency: {
        enabled: process.env.LATENCY_PROTECTION_ENABLED !== 'false', // default: on
        cancelThreshold: parseFloat(process.env.LATENCY_CANCEL_THRESHOLD) || 0.001,
    },

    // ── Inventory management ───────────────────────────────────────────────────
    inventory: {
        softMax: parseFloat(process.env.SOFT_MAX) || 0.1,
        hardMax: parseFloat(process.env.HARD_MAX) || 0.2,
        skewFactor: parseFloat(process.env.SKEW_FACTOR) || 0.3,
        sizeFactor: parseFloat(process.env.SIZE_FACTOR) || 0.8,
        baseSize: parseFloat(process.env.BASE_SIZE) || 0.001,
        // BingX swap minimum contract size for BTC/USDT:USDT perpetual is 0.001 BTC.
        // When dynamic sizing or inventory-skew reduces amounts below this, we clamp up.
        // Set MIN_ORDER_SIZE in .env if your exchange has a different minimum.
        minOrderSize: parseFloat(process.env.MIN_ORDER_SIZE) || 0.001,
        // Upgrade #5: Avellaneda-Stoikov reservation price decay.
        // Shifts fairPrice by −γ × ratio × vol × mid toward inventory target (0).
        //   long position → fairPrice pulled down → ask more competitive, bid less
        //   short position → fairPrice pulled up → bid more competitive, ask less
        // Set to 0 to disable (default: off to avoid duplicate skew with skewFactor).
        decayGamma: parseFloat(process.env.INVENTORY_DECAY_GAMMA) || 0,
    },

    // ── Inventory VaR (scale hardMax by volatility) ────────────────────────────
    // When enabled: effectiveHardMax = min(hardMax, capital / (vol × varMultiplier))
    // High vol → smaller allowed position → auto risk reduction.
    inventoryVaR: {
        enabled: process.env.INV_VAR_ENABLED === 'true', // off by default
        capital: parseFloat(process.env.CAPITAL_USDT) || 1000,
        varMultiplier: parseFloat(process.env.VAR_MULTIPLIER) || 100,
    },

    // ── Hedging (T3 emergency position reduction) ──────────────────────────────
    // Prefer a passive limit order before falling back to market order.
    // Avoids market-impact and fee on urgent hedge fills.
    hedging: {
        preferLimit: process.env.HEDGE_PREFER_LIMIT !== 'false', // default: on
        limitTimeoutMs: parseInt(process.env.HEDGE_LIMIT_TIMEOUT_MS, 10) || 2000,
    },

    // ── Order flow signal ─────────────────────────────────────────────────────
    // Upgrade #2: EMA of orderbook imbalance as proxy for aggressor flow.
    // Shifts fairPrice: persistent buy pressure → fairPrice up (we quote higher).
    //   fairPrice += φ × flowEMA × mid
    // κ (kappa) is small (0.0002 = 0.02% max shift at full imbalance).
    flow: {
        enabled: process.env.FLOW_ENABLED !== 'false',  // default: on
        emaAlpha: parseFloat(process.env.FLOW_EMA_ALPHA) || 0.2,    // EMA smoothing
        kappa: parseFloat(process.env.FLOW_KAPPA) || 0.0002,        // signal weight
    },

    // ── Inventory-based spread widening (v4) ──────────────────────────────────
    // Layer 6: spread += invSpreadK × |invRatio|
    // Wider spread when inventory is skewed → reduces adverse selection.
    // At invRatio=1.0, extra spread = INV_SPREAD_K (e.g. 0.0006 = 6 bps).
    invSpread: {
        k: parseFloat(process.env.INV_SPREAD_K) || 0,
    },

    // ── Dynamic size ∝ 1/volatility (v4) ──────────────────────────────────────
    // size_mult = clamp(targetVol / vol, minMult, maxMult)
    // Smaller position when vol is high (risk-adjusted sizing).
    // Larger position when vol is low (capture more edge in quiet markets).
    dynSize: {
        enabled: process.env.DYN_SIZE_ENABLED === 'true',
        targetVol: parseFloat(process.env.DYN_SIZE_TARGET_VOL) || 0.001,
        minMult: parseFloat(process.env.DYN_SIZE_MIN_MULT) || 0.5,
        maxMult: parseFloat(process.env.DYN_SIZE_MAX_MULT) || 2.0,
        // v5: Inventory coupling — multiply effective size by (1 − |ratio|)^α.
        // α=0 disables (default). α=1 = linear taper. α=2 = quadratic.
        invCouplingAlpha: parseFloat(process.env.DYN_SIZE_INV_COUPLING) || 0,
    },

    // ── v5: Smart kill-switch ─────────────────────────────────────────────────
    // Shuts down when volatility spikes without a corresponding edge, or when
    // fill-rate collapses (orders resting but nothing traded — market moved away).
    //   volThreshold  – σ above which the kill-switch arms (default: 0.008 = 80 bps/tick)
    //   fillRateMin   – fills/quote below this after minQuotes triggers shutdown
    //   minQuotes     – warmup period before fillRate collapse check fires
    smartKill: {
        enabled: process.env.SMART_KILL_ENABLED === 'true',
        volThreshold: parseFloat(process.env.SMART_KILL_VOL_THRESHOLD) || 0.008,
        fillRateMin: parseFloat(process.env.SMART_KILL_FILL_RATE_MIN) || 0.001,
        minQuotes: parseInt(process.env.SMART_KILL_MIN_QUOTES, 10) || 200,
    },

    // ── Funding rate bias (v4) ────────────────────────────────────────────────
    // Funding > 0 (longs pay shorts) → shift fairPrice down → short bias.
    //   fundingAdj = −fundingBiasK × fundingRate × mid
    // Fetched from exchange every fetchIntervalMs (not every tick).
    fundingBias: {
        enabled: process.env.FUNDING_BIAS_ENABLED === 'true',
        k: parseFloat(process.env.FUNDING_BIAS_K) || 0.5,
        fetchIntervalMs: parseInt(process.env.FUNDING_BIAS_FETCH_INTERVAL_MS, 10) || 60_000,
    },

    // ── Toxic flow filter (v4) ────────────────────────────────────────────────
    // Detects large directional sweeps from recent trade data and pauses briefly.
    //   sideRatio      – fraction of trades on dominant side required (e.g. 0.82)
    //   vwapThreshold  – trade VWAP must deviate > X from mid to confirm sweep
    //   pauseMs        – how long to hold (not cancel) quotes after detection
    toxicFlow: {
        enabled: process.env.TOXIC_FLOW_ENABLED === 'true',
        sideRatio: parseFloat(process.env.TOXIC_FLOW_SIDE_RATIO) || 0.82,
        vwapThreshold: parseFloat(process.env.TOXIC_FLOW_VWAP_THRESHOLD) || 0.0004,
        pauseMs: parseInt(process.env.TOXIC_FLOW_PAUSE_MS, 10) || 3_000,
    },

    // ── Fill-rate spread feedback ─────────────────────────────────────────────
    // Upgrade #3: Layer 5 in SpreadEngine. Adjusts spread based on realized fill rate.
    //   fillRate > target → widen (may be getting picked off by informed traders)
    //   fillRate < target → tighten (spread likely too wide, missing edge)
    //   adj = clamp(1 + λ × (fillRate − target), minMult, maxMult)
    // Disabled by default — enable once bot has run long enough to have stable fillRate.
    fillRateFeedback: {
        enabled: process.env.FILL_RATE_FEEDBACK_ENABLED === 'true', // opt-in
        lambda: parseFloat(process.env.FILL_RATE_LAMBDA) || 0.3,
        target: parseFloat(process.env.FILL_RATE_TARGET) || 0.3,  // 30% target fill rate
        minMult: parseFloat(process.env.FILL_RATE_MIN_MULT) || 0.7,
        maxMult: parseFloat(process.env.FILL_RATE_MAX_MULT) || 1.5,
    },

    // ── Risk / circuit breaker ─────────────────────────────────────────────────
    risk: {
        dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 50,
        consecutiveLossLimit: parseInt(process.env.CONSECUTIVE_LOSS, 10) || 5,
        adverseFillThreshold: parseFloat(process.env.ADVERSE_FILL_RATIO) || 0.6,
        adverseFillWindow: parseInt(process.env.ADVERSE_FILL_WINDOW, 10) || 20,
        // Mark-to-market loss limit on open position (USDT).\n        // When unrealizedPnL < −limit, bot shuts down immediately (bypasses close confirmation).\n        // Set to Infinity (default) to disable. Complement to consecutive-loss breaker\n        // which only counts realized closes. Recommend: 100–300 for $10k capital.\n        unrealizedLossLimit: isFinite(parseFloat(process.env.UNREALIZED_LOSS_LIMIT))\n            ? parseFloat(process.env.UNREALIZED_LOSS_LIMIT)\n            : Infinity,
    },

    // ── Time-of-day (session-based cal) ──────────────────────────────────────
    // Crypto still shows intraday patterns: US session = more volatile.
    // When US session detected: wider spread + smaller size.
    timeOfDay: {
        enabled: process.env.TIME_OF_DAY_ENABLED === 'true', // opt-in
        sessions: {
            us: {
                // US Eastern = UTC-4 (DST) / UTC-5 (winter)
                // 9am–6pm ET ≈ 13:00–22:00 UTC (conservative window)
                startHourUtc: parseInt(process.env.US_SESSION_START_UTC, 10) || 13,
                endHourUtc: parseInt(process.env.US_SESSION_END_UTC, 10) || 22,
                spreadMult: parseFloat(process.env.US_SPREAD_MULT) || 1.5,
                sizeMult: parseFloat(process.env.US_SIZE_MULT) || 0.7,
            },
        },
    },

    // ── Loop timing (static fallback when adaptiveTiming is off) ───────────────
    loop: {
        intervalMs: parseInt(process.env.LOOP_INTERVAL_MS, 10) || 2000,
        fillPollMs: parseInt(process.env.FILL_POLL_MS, 10) || 500,
        orderTtlMs: parseInt(process.env.ORDER_TTL_MS, 10) || 60_000,
    },

    // ── Requote guard (cancel-rate protection) ─────────────────────────────────
    // Bot only cancels+replaces when quotes are meaningfully stale.
    // This keeps BingX cancel rate well below the 99% ban threshold.
    //
    //   priceThreshold     – min price drift before re-quoting (2 bps = 0.0002)
    //   spreadChangeThreshold – min spread change before re-quoting
    //   minCancelIntervalMs  – cooldown between any two cancels (ms)
    //   maxCancelPerMin      – hard cap on cancels per 60-second window
    //   maxOrderAgeMs        – force re-quote after this age (ms), even if price stable
    requote: {
        priceThreshold: parseFloat(process.env.REQUOTE_PRICE_THRESHOLD) || 0.0002,
        spreadChangeThreshold: parseFloat(process.env.REQUOTE_SPREAD_THRESHOLD) || 0.0001,
        minCancelIntervalMs: parseInt(process.env.MIN_CANCEL_INTERVAL_MS, 10) || 5_000,
        maxCancelPerMin: parseInt(process.env.MAX_CANCEL_PER_MIN, 10) || 20,
        maxOrderAgeMs: parseInt(process.env.MAX_ORDER_AGE_MS, 10) || 120_000,
        // v5: queue-depth awareness — force re-quote when our best order is > N bps
        // behind the current best bid/ask (we've fallen back in the queue).
        // 0 = disabled (default).  Example: 0.0003 = 3 bps.
        queueDepthBps: parseFloat(process.env.REQUOTE_QUEUE_DEPTH_BPS) || 0,
    },

    // ── Telegram alerts ────────────────────────────────────────────────────────
    // Gets sent to your Telegram bot when the circuit breaker fires (shutdown)
    // and as periodic PnL digests (every metricsIntervalMs).
    //
    // Setup: @BotFather → create bot → get token.
    //        Send any message to the bot → GET /bot<TOKEN>/getUpdates → get chat_id.
    alert: {
        telegram: {
            botToken: process.env.TELEGRAM_BOT_TOKEN || null,
            chatId: process.env.TELEGRAM_CHAT_ID || null,
            // How often to push periodic metrics (ms). Default: 30 minutes.
            metricsIntervalMs: parseInt(process.env.TELEGRAM_METRICS_INTERVAL_MS, 10) || 1_800_000,
        },
    },
};
