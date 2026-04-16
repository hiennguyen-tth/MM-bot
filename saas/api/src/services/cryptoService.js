'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;
const TAG_BYTES = 16;

function _getKey() {
    const hex = process.env.ENCRYPTION_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns: "b64(iv):b64(authTag):b64(ciphertext)"
 */
function encrypt(plaintext) {
    const key = _getKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });

    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt AES-256-GCM string.
 * Input format: "b64(iv):b64(authTag):b64(ciphertext)"
 */
function decrypt(encStr) {
    const parts = encStr.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted string format');

    const key = _getKey();
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ctBytes = Buffer.from(parts[2], 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ctBytes), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
