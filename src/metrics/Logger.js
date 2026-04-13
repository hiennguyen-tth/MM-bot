'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Ensure logs/ directory exists before wiring up file transports
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length
            ? ' ' + JSON.stringify(meta)
            : '';
        return `${timestamp} [${level}] ${message}${metaStr}`;
    })
);

const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
            filename: path.join(logsDir, 'bot.log'),
            format: fileFormat,
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
        }),
    ],
});

module.exports = logger;
