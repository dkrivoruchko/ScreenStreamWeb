import logger from '../logger.js';
import dgram from 'node:dgram';
import { Buffer } from 'node:buffer';
import { createHmac } from 'crypto';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;

const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET;
const GOOGLE_STUN_SERVERS_ADDRESS = [
    'stun.l.google.com',
    'stun1.l.google.com',
    'stun2.l.google.com',
    'stun3.l.google.com',
    'stun4.l.google.com',
];

const GOOGLE_STUN_SERVERS_PORT = 19302;
const STUN_SERVERS_CHECK_TIMEOUT = 5 * 60 * 1000;   // 5 minutes
const RECHECK_INACTIVE_DELAY = 30 * 60 * 1000;      // 30 minutes
const STUN_SERVERS_CHECK_REQUEST_BUFFER = Buffer.from([
    0x00, 0x01, 0x00, 0x00, // STUN binding request
    0x21, 0x12, 0xA4, 0x42, // Magic cookie
    ...Array(12).fill(0x00) // Transaction ID (12 bytes)
]);

const ACTIVE_STUN_SERVERS = new Set(GOOGLE_STUN_SERVERS_ADDRESS);
const INACTIVE_STUN_SERVERS = new Set();

const TURN_CREDENTIAL_VALID_DURATION = 6 * 60 * 60; // 6 hours

function verifyStunServer(address, port = GOOGLE_STUN_SERVERS_PORT) {
    return new Promise((resolve) => {
        const client = dgram.createSocket('udp4');
        let socketClosed = false;

        const finish = (isActive, logMessage = null) => {
            if (socketClosed) return;

            if (isActive) {
                ACTIVE_STUN_SERVERS.add(address);
                INACTIVE_STUN_SERVERS.delete(address);
            } else {
                ACTIVE_STUN_SERVERS.delete(address);
                INACTIVE_STUN_SERVERS.add(address);
            }

            if (logMessage) logger.warn(logMessage);

            socketClosed = true;
            client.close();
            resolve(isActive);
        };

        client.on('message', () => {
            finish(true);
        });

        client.on('error', (err) => {
            finish(false, `Failed to reach STUN server ${address}: ${err.message}`);
        });

        client.send(STUN_SERVERS_CHECK_REQUEST_BUFFER, port, address, (err) => {
            if (err) {
                finish(false, `Error sending STUN request to ${address}: ${err.message}`);
            }
        });

        setTimeout(() => {
            if (!socketClosed) {
                logger.debug(`No STUN response from ${address} (assuming down).`);
                finish(false);
            }
        }, 5000);
    });
}

function updateActiveServers() {
    Promise.allSettled(GOOGLE_STUN_SERVERS_ADDRESS.map((address) => verifyStunServer(address))).finally(() => {
        setTimeout(updateActiveServers, STUN_SERVERS_CHECK_TIMEOUT);
    });
}

function recheckInactiveServers() {
    if (INACTIVE_STUN_SERVERS.size > 0) {
        logger.debug(`Re-checking ${INACTIVE_STUN_SERVERS.size} inactive STUN server(s)...`);
        Promise.allSettled(Array.from(INACTIVE_STUN_SERVERS, (address) => verifyStunServer(address))).finally(() => {
            setTimeout(recheckInactiveServers, RECHECK_INACTIVE_DELAY);
        });
        return;
    }

    setTimeout(recheckInactiveServers, RECHECK_INACTIVE_DELAY);
}

updateActiveServers();
recheckInactiveServers();

export function getIceServers(username) {
    return [getStunServer(), ...getTurnServers(username)];
}

function getStunServer() {
    const stunServers = Array.from(ACTIVE_STUN_SERVERS);
    if (stunServers.length === 0) {
        logger.warn('No active STUN servers available; falling back to default.');
        return { urls: `stun:stun.l.google.com:${GOOGLE_STUN_SERVERS_PORT}` };
    }

    const chosen = stunServers[Math.floor(Math.random() * stunServers.length)];
    return { urls: `stun:${chosen}:${GOOGLE_STUN_SERVERS_PORT}` };
}

function getTurnServers(username) {
    const turnUsername = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_VALID_DURATION}:${username}`;
    const hmac = createHmac('sha1', TURN_SHARED_SECRET);
    hmac.update(turnUsername);
    const turnPassword = hmac.digest().toString('base64');

    return [
        {
            urls: `turn:turn.${SERVER_ORIGIN}:3478?transport=udp`,
            username: turnUsername,
            credential: turnPassword
        },
        {
            urls: `turn:turn.${SERVER_ORIGIN}:3478?transport=tcp`,
            username: turnUsername,
            credential: turnPassword
        }
    ];
}
