'use strict';

/**
 * Live BingX price test – calls real BingX API (no auth needed for public data).
 *
 * Usage:
 *   npm run test:live             → dùng EXCHANGE/SYMBOL từ .env
 *   SYMBOL=ETH/USDT npm run test:live
 *   MARKET_TYPE=swap SYMBOL=BTC/USDT:USDT npm run test:live
 *
 * Không đặt lệnh, không cần API key khi chỉ fetch orderbook/trades.
 * Nếu TESTNET=true + MARKET_TYPE=swap → dùng BingX swap testnet.
 */

require('dotenv').config();
const BingXAdapter = require('../src/exchange/BingXAdapter');

async function main() {
    const symbol     = process.env.SYMBOL      || 'BTC/USDT';
    const marketType = process.env.MARKET_TYPE || 'spot';
    const testnet    = process.env.TESTNET !== 'false';

    // Public endpoints don't need auth, but adapter still expects keys
    const adapter = new BingXAdapter({
        apiKey:     process.env.API_KEY     || '',
        secret:     process.env.API_SECRET  || '',
        testnet,
        marketType,
    });

    console.log(`\n─── BingX Live Price Check ─────────────────────────────`);
    console.log(`  Symbol:      ${symbol}`);
    console.log(`  Market type: ${marketType}`);
    console.log(`  Testnet:     ${testnet && marketType === 'swap' ? 'ON (swap)' : marketType === 'swap' ? 'OFF' : 'N/A (spot uses mainnet)'}`);
    console.log(`────────────────────────────────────────────────────────\n`);

    const [book, trades] = await Promise.all([
        adapter.getOrderBook(symbol),
        adapter.getRecentTrades(symbol, 10),
    ]);

    const spread     = book.ask - book.bid;
    const spreadPct  = (spread / book.mid * 100).toFixed(4);
    const imbalance  = (book.bidVolume + book.askVolume) > 0
        ? ((book.bidVolume - book.askVolume) / (book.bidVolume + book.askVolume)).toFixed(4)
        : '0.0000';

    console.log(`Order Book (top 5 levels):`);
    console.log(`  Bid:        $${book.bid.toFixed(2)}`);
    console.log(`  Ask:        $${book.ask.toFixed(2)}`);
    console.log(`  Mid:        $${book.mid.toFixed(2)}`);
    console.log(`  Spread:     $${spread.toFixed(2)}  (${spreadPct}%)`);
    console.log(`  Bid Vol:    ${book.bidVolume.toFixed(4)}`);
    console.log(`  Ask Vol:    ${book.askVolume.toFixed(4)}`);
    console.log(`  Imbalance:  ${imbalance}  (>0 = more bids, <0 = more asks)`);
    console.log(``);
    console.log(`Recent Trades (last 10 prices):`);
    console.log(`  ${trades.map((p) => '$' + p.toFixed(2)).join('  ')}`);

    const min = Math.min(...trades);
    const max = Math.max(...trades);
    const range = (((max - min) / book.mid) * 100).toFixed(4);
    console.log(`  Range:  $${min.toFixed(2)} – $${max.toFixed(2)}  (${range}% of mid)\n`);
}

main().catch((err) => {
    console.error('\nError:', err.message);
    if (err.message.includes('symbol')) {
        console.error('Hint: Spot symbol format = BTC/USDT  |  Swap format = BTC/USDT:USDT');
    }
    process.exit(1);
});
