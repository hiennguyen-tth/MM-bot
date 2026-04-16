'use strict';

const Redis = require('ioredis');

let _client = null;
let _subscriber = null;

function _make(lazyConnect = false) {
    return new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null, // required by BullMQ
        enableReadyCheck: false,
        lazyConnect,
    });
}

/** Shared connection (BullMQ + publish). */
function getRedis() {
    if (!_client) _client = _make();
    return _client;
}

/** Dedicated subscriber connection (cannot publish on same conn). */
function getSubscriber() {
    if (!_subscriber) _subscriber = _make();
    return _subscriber;
}

async function closeAll() {
    if (_client) { await _client.quit(); _client = null; }
    if (_subscriber) { await _subscriber.quit(); _subscriber = null; }
}

module.exports = { getRedis, getSubscriber, closeAll };
