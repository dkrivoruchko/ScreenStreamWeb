// Create and manage nonce for Google Play Integrity API https://developer.android.com/google/play/integrity
// Used to validate Android app requests

import logger from '../logger.js';
import { randomBytes } from 'crypto';

const NONCE_MIN_WAIT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const NONCES_CLEAN_TASK_PERIOD = 5 * 60 * 1000; // 5 minute
const MAX_NONCES = 1000;
const nonces = new Map();

export function nonceHandler(reg, res) {
    let nonce;
    do {
        nonce = randomBytes(32).toString('base64url');
    } while (nonces.has(nonce));

    nonces.set(nonce, Date.now() + NONCE_MIN_WAIT_TIMEOUT);

    if (nonces.size >= MAX_NONCES) {
        const now = Date.now();
        nonces.forEach((value, key, map) => { if (value <= now) map.delete(key); });

        if (nonces.size >= MAX_NONCES) {
            return res.status(503).send('Server busy, try again later');
        }
    }

    res
        .type('txt')
        .setHeader('Cache-Control', 'no-store')
        .set('Connection', 'close')
        .send(nonce);
}

export function isValidNonce(nonce) {
    const present = nonces.has(nonce);
    nonces.delete(nonce);
    return present;
}

const cleanupInterval = setInterval(() => {
    try {
        const now = Date.now();
        nonces.forEach((value, key, map) => {
            if (value <= now) map.delete(key);
        });
    } catch (error) {
        logger.error('Error in cleanNonces:', error);
    }
}, NONCES_CLEAN_TASK_PERIOD);

process.on('SIGTERM', () => {
    clearInterval(cleanupInterval);
});