'use strict';

// Approximate BTC price for USDT→BTC conversion.
// Update BTC_PRICE_USDT env var periodically; ±15% error is fine for sizing.
const BTC_PRICE = () => parseFloat(process.env.BTC_PRICE_USDT) || 75_000;
const MIN_ORDER_BTC = 0.001; // BingX swap hard minimum

const RISK_PROFILES = {
    low: {
        baseSizePct: 0.0001,  // % of capital in BTC terms
        softMaxPct: 0.001,
        hardMaxPct: 0.002,
        baseSpread: 0.0022,
        dailyLossPct: 0.01,    // 1% of capital
        description: 'Conservative — 1% daily loss limit, wide spreads',
    },
    medium: {
        baseSizePct: 0.0003,
        softMaxPct: 0.003,
        hardMaxPct: 0.006,
        baseSpread: 0.0018,
        dailyLossPct: 0.02,
        description: 'Balanced — 2% daily loss limit, standard spreads',
    },
    high: {
        baseSizePct: 0.0007,
        softMaxPct: 0.007,
        hardMaxPct: 0.014,
        baseSpread: 0.0012,
        dailyLossPct: 0.05,
        description: 'Aggressive — 5% daily loss limit, tight spreads',
    },
};

/**
 * Convert user-friendly inputs into bot env-var config.
 *
 * @param {object} input
 * @param {number} input.capital        – USDT allocated
 * @param {'low'|'medium'|'high'|'custom'} input.risk
 * @param {string} [input.symbol]       – default BTC/USDT:USDT
 * @param {string} [input.exchange]     – binance | bingx
 * @param {object} [input.custom]       – overrides when risk='custom'
 * @returns {{ config: object, warnings: string[] }}
 */
function generateConfig({ capital, risk, symbol = 'BTC/USDT:USDT', exchange = 'bingx', custom = {} }) {
    const warnings = [];

    if (capital < 200) {
        warnings.push(`Capital $${capital} is very small. Minimum recommended: $500.`);
    }

    let profile;
    if (risk === 'custom') {
        profile = {
            baseSizePct: custom.baseSizePct || 0.0003,
            softMaxPct: custom.softMaxPct || 0.003,
            hardMaxPct: custom.hardMaxPct || 0.006,
            baseSpread: custom.baseSpread || 0.0018,
            dailyLossPct: custom.dailyLossPct || 0.02,
        };
    } else {
        profile = RISK_PROFILES[risk];
        if (!profile) throw new Error(`Unknown risk level: ${risk}`);
    }

    const btcPrice = BTC_PRICE();
    const capitalBtc = capital / btcPrice;
    const r = (n, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

    let baseSize = capitalBtc * profile.baseSizePct;
    let softMax = capitalBtc * profile.softMaxPct;
    let hardMax = capitalBtc * profile.hardMaxPct;

    if (baseSize < MIN_ORDER_BTC) {
        baseSize = MIN_ORDER_BTC;
        warnings.push(`BASE_SIZE clamped to minimum ${MIN_ORDER_BTC} BTC. Increase capital for risk-proportional sizing.`);
    }
    softMax = Math.max(softMax, MIN_ORDER_BTC * 3);
    hardMax = Math.max(hardMax, MIN_ORDER_BTC * 6);

    const isSwap = symbol.includes(':');

    const config = {
        EXCHANGE: exchange,
        SYMBOL: symbol,
        MARKET_TYPE: isSwap ? 'swap' : 'spot',
        POSITION_MODE: 'oneway',
        TESTNET: 'false',

        BASE_SPREAD: profile.baseSpread,
        FEE: 0.001,
        VOL_LOOKBACK: 20,
        VOL_MULTIPLIER: 3,

        BASE_SIZE: r(baseSize),
        SOFT_MAX: r(softMax),
        HARD_MAX: r(hardMax),
        MIN_ORDER_SIZE: MIN_ORDER_BTC,

        DAILY_LOSS_LIMIT: r(capital * profile.dailyLossPct, 2),
        CONSECUTIVE_LOSS_LIMIT: 8,

        LOOP_INTERVAL_MS: 5000,
        FILL_POLL_MS: 1000,

        DYNAMIC_SPREAD_ENABLED: 'true',
        IMBALANCE_ENABLED: 'true',
        ADAPTIVE_TIMING_ENABLED: 'true',
        REGIME_ENABLED: 'true',
        REGIME_FILTER_ENABLED: 'true',
        FLOW_ENABLED: 'true',
        LATENCY_PROTECTION_ENABLED: 'true',
        FUNDING_BIAS_ENABLED: isSwap ? 'true' : 'false',

        QUOTE_LEVELS: risk === 'low' ? 2 : 3,
        SKEW_FACTOR: 0.3,
        SIZE_FACTOR: 0.8,

        // Metadata (used by SaaS layer, not the bot itself)
        _capital: capital,
        _risk: risk,
        _btcPriceAtGenerate: btcPrice,
    };

    return { config, warnings };
}

module.exports = { generateConfig, RISK_PROFILES };
