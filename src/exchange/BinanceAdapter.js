'use strict';

const ccxt = require('ccxt');
const ExchangeBase = require('./ExchangeBase');
const logger = require('../metrics/Logger');

/**
 * Binance adapter (Spot).
 * Set TESTNET=true in .env to use Binance Spot testnet:
 *   https://testnet.binance.vision
 *
 * API keys for testnet: https://testnet.binance.vision/key/generate
 */
class BinanceAdapter extends ExchangeBase {
    /**
     * @param {object} config
     * @param {string} config.apiKey
     * @param {string} config.secret
     * @param {boolean} config.testnet
     */
    constructor(config) {
        super();

        const opts = {
            apiKey: config.apiKey,
            secret: config.secret,
            options: { defaultType: 'spot' },
            // Disable excessive network tracing in prod
            verbose: false,
        };

        if (config.testnet) {
            opts.urls = {
                api: {
                    public: 'https://testnet.binance.vision/api',
                    private: 'https://testnet.binance.vision/api',
                },
                fapiPublic: 'https://testnet.binancefuture.com/fapi',
                fapiPrivate: 'https://testnet.binancefuture.com/fapi',
            };
            logger.info('Binance adapter: TESTNET mode active');
        }

        this._ex = new ccxt.binance(opts);
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

    async placeLimitOrder(symbol, side, price, amount) {
        const order = await this._ex.createLimitOrder(symbol, side, amount, price);
        logger.debug('Limit order placed', {
            side,
            price,
            amount,
            id: order.id,
        });
        return order;
    }

    async placeMarketOrder(symbol, side, amount) {
        const order = await this._ex.createMarketOrder(symbol, side, amount);
        logger.debug('Market order placed', { side, amount, id: order.id });
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

    /** Binance spot has no futures position. */
    async getPosition() {
        return { size: 0, avgCost: 0 };
    }
}

module.exports = BinanceAdapter;
