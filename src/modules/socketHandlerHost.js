import logger, { redactLogPayload } from '../logger.js';
import * as jose from 'jose';
import { isStreamIdValid, createNewStreamId, enqueueSocketTask, getClientSocket, getHostSocket, invalidateClientsForRejoin, installStaleClientAckHandlers, getNoPayloadAck, leaveJoinedRooms } from './stream.js';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const ANDROID_APP_PACKAGE = process.env.ANDROID_APP_PACKAGE;
const PROTOCOL_VERSION = 1;
const SOCKET_TIMEOUT = 9000; // Keep server relay ACK timeout below Android v1 10s AckWithTimeout.

async function hasClientsForOtherHost(io, streamId, hostSocketId) {
    const socketsInStream = await io.in(streamId).fetchSockets();
    return socketsInStream.some(item =>
        item.id !== hostSocketId &&
        item.connected &&
        item.data?.isClient === true &&
        item.data?.protocolVersion === PROTOCOL_VERSION &&
        item.data?.relayHostContext?.hostSocketId !== hostSocketId
    );
}

export default function (io, socket) {

    const isCurrentHostSocket = async (streamId, hostSocketId, protocolVersion) => {
        const currentHostSocket = await getHostSocket(io, streamId);
        return currentHostSocket?.id === hostSocketId &&
            currentHostSocket?.connected === true &&
            currentHostSocket?.data?.streamId === streamId &&
            currentHostSocket?.data?.protocolVersion === protocolVersion;
    };

    const disconnectPreviousHost = (event, hostSocket, streamId) => {
        logger.warn({ socket_event: event, socket: socket.id, streamId, message: `Disconnecting previous host socket: ${hostSocket.id}` });
        leaveJoinedRooms(hostSocket);
        hostSocket.disconnect();
    };

    const resolveRequestedStream = async (event, requestedStreamId, streamId, pubKey, replacedExistingHost = false) => {
        if (!requestedStreamId || streamId !== requestedStreamId) return { streamId, replacedExistingHost };

        const hostSockets = (await io.in(streamId).fetchSockets()).filter(item => item.id !== socket.id && item.data?.isHost === true);
        if (hostSockets.length > 1) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'TOO_MANY_HOSTS', host_sockets: hostSockets.map(s => s.id) });
            return { streamId: createNewStreamId(io), replacedExistingHost: false };
        }

        const hostSocket = hostSockets[0];
        if (!hostSocket) return { streamId, replacedExistingHost };
        if (hostSocket.data?.pubKey !== pubKey) return { streamId: createNewStreamId(io), replacedExistingHost: false };

        disconnectPreviousHost(event, hostSocket, streamId);
        return { streamId, replacedExistingHost: true };
    };

    // [STREAM:CREATE] ========================================================================================================

    const createStream = async (payload, callback) => {
        const event = '[STREAM:CREATE]';
        const logCreate = (level, result, ackStatus, extra = {}) => logger[level]({ event_name: 'stream_create_outcome', socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, result, ack_status: ackStatus, ...extra });

        logger.debug({ socket_event: event, socket: socket.id, payload: redactLogPayload(payload), message: 'New stream create request' });

        if (socket.data.handshakeInProgress) {
            logCreate('warn', 'error', 'ERROR:HANDSHAKE_IN_PROGRESS', { reason: 'HANDSHAKE_IN_PROGRESS' });
            return callback({ status: 'ERROR:HANDSHAKE_IN_PROGRESS' });
        }

        try {
            socket.data.handshakeInProgress = true;

            if (!payload || !payload.jwt) {
                logCreate('warn', 'error', 'ERROR:NO_JWT_SET', { reason: 'NO_JWT_SET' });
                callback({ status: 'ERROR:NO_JWT_SET' });
                return;
            }

            let pubKey;
            let requestedStreamId;
            try {
                const claims = jose.decodeJwt(payload.jwt);
                if (!claims || typeof claims !== 'object') throw new Error('INVALID_JWT_FORMAT');

                const pubKeyStr = claims.pubKey;
                if (typeof pubKeyStr !== 'string') throw new Error('INVALID_PUBKEY_FORMAT');

                const ecPublicKey = await jose.importSPKI(pubKeyStr, 'ES256');
                const verifyResult = await jose.jwtVerify(payload.jwt, ecPublicKey, { audience: SERVER_ORIGIN, issuer: ANDROID_APP_PACKAGE });

                if ('streamId' in verifyResult.payload) {
                    if (typeof verifyResult.payload.streamId !== 'string') throw new Error('BAD_STREAM_ID1');
                    requestedStreamId = verifyResult.payload.streamId.trim();
                    if (!isStreamIdValid(requestedStreamId)) throw new Error('BAD_STREAM_ID2');
                }

                if (!verifyResult.payload.pubKey || typeof verifyResult.payload.pubKey !== 'string' || verifyResult.payload.pubKey.trim().length === 0) throw new Error('BAD_PUB_KEY');
                pubKey = verifyResult.payload.pubKey;
            } catch (cause) {
                logCreate('warn', 'error', 'ERROR:JWT_VERIFICATION_FILED', { reason: 'JWT_VERIFICATION_FILED', message: cause.message });
                callback({ status: 'ERROR:JWT_VERIFICATION_FILED' });
                return;
            }

            if (socket.data.streamId) {
                if (socket.data.pubKey === pubKey && (!requestedStreamId || requestedStreamId === socket.data.streamId)) {
                    logCreate('info', 'ok', 'OK', { streamId: socket.data.streamId });
                    callback({ status: 'OK', streamId: socket.data.streamId });
                } else {
                    logCreate('warn', 'error', 'ERROR:STREAM_ID_ALREADY_SET', { reason: 'STREAM_ID_ALREADY_SET' });
                    callback({ status: 'ERROR:STREAM_ID_ALREADY_SET' });
                }
                return;
            }

            let streamId = requestedStreamId || createNewStreamId(io);
            let replacedExistingHost = false;
            ({ streamId, replacedExistingHost } = await resolveRequestedStream(event, requestedStreamId, streamId, pubKey, replacedExistingHost));

            if (!socket.connected) {
                logger.warn({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' });
                return;
            }

            const listeners = [['STREAM:REMOVE', removeStream], ['STREAM:START', startStream], ['STREAM:STOP', stopStream], ['HOST:OFFER', hostOffer], ['HOST:CANDIDATE', hostCandidate], ['REMOVE:CLIENT', removeClient]];
            listeners.forEach(([name, handler]) => { socket.removeAllListeners(name); socket.on(name, handler); });

            socket.data.streamId = streamId;
            socket.data.pubKey = pubKey;
            socket.data.protocolVersion = PROTOCOL_VERSION;
            socket.data.isStreamRunning = false;
            socket.join(streamId);

            const rejoinClients = replacedExistingHost || await hasClientsForOtherHost(io, streamId, socket.id);
            if (rejoinClients) await invalidateClientsForRejoin(io, streamId, socket.id);
            logCreate('info', 'ok', 'OK', { streamId, replaced_host: replacedExistingHost, rejoin_clients: rejoinClients });
            callback({ status: 'OK', streamId });
        } finally {
            socket.data.handshakeInProgress = false;
        }
    }

    socket.removeAllListeners('STREAM:CREATE');
    socket.on('STREAM:CREATE', createStream);

    // [STREAM:REMOVE] ========================================================================================================

    const removeStream = async (...args) => {
        const event = '[STREAM:REMOVE]';
        const callback = getNoPayloadAck(args);
        if (!callback) return;

        logger.debug({ socket_event: event, socket: socket.id, message: 'New stream remove request' });

        if (!socket.data.streamId) { //its ok, just ignore and notify host
            logger.warn({ socket_event: event, socket: socket.id, reason: 'STREAM_ID_NOT_SET' });
            callback({ status: 'OK' });
            return;
        }

        const streamId = socket.data.streamId;

        const clientSockets = await io.in(streamId).fetchSockets();
        clientSockets.forEach(clientSocket => {
            if (clientSocket.id === socket.id) return;
            clientSocket.emit('REMOVE:STREAM'); //This is client only event, don't mix it with 'STREAM:REMOVE' from host
            clientSocket.leave(streamId);
            installStaleClientAckHandlers(clientSocket);
        });

        socket.leave(streamId);
        socket.data.streamId = undefined;
        socket.data.pubKey = undefined;
        socket.data.protocolVersion = undefined;
        socket.data.isStreamRunning = false;

        socket.removeAllListeners('STREAM:REMOVE');
        socket.removeAllListeners('STREAM:START');
        socket.removeAllListeners('STREAM:STOP');
        socket.removeAllListeners('HOST:OFFER');
        socket.removeAllListeners('HOST:CANDIDATE');
        socket.removeAllListeners('REMOVE:CLIENT');

        callback({ status: 'OK' });
    }

    // [STREAM:START] ========================================================================================================

    const startStream = async (payload, callback) => {
        const event = '[STREAM:START]';

        logger.debug({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, payload: redactLogPayload(payload), message: 'Stream start request' });

        if (!payload || !payload.clientId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_CLIENT_ID_SET' });
            callback({ status: 'ERROR:NO_CLIENT_ID_SET' });
            return;
        }

        if (!socket.data.streamId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_STREAM_ID_SET' });
            callback({ status: 'OK' });
            return;
        }

        if (payload.clientId === 'ALL') {
            socket.data.isStreamRunning = true;
            socket.to(socket.data.streamId).emit('STREAM:START');
            callback({ status: 'OK' });
        } else {
            const socketsInStream = await io.in(socket.data.streamId).fetchSockets();
            const clientSocket = socketsInStream.find(item => item.data && item.data.clientId === payload.clientId);

            if (!clientSocket) {
                logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, clientId: payload.clientId, reason: 'NO_CLIENT_FOUND' });

                callback({ status: 'ERROR:NO_CLIENT_FOUND' });
                return;
            }

            callback({ status: 'OK' });
            socket.data.isStreamRunning = true;

            if (!clientSocket.connected) {
                logger.warn({ socket_event: event, socket: socket.id, message: 'Client socket not connected. Ignoring.' });
                return;
            }

            clientSocket.emit('STREAM:START');
        }
    }

    // [STREAM:STOP] ========================================================================================================

    const stopStream = (...args) => {
        const event = '[STREAM:STOP]';
        const callback = getNoPayloadAck(args);
        if (!callback) return;

        if (!socket.data.streamId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_STREAM_ID_SET' });
            callback({ status: 'OK' });
            return;
        }

        socket.data.isStreamRunning = false;
        socket.to(socket.data.streamId).emit('STREAM:STOP');

        callback({ status: 'OK' });
    }

    // [HOST:OFFER] ========================================================================================================

    const hostOffer = async (payload, callback) => {
        const event = '[HOST:OFFER]';

        if (!payload || !payload.clientId || !payload.offer) {
            logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, payload: redactLogPayload(payload), reason: 'EMPTY_OR_BAD_DATA' });
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        if (!socket.data.streamId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_STREAM_ID_SET' });
            callback({ status: 'OK' });
            return;
        }

        const streamId = socket.data.streamId;
        const hostSocketId = socket.id;
        const protocolVersion = socket.data.protocolVersion;
        const preferredClientSocketId = socket.data?.currentClientSocketIds?.[payload.clientId];
        const clientSocket = await getClientSocket(io, streamId, payload.clientId, preferredClientSocketId);

        if (!clientSocket) {
            logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, clientId: payload.clientId, reason: 'NO_CLIENT_FOUND' });
            callback({ status: 'ERROR:NO_CLIENT_FOUND' });
            return;
        }


        if (!clientSocket.connected) {
            logger.warn({ socket_event: event, socket: socket.id, message: 'Client socket not connected. Ignoring.' });
            callback({ status: 'ERROR:NO_CLIENT_FOUND' });
            return;
        }

        if (!(await isCurrentHostSocket(streamId, hostSocketId, protocolVersion))) {
            logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, classification: 'stale_host_relay_ignored', message: 'Ignoring stale legacy host relay.' });
            callback({ status: 'OK' });
            return;
        }

        clientSocket.timeout(SOCKET_TIMEOUT).emit('HOST:OFFER', { offer: payload.offer }, async (err, response) => {
            if (!socket.connected) {
                logger.debug({ socket_event: event, socket: socket.id, clientId: payload.clientId, client_socket: clientSocket.id, message: 'HOST:OFFER Host socket disconnected. Ignoring' });
                return;
            }

            if (!(await isCurrentHostSocket(streamId, hostSocketId, protocolVersion))) {
                logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, classification: 'stale_host_relay_ignored', message: 'Ignoring stale legacy host relay.' });
                callback({ status: 'OK' });
                return;
            }

            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: 'ERROR:TIMEOUT_OR_NO_RESPONSE' });
                callback({ status: 'ERROR:TIMEOUT_OR_NO_RESPONSE' });
                return;
            }

            const currentClientSocket = await getClientSocket(io, streamId, payload.clientId);
            if (!currentClientSocket || currentClientSocket.id !== clientSocket.id) {
                logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, client_socket: clientSocket.id, current_client_socket: currentClientSocket?.id, message: 'HOST:OFFER response is from stale client socket' });
                callback({ status: 'OK' });
                return;
            }

            callback({ status: response?.status || 'ERROR:EMPTY_OR_BAD_DATA' });

            if (response?.status !== 'OK') {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, client_socket: clientSocket.id, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: response?.status || 'ERROR:EMPTY_OR_BAD_DATA' });
            }
        });
    }

    // [HOST:CANDIDATE] ========================================================================================================

    const hostCandidate = async (payload, callback) => {
        const event = '[HOST:CANDIDATE]';

        if (!payload || !payload.clientId || (!payload.candidate && !payload.candidates)) {
            logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, payload: redactLogPayload(payload), reason: 'EMPTY_OR_BAD_DATA' });
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        if (!socket.data.streamId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_STREAM_ID_SET' });
            callback({ status: 'OK' });
            return;
        }

        const queueKey = `${event}:${socket.data.streamId}:${payload.clientId}`;
        return enqueueSocketTask(socket, queueKey, async () => {
            const streamId = socket.data.streamId;
            const hostSocketId = socket.id;
            const protocolVersion = socket.data.protocolVersion;
            const preferredClientSocketId = socket.data?.currentClientSocketIds?.[payload.clientId];
            const clientSocket = await getClientSocket(io, streamId, payload.clientId, preferredClientSocketId);

            if (!clientSocket) {
                logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, clientId: payload.clientId, reason: 'NO_CLIENT_FOUND' });
                callback({ status: 'ERROR:NO_CLIENT_FOUND' });
                return;
            }

            if (!clientSocket.connected) {
                logger.warn({ socket_event: event, socket: socket.id, message: 'Client socket not connected. Ignoring.' });
                callback({ status: 'ERROR:NO_CLIENT_FOUND' });
                return;
            }

            if (!(await isCurrentHostSocket(streamId, hostSocketId, protocolVersion))) {
                logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, classification: 'stale_host_relay_ignored', message: 'Ignoring stale legacy host relay.' });
                callback({ status: 'OK' });
                return;
            }

            const candidates = payload.candidates ? payload.candidates : [payload.candidate];

            clientSocket.timeout(SOCKET_TIMEOUT).emit('HOST:CANDIDATE', { candidates }, async (err, response) => {
                if (!socket.connected) {
                    logger.debug({ socket_event: event, socket: socket.id, clientId: payload.clientId, client_socket: clientSocket.id, message: 'HOST:CANDIDATE Host socket disconnected. Ignoring' });
                    return;
                }

                if (!(await isCurrentHostSocket(streamId, hostSocketId, protocolVersion))) {
                    logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, classification: 'stale_host_relay_ignored', message: 'Ignoring stale legacy host relay.' });
                    callback({ status: 'OK' });
                    return;
                }

                if (err) {
                    logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: 'ERROR:TIMEOUT_OR_NO_RESPONSE' });
                    callback({ status: 'ERROR:TIMEOUT_OR_NO_RESPONSE' });
                    return;
                }

                const currentClientSocket = await getClientSocket(io, streamId, payload.clientId);
                if (!currentClientSocket || currentClientSocket.id !== clientSocket.id) {
                    logger.debug({ socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, client_socket: clientSocket.id, current_client_socket: currentClientSocket?.id, message: 'HOST:CANDIDATE response is from stale client socket' });
                    callback({ status: 'OK' });
                    return;
                }

                callback({ status: response?.status || 'ERROR:EMPTY_OR_BAD_DATA' });

                if (response?.status !== 'OK') {
                    logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId: payload.clientId, client_socket: clientSocket.id, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: response?.status || 'ERROR:EMPTY_OR_BAD_DATA' });
                }
            });
        });
    }

    // [REMOVE:CLIENT] ========================================================================================================

    const removeClient = async (payload, callback) => {
        const event = '[REMOVE:CLIENT]';

        if (!payload || !payload.clientId || !Array.isArray(payload.clientId)) {
            logger.warn({ socket_event: event, socket: socket.id, streamId: socket.data.streamId, payload: redactLogPayload(payload), reason: 'EMPTY_OR_BAD_DATA' });
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        if (!socket.data.streamId) {
            logger.warn({ socket_event: event, socket: socket.id, reason: 'NO_STREAM_ID_SET' });
            callback({ status: 'OK' });
            return;
        }

        const streamId = socket.data.streamId;
        const socketsInStream = await io.in(streamId).fetchSockets();
        const clientSockets = socketsInStream.filter(item => item.data && item.data.isClient === true && payload.clientId.includes(item.data.clientId));

        if (clientSockets.length === 0) {
            logger.debug({ socket_event: event, socket: socket.id, streamId, message: 'No client found' });
            callback({ status: 'OK' });
            return;
        }

        logger.warn({ socket_event: event, socket: socket.id, streamId, message: `Disconnecting clients [${payload.reason}]: ${clientSockets.length}` });

        clientSockets.forEach(clientSocket => {
            if (clientSocket.connected) {
                clientSocket.rooms.forEach(room => { if (room != clientSocket.id) clientSocket.leave(room); });
                clientSocket.data.relayHostContext = undefined;
                clientSocket.data.protocolVersion = undefined;
                installStaleClientAckHandlers(clientSocket);
                if (socket.data?.currentClientSocketIds?.[clientSocket.data.clientId] === clientSocket.id) {
                    delete socket.data.currentClientSocketIds[clientSocket.data.clientId];
                }

                clientSocket.timeout(SOCKET_TIMEOUT).emit('REMOVE:CLIENT', (err, response) => {
                    if (err) {
                        logger.info({ socket_event: event, socket: clientSocket.id, reason: 'TIMEOUT_OR_NO_RESPONSE' });
                        return;
                    }
                });
            }
        });

        callback({ status: 'OK' });
    }
}
