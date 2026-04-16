'use strict';

const jwt = require('jsonwebtoken');

/**
 * JWT authentication middleware.
 * Expects: Authorization: Bearer <token>
 */
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = header.slice(7);
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = payload.sub;  // UUID of the authenticated user
        next();
    } catch (err) {
        const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token';
        return res.status(401).json({ error: msg });
    }
}

module.exports = { requireAuth };
