'use strict';

require('dotenv').config();

const config = require('./config/config');
const { createExchange } = require('./exchange/ExchangeFactory');
const MarketMaker = require('./core/MarketMaker');
const logger = require('./metrics/Logger');

async function main() {
  logger.info('Starting MM Bot', {
    exchange: config.exchange.name,
    symbol: config.symbol,
    testnet: config.exchange.testnet,
    marketType: config.exchange.marketType,
    softMax: config.inventory.softMax,
    hardMax: config.inventory.hardMax,
    baseSpread: config.spread.baseFraction,
    fee: config.spread.fee,
    dailyLossLimit: config.risk.dailyLossLimit,
    dynamicSpread: config.dynamicSpread.enabled,
    adaptiveTiming: config.adaptiveTiming.enabled,
    regimeDetection: config.regime.enabled,
  });

  const exchange = createExchange(config.exchange);
  const bot = new MarketMaker(exchange, config);

  // ── Graceful shutdown on OS signals ────────────────────────────────────────
  const graceful = (signal) => async () => {
    logger.info(`${signal} received – shutting down gracefully`);
    bot.stop();
    // Give the current tick a moment to exit cleanly
    setTimeout(() => process.exit(0), 1500);
  };

  process.on('SIGINT', graceful('SIGINT'));
  process.on('SIGTERM', graceful('SIGTERM'));

  // ── Unhandled rejection safety net ─────────────────────────────────────────
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  await bot.start();
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
