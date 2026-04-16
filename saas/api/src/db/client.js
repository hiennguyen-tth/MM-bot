'use strict';

const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.PGHOST     || 'localhost',
    port:     parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'mmbot',
    user:     process.env.PGUSER     || 'mmbot',
    password: process.env.PGPASSWORD,
    max:      10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;
