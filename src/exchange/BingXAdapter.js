'use strict';

const ccxt = require('ccxt');
const ExchangeBase = require('./ExchangeBase');
const logger = require('../metrics/Logger');

/**
 * BingX adapter (Spot + Perpetual Futures).
 *
 * ─── SETUP GUIDE ───────────────────────────────────────────────────────────
 *
 * 1. Tạo API key tại: https://bingx.com/account/api (Mainnet)
 *    Testnet perpetuals: https://testnet.bingxfutures.com  (chỉ có swap)
 *
 * 2. Quyền cần thiết (thêm IP whitelist nếu chạy VPS):
 *    - Spot   : "Trade" → Spot Trading
 *    - Futures: "Trade" → Perpetual Futures
 *    KHÔNG cần "Withdrawal" – không bao giờ bật cho bot.
 *
 * 3. .env:
 *    EXCHANGE=bingx
 *    API_KEY=<BingX API Key>
 *    API_SECRET=<BingX API Secret>
 *    MARKET_TYPE=spot          # hoặc 'swap' cho perpetual futures
 *    TESTNET=true              # chỉ hoạt động với MARKET_TYPE=swap
 *    SYMBOL=BTC/USDT           # spot
 *    SYMBOL=BTC/USDT:USDT      # perpetual futures (ccxt unified format)
 *
 * 4. Symbol format:
 *    │  Market type  │  SYMBOL env      │  Ví dụ lệnh BingX API │
 *    │─────────────────────────────────────────────────────────│
 *    │  spot         │  BTC/USDT        │  BTC-USDT             │
 *    │  swap (perp)  │  BTC/USDT:USDT   │  BTC-USDT             │
 *    ccxt tự chuyển định dạng – giữ nguyên format ccxt trong .env.
 *
 * 5. Rate limits (BingX Spot):
 *    - Public endpoints: 100 req/10s
 *    - Private endpoints: 1000 req/1 min
 *    Bot dùng khoảng 4-8 req/cycle → an toàn với LOOP_INTERVAL_MS ≥ 1000.
 * ───────────────────────────────────────────────────────────────────────────
 */
class BingXAdapter extends ExchangeBase {
    /**
     * @param {object} config
     * @param {string} config.apiKey
     * @param {string} config.secret
     * @param {boolean} config.testnet    – chỉ hoạt động với marketType='swap'
     * @param {'spot'|'swap'} config.marketType
     */
    constructor(config) {
        super();

        const marketType = config.marketType || 'spot';

        const opts = {
            apiKey: config.apiKey,
            secret: config.secret,
            options: { defaultType: marketType },
            verbose: false,
        };

        if (config.testnet) {
            if (marketType === 'swap') {
                // BingX perpetuals testnet
                opts.urls = {
                    api: {
                        public: 'https://open-api-vst.bingx.com',
                        private: 'https://open-api-vst.bingx.com',
                    },
                };
                logger.info('BingX adapter: TESTNET (swap) mode active');
            } else {
                // BingX spot không có testnet công khai
                logger.warn(
                    'BingX adapter: TESTNET=true chỉ hoạt động với MARKET_TYPE=swap. ' +
                    'Spot sẽ dùng mainnet – hãy dùng lệnh nhỏ để test.'
                );
            }
        }

        this._ex = new ccxt.bingx(opts);
        this._marketType = marketType;
    }

    async getOrderBook(symbol) {
        const ob = await this._ex.fetchOrderBook(symbol, 5);
        const bid = ob.bids[0][0];
        const ask = ob.asks[0][0];
        const bidVolume = ob.bids.reduce((s, [, v]) => s + v, 0);
        const askVolume = ob.asks.reduce((s, [, v]) => s + v, 0);
        return { bid, ask, mid: (bid + ask) / 2, bidVolume, askVolume };
    }

    async getRecentTrades(symbol, limit = 20) {
        const trades = await this._ex.fetchTrades(symbol, undefined, limit);
        return trades.map((t) => t.price);
    }

    /**
     * Fetch recent trades with side info (for toxic flow detection).
     * Only available for swap markets on BingX.
     */
    async getTrades(symbol, limit = 20) {
        if (this._marketType !== 'swap') return [];
        try {
            const trades = await this._ex.fetchTrades(symbol, undefined, limit);
            return trades.map(t => ({
                price: t.price,
                side: t.side,    // 'buy' or 'sell'
                amount: t.amount,
            }));
        } catch (err) {
            logger.warn('getTrades failed', { error: err.message });
            return [];
        }
    }

    /**
     * Fetch current perpetual funding rate.
     * Returns 0 for spot or on failure.
     */
    async getFundingRate(symbol) {
        if (this._marketType !== 'swap') return 0;
        try {
            const fr = await this._ex.fetchFundingRate(symbol);
            return typeof fr.fundingRate === 'number' ? fr.fundingRate : 0;
        } catch (err) {
            logger.warn('getFundingRate failed', { error: err.message });
            return 0;
        }
    }

    async placeLimitOrder(symbol, side, price, amount, params = {}) {
        // BingX Hedge Mode: MM bot always quotes against the LONG position.
        //   buy  + positionSide=LONG → open / add to LONG  ✓
        //   sell + positionSide=LONG → close / reduce LONG ✓
        // Using SHORT here would try to open an independent SHORT position,
        // which requires separate margin and is NOT what an MM bot needs.
        const swapParams = this._marketType === 'swap'
            ? { positionSide: 'LONG', ...params }
            : params;
        const order = await this._ex.createLimitOrder(symbol, side, amount, price, swapParams);
        logger.debug('BingX limit order placed', {
            side,
            price,
            amount,
            id: order.id,
            marketType: this._marketType,
            positionSide: swapParams.positionSide ?? 'n/a',
        });
        return order;
    }

    async placeMarketOrder(symbol, side, amount, params = {}) {
        const swapParams = this._marketType === 'swap'
            ? { positionSide: 'LONG', ...params }
            : params;
        const order = await this._ex.createMarketOrder(symbol, side, amount, swapParams);
        logger.debug('BingX market order placed', {
            side,
            amount,
            id: order.id,
            marketType: this._marketType,
            positionSide: swapParams.positionSide ?? 'n/a',
        });
        return order;
    }

    async cancelOrder(id, symbol) {
        return this._ex.cancelOrder(id, symbol);
    }

    async getOrder(id, symbol) {
        return this._ex.fetchOrder(id, symbol);
    }

    async cancelAllOrders(symbol) {
        return this._ex.cancelAllOrders(symbol);
    }

    /**
     * Fetch current net position size + avg entry price.
     * Returns { size: number (+ long / - short), avgCost: number }
     */
    async getPosition(symbol) {
        if (this._marketType !== 'swap') return { size: 0, avgCost: 0 };
        try {
            const positions = await this._ex.fetchPositions([symbol]);
            let net = 0, avgCost = 0;
            for (const p of positions) {
                if (p.symbol !== symbol && p.info?.symbol !== symbol) continue;
                const size = (p.contracts || 0) * (p.contractSize || 1);
                if (p.side === 'long') { net += size; avgCost = p.entryPrice || 0; }
                if (p.side === 'short') { net -= size; avgCost = p.entryPrice || 0; }
            }
            return { size: net, avgCost };
        } catch (err) {
            logger.warn('getPosition failed, assuming flat', { error: err.message });
            return { size: 0, avgCost: 0 };
        }
    }
}

module.exports = BingXAdapter;
