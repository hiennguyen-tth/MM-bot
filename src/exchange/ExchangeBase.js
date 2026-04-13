'use strict';

/**
 * Abstract base class for exchange adapters.
 * Implement this interface to add support for new exchanges.
 */
class ExchangeBase {
    /**
     * Fetch best bid/ask, compute mid, and sum top-of-book volumes.
     * @param {string} symbol
     * @returns {Promise<{ bid: number, ask: number, mid: number, bidVolume: number, askVolume: number }>}
     *   bidVolume / askVolume – summed quantity of top-N levels (for imbalance calc)
     */
    // eslint-disable-next-line no-unused-vars
    async getOrderBook(symbol) {
        throw new Error('ExchangeBase.getOrderBook() not implemented');
    }

    /**
     * Fetch the N most recent trade prices.
     * @param {string} symbol
     * @param {number} limit
     * @returns {Promise<number[]>} – array of trade prices, newest last
     */
    // eslint-disable-next-line no-unused-vars
    async getRecentTrades(symbol, limit) {
        throw new Error('ExchangeBase.getRecentTrades() not implemented');
    }

    /**
     * Place a limit order.
     * @param {string} symbol
     * @param {'buy'|'sell'} side
     * @param {number} price
     * @param {number} amount
     * @returns {Promise<{ id: string, price: number, amount: number, status: string }>}
     */
    // eslint-disable-next-line no-unused-vars
    async placeLimitOrder(symbol, side, price, amount) {
        throw new Error('ExchangeBase.placeLimitOrder() not implemented');
    }

    /**
     * Place a market order (used for T3 emergency hedge).
     * @param {string} symbol
     * @param {'buy'|'sell'} side
     * @param {number} amount
     * @returns {Promise<{ id: string, filled: number, average: number }>}
     */
    // eslint-disable-next-line no-unused-vars
    async placeMarketOrder(symbol, side, amount) {
        throw new Error('ExchangeBase.placeMarketOrder() not implemented');
    }

    /**
     * Cancel a specific order.
     * @param {string} id
     * @param {string} symbol
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async cancelOrder(id, symbol) {
        throw new Error('ExchangeBase.cancelOrder() not implemented');
    }

    /**
     * Fetch the current state of an order (for fill polling).
     * @param {string} id
     * @param {string} symbol
     * @returns {Promise<{ id: string, status: string, filled: number, average: number }>}
     */
    // eslint-disable-next-line no-unused-vars
    async getOrder(id, symbol) {
        throw new Error('ExchangeBase.getOrder() not implemented');
    }

    /**
     * Cancel all open orders for a symbol (used on shutdown).
     * @param {string} symbol
     * @returns {Promise<void>}
     */
    // eslint-disable-next-line no-unused-vars
    async cancelAllOrders(symbol) {
        throw new Error('ExchangeBase.cancelAllOrders() not implemented');
    }

    /**
     * Fetch current net long position size in base currency.
     * Return 0 for spot exchanges or when flat.
     * @param {string} symbol
     * @returns {Promise<number>}
     */
    // eslint-disable-next-line no-unused-vars
    async getPosition(symbol) {
        return { size: 0, avgCost: 0 }; // default: no position (spot)
    }

    /**
     * Fetch recent trades with side information (for toxic flow detection).
     * @param {string} symbol
     * @param {number} limit
     * @returns {Promise<Array<{ price: number, side: 'buy'|'sell', amount: number }>>}
     *   Returns empty array by default (opt-in: exchanges that support it override this).
     */
    // eslint-disable-next-line no-unused-vars
    async getTrades(symbol, limit) {
        return [];
    }

    /**
     * Fetch current perpetual funding rate.
     * @param {string} symbol
     * @returns {Promise<number>}  Funding rate as fraction (e.g. 0.0001 = 0.01%/8h).
     *   Returns 0 for spot exchanges or failures.
     */
    // eslint-disable-next-line no-unused-vars
    async getFundingRate(symbol) {
        return 0;
    }
}

module.exports = ExchangeBase;
