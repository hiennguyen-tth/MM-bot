'use strict';

const { validationResult } = require('express-validator');

/**
 * Middleware: abort request if express-validator found errors.
 * Attach this AFTER your validation chain, BEFORE the handler.
 */
function validate(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
}

module.exports = { validate };
