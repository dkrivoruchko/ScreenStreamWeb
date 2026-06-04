import logger, { redactLogPayload } from '../../logger.js';
import * as jose from 'jose';
import { ack, isObject, PROTOCOL_VERSION, validAttemptId } from './common.js';
import {
    clearClientRelayState,
    createNewStreamId,
    getClientSocket,
    getHostSocket,
    getNoPayloadAck,
    enqueueSocketTask,
    installStaleClientAckHandlers,
    invalidateClientsForRejoin,
    isStreamIdValid,
    leaveJoinedRooms
} from '../stream.js';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const ANDROID_APP_PACKAGE = process.env.ANDROID_APP_PACKAGE;
const SOCKET_TIMEOUT = 9000;

const Status = {
    OK: 'OK',
    BAD_DATA: 'ERROR:EMPTY_OR_BAD_DATA',
    NO_STREAM_ID: 'ERROR:NO_STREAM_ID_SET',
    NO_CLIENT: 'ERROR:NO_CLIENT_FOUND',
    TIMEOUT: 'ERROR:TIMEOUT_OR_NO_RESPONSE',
};

async function verifyHostJwt(jwt) {
    const claims = jose.decodeJwt(jwt);
    if (!claims || typeof claims !== 'object') throw new Error('INVALID_JWT_FORMAT');
    if (typeof claims.pubKey !== 'string') throw new Error('INVALID_PUBKEY_FORMAT');

    const ecPublicKey = await jose.importSPKI(claims.pubKey, 'ES256');
    const verifyResult = await jose.jwtVerify(jwt, ecPublicKey, { audience: SERVER_ORIGIN, issuer: ANDROID_APP_PACKAGE });
    const pubKey = verifyResult.payload.pubKey;
    if (typeof pubKey !== 'string' || pubKey.trim().length === 0) throw new Error('BAD_PUB_KEY');

    let requestedStreamId;
    if ('streamId' in verifyResult.payload) {
        if (typeof verifyResult.payload.streamId !== 'string') throw new Error('BAD_STREAM_ID');
        requestedStreamId = verifyResult.payload.streamId.trim();
        if (!isStreamIdValid(requestedStreamId)) throw new Error('BAD_STREAM_ID');
    }

    return { pubKey, requestedStreamId };
}

