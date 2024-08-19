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

const GOOGLE_STUN_SERVERS_PORT = 19302
const STUN_SERVERS_CHECK_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const STUN_SERVERS_CHECK_REQUEST_BUFFER = Buffer.from([
    0x00, 0x01, 0x00, 0x00, // STUN binding request
    0x21, 0x12, 0xA4, 0x42, // Magic cookie
    ...Array(12).fill(0x00)  // Transaction ID (12 bytes)
]);

const ACTIVE_STUN_SERVERS = new Set(GOOGLE_STUN_SERVERS_ADDRESS);

const TURN_CREDENTIAL_VALID_DURATION = 6 * 60 * 60; // 6 hours

function verifyStunServer(address, port = GOOGLE_STUN_SERVERS_PORT) {
    const client = dgram.createSocket('udp4');

    let socketClosed = false;

    client.on('message', (message) => {
        if (!socketClosed) {
            ACTIVE_STUN_SERVERS.add(address);
            socketClosed = true;
            client.close();
        }
    });

    client.on('error', (err) => {
        if (!socketClosed) {
            logger.warn(`Failed to reach the STUN server ${address}:`, err);
            ACTIVE_STUN_SERVERS.delete(address);
            socketClosed = true;
            client.close();
        }
    });

    client.send(STUN_SERVERS_CHECK_REQUEST_BUFFER, port, address, (err) => {
        if (err && !socketClosed) {
            ACTIVE_STUN_SERVERS.delete(address);
            logger.warn(`Error sending STUN request ${address}:`, err.message);
            socketClosed = true;
            client.close();
        }
    });

    setTimeout(() => {
        if (!socketClosed) {
            logger.debug(`No response from STUN server, it might be down: ${address}`);
            ACTIVE_STUN_SERVERS.delete(address);
            client.close();
        }
    }, 5000);
};

function updateActiveServers() {
    GOOGLE_STUN_SERVERS_ADDRESS.forEach(address => verifyStunServer(address));

    setTimeout(updateActiveServers, STUN_SERVERS_CHECK_TIMEOUT);
};

updateActiveServers();

export function getIceServers(username) {
    const stun = getStunServer();
    const turn = getTurnServer(username);
    return [stun, getStunServer()];
    // return [stun, turn];
};

function getStunServer() {
    const stunServers = Array.from(ACTIVE_STUN_SERVERS);
    const stun = stunServers[Math.floor(Math.random() * stunServers.length)];
    return {
        urls: `stun:${stun}:${GOOGLE_STUN_SERVERS_PORT}`
    }
}

function getTurnServer(username) {
    const turnUsername = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_VALID_DURATION}:${username}`;

    const hmac = createHmac('sha1', TURN_SHARED_SECRET);
    hmac.update(turnUsername);
    const turnPassword = hmac.digest().toString('base64');

    return {
        urls: `turn:turn.${SERVER_ORIGIN}:3478?transport=udp`,
        username: turnUsername,
        credential: turnPassword
    }
};