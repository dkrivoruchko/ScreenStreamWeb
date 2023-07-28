// Create and manage nonce for Google Play Integrity API https://developer.android.com/google/play/integrity
// Used to validate Android app requests

import { randomBytes } from 'crypto';

export const NONCE_MIN_WAIT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const NONCES_CLEAN_TASK_PERIOD = 2 * 60 * 1000; // 2 minute
const nonces = new Map();

export function nonceHandler(reg, res) {
    let nonce;
    do {
        nonce = randomBytes(32).toString('base64url');
    } while (nonces.has(nonce));

    nonces.set(nonce, Date.now() + NONCE_MIN_WAIT_TIMEOUT);

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

function cleanNonces() {
    let removed = 0;
    nonces.forEach((value, key, map) => { if (value <= Date.now()) { map.delete(key); removed++; } });
    console.debug(`Nonces total: ${nonces.size}, cleaned: ${removed}`);
    setTimeout(cleanNonces, NONCES_CLEAN_TASK_PERIOD);
}

cleanNonces();