'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const fs = require('fs');
const pool = require('./client');

async function migrate() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const client = await pool.connect();
    try {
        await client.query(sql);
        console.log('[migrate] Schema applied successfully');
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(err => { console.error('[migrate] Failed:', err.message); process.exit(1); });