export default function (io, socket) {

    async function isCurrentHost(streamId = socket.data?.streamId, hostCreateAttemptId = socket.data?.hostCreateAttemptId) {
        if (!socket.connected || !streamId || !hostCreateAttemptId) return false;
        const currentHost = await getHostSocket(io, streamId);
        return currentHost?.id === socket.id &&
            currentHost?.connected === true &&
            currentHost?.data?.streamId === streamId &&
            currentHost?.data?.hostCreateAttemptId === hostCreateAttemptId &&
            currentHost?.data?.protocolVersion === PROTOCOL_VERSION;
    }

    function staleOk(callback, event, extra = {}) {
        logger.debug({ socket_event: event, socket: socket.id, streamId: socket.data?.streamId, classification: 'stale_attempt_ignored', message: 'Ignoring stale v2 host event.', ...extra });
        ack(callback, Status.OK);
    }

    async function resolveRequestedStream(event, requestedStreamId, pubKey) {
        if (!requestedStreamId) return { streamId: createNewStreamId(io), replaced: false };

        const hostSockets = (await io.in(requestedStreamId).fetchSockets()).filter(item => item.id !== socket.id && item.data?.isHost === true);
        const activeHost = hostSockets.find(item => item.connected);
        if (!activeHost) return { streamId: requestedStreamId, replaced: false };

        if (activeHost.data?.pubKey !== pubKey) return { streamId: createNewStreamId(io), replaced: false };

        logger.warn({ socket_event: event, socket: socket.id, streamId: requestedStreamId, host_socket: activeHost.id, message: 'Reclaiming streamId for same host identity' });
        leaveJoinedRooms(activeHost);
        activeHost.disconnect();
        return { streamId: requestedStreamId, replaced: true };
    }

    async function resolveClientRelay(event, payload, callback) {
        if (!socket.data.streamId) {
            ack(callback, Status.NO_STREAM_ID);
            return null;
        }

        if (!(await isCurrentHost())) {
            staleOk(callback, event, { clientId: payload?.clientId });
            return null;
        }

        const clientSocket = await getClientSocket(io, socket.data.streamId, payload.clientId, socket.data.currentClientSocketIds?.[payload.clientId]);
        if (!clientSocket) {
            ack(callback, Status.NO_CLIENT);
            return null;
        }

        if (clientSocket.data?.joinAttemptId !== payload.joinAttemptId) {
            staleOk(callback, event, { clientId: payload.clientId, joinAttemptId: payload.joinAttemptId, currentJoinAttemptId: clientSocket.data?.joinAttemptId, });
            return null;
        }

        return { streamId: socket.data.streamId, clientSocket, clientId: payload.clientId, joinAttemptId: payload.joinAttemptId, };
    }

    function relayToClient(event, relay, targetEvent, payload, callback) {
        relay.clientSocket.timeout(SOCKET_TIMEOUT).emit(targetEvent, payload, async (err, response) => {
            if (!socket.connected) return;
            if (!(await isCurrentHost(relay.streamId))) {
                staleOk(callback, event, { clientId: relay.clientId, joinAttemptId: relay.joinAttemptId, negotiationAttemptId: payload.negotiationAttemptId });
                return;
            }
            const currentClientSocketId = socket.data.currentClientSocketIds?.[relay.clientId];
            const clientSocket = currentClientSocketId === relay.clientSocket.id ? await getClientSocket(io, relay.streamId, relay.clientId, currentClientSocketId) : null;
            if (clientSocket?.id !== relay.clientSocket.id || clientSocket?.data?.joinAttemptId !== relay.joinAttemptId) {
                staleOk(callback, event, { clientId: relay.clientId, joinAttemptId: relay.joinAttemptId, negotiationAttemptId: payload.negotiationAttemptId });
                return;
            }
            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: relay.clientId, joinAttemptId: relay.joinAttemptId, negotiationAttemptId: payload.negotiationAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: Status.TIMEOUT });
                ack(callback, Status.TIMEOUT);
                return;
            }
            const ackStatus = response?.status || Status.BAD_DATA;
            if (ackStatus !== Status.OK) logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: relay.clientId, joinAttemptId: relay.joinAttemptId, negotiationAttemptId: payload.negotiationAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: ackStatus });
            ack(callback, ackStatus);
        });
    }

    const createStream = async (payload, callback) => {
        const event = '[STREAM:CREATE]';
        const hostCreateAttemptId = validAttemptId(payload?.hostCreateAttemptId);
        const logCreate = (level, result, ackStatus, extra = {}) => logger[level]({ event_name: 'stream_create_outcome', socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, hostCreateAttemptId, result, ack_status: ackStatus, ...extra });

        logger.debug({ socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, hostCreateAttemptId, payload: redactLogPayload(payload), message: 'New v2 stream create request' });

        if (!isObject(payload) || !payload.jwt || !hostCreateAttemptId) {
            logCreate('warn', 'error', Status.BAD_DATA);
            ack(callback, Status.BAD_DATA);
            return;
        }

        if (socket.data.handshakeInProgress) {
            logCreate('warn', 'error', 'ERROR:HANDSHAKE_IN_PROGRESS');
            ack(callback, 'ERROR:HANDSHAKE_IN_PROGRESS');
            return;
        }

        try {
            socket.data.handshakeInProgress = true;
            const { pubKey, requestedStreamId } = await verifyHostJwt(payload.jwt);

            if (socket.data.streamId) {
                if (socket.data.pubKey === pubKey && socket.data.hostCreateAttemptId === hostCreateAttemptId) {
                    logCreate('info', 'ok', Status.OK, { streamId: socket.data.streamId });
                    ack(callback, Status.OK, { streamId: socket.data.streamId });
                } else {
                    logCreate('warn', 'error', 'ERROR:STREAM_ID_ALREADY_SET');
                    ack(callback, 'ERROR:STREAM_ID_ALREADY_SET');
                }
                return;
            }

            const { streamId, replaced } = await resolveRequestedStream(event, requestedStreamId, pubKey);
            if (!socket.connected) return;

            const listeners = [
                ['STREAM:REMOVE', removeStream],
                ['STREAM:STOP', stopStream],
                ['STREAM:START', startStream],
                ['HOST:OFFER', hostOffer],
                ['HOST:CANDIDATE', hostCandidate],
                ['REMOVE:CLIENT', removeClient],
            ];
            listeners.forEach(([name, handler]) => { socket.removeAllListeners(name); socket.on(name, handler); });

            socket.data.streamId = streamId;
            socket.data.pubKey = pubKey;
            socket.data.protocolVersion = PROTOCOL_VERSION;
            socket.data.hostCreateAttemptId = hostCreateAttemptId;
            socket.data.currentClientSocketIds = {};
            socket.data.isStreamRunning = false;
            socket.join(streamId);

            if (replaced) await invalidateClientsForRejoin(io, streamId, socket.id);
            logCreate('info', 'ok', Status.OK, { streamId, replaced_host: replaced });
            ack(callback, Status.OK, { streamId });
        } catch (cause) {
            logger.warn({ event_name: 'stream_create_outcome', socket_event: event, socket: socket.id, protocol_version: PROTOCOL_VERSION, hostCreateAttemptId, result: 'error', ack_status: 'ERROR:JWT_VERIFICATION_FILED', reason: 'JWT_VERIFICATION_FILED', message: cause.message });
            ack(callback, 'ERROR:JWT_VERIFICATION_FILED');
        } finally {
            socket.data.handshakeInProgress = false;
        }
    };

    socket.removeAllListeners('STREAM:CREATE');
    socket.on('STREAM:CREATE', createStream);

    const removeStream = async (...args) => {
        const event = '[STREAM:REMOVE]';
        const callback = getNoPayloadAck(args);
        if (!callback) return;

        if (!socket.data.streamId) {
            ack(callback, Status.OK);
            return;
        }

        if (!(await isCurrentHost())) {
            staleOk(callback, event);
            return;
        }

        const streamId = socket.data.streamId;
        const clientSockets = await io.in(streamId).fetchSockets();
        clientSockets.forEach(clientSocket => {
            if (clientSocket.id === socket.id) return;
            clientSocket.emit('REMOVE:STREAM');
            leaveJoinedRooms(clientSocket);
            clearClientRelayState(clientSocket);
            installStaleClientAckHandlers(clientSocket);
        });

        leaveJoinedRooms(socket);
        socket.data.streamId = undefined;
        socket.data.pubKey = undefined;
        socket.data.hostCreateAttemptId = undefined;
        socket.data.currentClientSocketIds = undefined;
        socket.data.protocolVersion = undefined;
        socket.data.isStreamRunning = false;

        ['STREAM:REMOVE', 'STREAM:STOP', 'STREAM:START', 'HOST:OFFER', 'HOST:CANDIDATE', 'REMOVE:CLIENT'].forEach(name => socket.removeAllListeners(name));
        ack(callback, Status.OK);
    };

    const startStream = async (payload, callback) => {
        const event = '[STREAM:START]';
        if (!isObject(payload) || !payload.clientId) {
            ack(callback, Status.BAD_DATA);
            return;
        }
        if (!socket.data.streamId) {
            ack(callback, Status.NO_STREAM_ID);
            return;
        }
        if (!(await isCurrentHost())) {
            staleOk(callback, event, { clientId: payload.clientId });
            return;
        }

        socket.data.isStreamRunning = true;
        if (payload.clientId === 'ALL') {
            socket.to(socket.data.streamId).emit('STREAM:START');
            ack(callback, Status.OK);
            return;
        }

        const joinAttemptId = validAttemptId(payload.joinAttemptId);
        if (!joinAttemptId) {
            ack(callback, Status.BAD_DATA);
            return;
        }

        const clientSocket = await getClientSocket(io, socket.data.streamId, payload.clientId, socket.data.currentClientSocketIds?.[payload.clientId]);
        if (!clientSocket) {
            ack(callback, Status.NO_CLIENT);
            return;
        }
        if (clientSocket.data?.joinAttemptId !== joinAttemptId) {
            staleOk(callback, event, { clientId: payload.clientId, joinAttemptId, currentJoinAttemptId: clientSocket.data?.joinAttemptId });
            return;
        }
        clientSocket.emit('STREAM:START');
        ack(callback, Status.OK);
    };

    const stopStream = async (...args) => {
        const event = '[STREAM:STOP]';
        const callback = getNoPayloadAck(args);
        if (!callback) return;
        if (!socket.data.streamId) {
            ack(callback, Status.NO_STREAM_ID);
            return;
        }
        if (!(await isCurrentHost())) {
            staleOk(callback, event);
            return;
        }
        socket.data.isStreamRunning = false;
        socket.to(socket.data.streamId).emit('STREAM:STOP');
        ack(callback, Status.OK);
    };

    const hostOffer = async (payload, callback) => {
        const event = '[HOST:OFFER]';
        const joinAttemptId = validAttemptId(payload?.joinAttemptId);
        const negotiationAttemptId = validAttemptId(payload?.negotiationAttemptId);
        if (!isObject(payload) || !payload.clientId || !payload.offer || !joinAttemptId || !negotiationAttemptId) {
            ack(callback, Status.BAD_DATA);
            return;
        }

        const relay = await resolveClientRelay(event, payload, callback);
        if (!relay) return;

        relayToClient(event, relay, 'HOST:OFFER', { offer: payload.offer, negotiationAttemptId }, callback);
    };

    const hostCandidate = async (payload, callback) => {
        const event = '[HOST:CANDIDATE]';
        const joinAttemptId = validAttemptId(payload?.joinAttemptId);
        const negotiationAttemptId = validAttemptId(payload?.negotiationAttemptId);
        const hasCandidate = isObject(payload) && (Array.isArray(payload.candidates) || Object.prototype.hasOwnProperty.call(payload, 'candidate'));
        if (!hasCandidate || !payload.clientId || !joinAttemptId || !negotiationAttemptId) {
            ack(callback, Status.BAD_DATA);
            return;
        }

        const queueKey = `${event}:${payload.clientId}:${joinAttemptId}:${negotiationAttemptId}`;
        return enqueueSocketTask(socket, queueKey, async () => {
            const relay = await resolveClientRelay(event, payload, callback);
            if (!relay) return;

            relayToClient(event, relay, 'HOST:CANDIDATE', {
                candidates: Array.isArray(payload.candidates) ? payload.candidates : [payload.candidate],
                negotiationAttemptId
            }, callback);
        });
    };

    const removeClient = async (payload, callback) => {
        const event = '[REMOVE:CLIENT]';
        if (!isObject(payload) || !Array.isArray(payload.clientId)) {
            ack(callback, Status.BAD_DATA);
            return;
        }
        if (!socket.data.streamId) {
            ack(callback, Status.NO_STREAM_ID);
            return;
        }
        if (!(await isCurrentHost())) {
            staleOk(callback, event);
            return;
        }

        const clientSockets = (await io.in(socket.data.streamId).fetchSockets())
            .filter(item => item.data?.isClient === true && payload.clientId.includes(item.data.clientId));

        clientSockets.forEach(clientSocket => {
            leaveJoinedRooms(clientSocket);
            clearClientRelayState(clientSocket);
            installStaleClientAckHandlers(clientSocket);
            delete socket.data.currentClientSocketIds?.[clientSocket.data.clientId];
            clientSocket.timeout(SOCKET_TIMEOUT).emit('REMOVE:CLIENT', () => { });
        });

        ack(callback, Status.OK);
    };
}
