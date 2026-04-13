'use strict';

const BinanceAdapter = require('./BinanceAdapter');
const BingXAdapter = require('./BingXAdapter');

/**
 * Factory: trả về exchange adapter đúng dựa trên config.exchange.name.
 *
 * Thêm exchange mới:
 *   1. Tạo MyExchange extends ExchangeBase
 *   2. Thêm case 'myexchange' bên dưới
 *
 * @param {object} exchangeConfig – config.exchange
 * @returns {import('./ExchangeBase')}
 */
function createExchange(exchangeConfig) {
    switch (exchangeConfig.name.toLowerCase()) {
        case 'binance':
            return new BinanceAdapter(exchangeConfig);
        case 'bingx':
            return new BingXAdapter(exchangeConfig);
        default:
            throw new Error(
                `Exchange '${exchangeConfig.name}' không được hỗ trợ. ` +
                `Các exchange hỗ trợ: binance, bingx`
            );
    }
}

module.exports = { createExchange };
