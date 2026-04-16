'use strict';

require('dotenv').config();

const http       = require('http');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const jwt        = require('jsonwebtoken');
const { URL }    = require('url');

const db            = require('./db/client');
const { migrate }   = require('./db/migrate');
const { getRedis, getSubscriber, closeAll: closeRedis } = require('./services/redisClient');
const { close: closeOrchestrator } = require('./services/orchestratorService');

const authRouter        = require('./routes/auth');
const configRouter      = require('./routes/config');
const credentialsRouter = require('./routes/credentials');
const botRouter         = require('./routes/bot');

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
    origin:      process.env.CORS_ORIGIN || '*',
    credentials: true,
}));
app.use(express.json({ limit: '128kb' }));

// Rate limiting — 100 req per 15 min per IP
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});
app.use(limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',        authRouter);
app.use('/config',      configRouter);
app.use('/credentials', credentialsRouter);
app.use('/bot',         botRouter);

// Health check (unauthenticated)
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Global kill switch status (admin use — secured by env check)
app.get('/admin/kill-switch', (req, res) => {
    if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ killSwitch: process.env.GLOBAL_KILL_SWITCH === 'true' });
});

// 404 fallback
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[app] unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket Server ──────────────────────────────────────────────────────────
// Clients connect with:  ws://host/ws?token=<jwt>
// They receive realtime metrics pushed from the worker via Redis pub/sub.
//
// Message format from server:
//   { type: 'metrics', data: { ... } }
//   { type: 'status',  data: { status, instanceId } }
//   { type: 'error',   data: { message } }

const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

// Map userId → Set of live WebSocket connections
const _userSockets = new Map();

function _addSocket(userId, ws) {
    if (!_userSockets.has(userId)) _userSockets.set(userId, new Set());
    _userSockets.get(userId).add(ws);
}

function _removeSocket(userId, ws) {
    const sockets = _userSockets.get(userId);
    if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) _userSockets.delete(userId);
    }
}

function _broadcast(userId, payload) {
    const sockets = _userSockets.get(userId);
    if (!sockets) return;
    const msg = JSON.stringify(payload);
    for (const ws of sockets) {
        try {
            if (ws.readyState === ws.OPEN) ws.send(msg);
        } catch (e) {
            // ignore closed socket errors
        }
    }
}

// Authenticate WebSocket upgrade via JWT query param
server.on('upgrade', (req, socket, head) => {
    try {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const token  = urlObj.searchParams.get('token');
        if (!token) { socket.destroy(); return; }

        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req._userId = payload.sub;
    } catch {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
    });
});

wss.on('connection', (ws, req) => {
    const userId = req._userId;
    _addSocket(userId, ws);

    ws.on('close', () => _removeSocket(userId, ws));
    ws.on('error', () => _removeSocket(userId, ws));

    // Clients can send a ping to keep connection alive
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
            // ignore malformed messages
        }
    });
});

// ── Redis Subscriber — forward worker metrics to WS clients ───────────────────
async function _startMetricsSubscriber() {
    const sub = getSubscriber();

    // Subscribe to all user metrics channels: bot:metrics:{userId}
    await sub.psubscribe('bot:metrics:*');

    sub.on('pmessage', (_pattern, channel, message) => {
        // channel format: bot:metrics:{userId}
        const userId = channel.split(':')[2];
        if (!userId) return;

        try {
            const data = JSON.parse(message);
            _broadcast(userId, { type: data.type || 'metrics', data: data.data || data });
        } catch {
            // ignore parse errors
        }
    });
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
    // Run DB migrations on startup
    await migrate();

    // Verify Redis connection
    const redis = getRedis();
    await redis.ping();

    // Start Redis subscriber for metrics forwarding
    await _startMetricsSubscriber();

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`[app] API server listening on port ${PORT}`);
        console.log(`[app] WebSocket: ws://localhost:${PORT}/ws?token=<jwt>`);
    });
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
async function _shutdown(signal) {
    console.log(`[app] ${signal} received — shutting down gracefully`);

    // Close WebSocket connections
    for (const sockets of _userSockets.values()) {
        for (const ws of sockets) {
            try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
        }
    }
    _userSockets.clear();

    // Close HTTP server
    server.close(() => {
        console.log('[app] HTTP server closed');
    });

    try {
        await closeOrchestrator();
        await closeRedis();
        await db.end();
    } catch (err) {
        console.error('[app] shutdown error:', err.message);
    }

    setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT',  () => _shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
    console.error('[app] unhandledRejection:', err);
});

start().catch((err) => {
    console.error('[app] startup failed:', err);
    process.exit(1);
});

module.exports = { app, server };
