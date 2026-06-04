import logger, { redactLogPayload } from '../../logger.js';
import { randomUUID } from 'node:crypto';
import { getIceServers } from '../iceServers.js';
import { ack, isObject, PROTOCOL_VERSION, validAttemptId } from './common.js';
import {
    clearClientRelayState,
    disconnectOlderClientSockets,
    enqueueSocketTask,
    getHostSocket,
    getNoPayloadAck,
    getStreamId,
    installStaleClientAckHandlers,
    isEndOfCandidates,
    isStreamIdValid,
    leaveJoinedRooms
} from '../stream.js';

const SOCKET_TIMEOUT = 5000;

const Status = {
    OK: 'OK',
    BAD_DATA: 'ERROR:EMPTY_OR_BAD_DATA',
    NO_STREAM_JOINED: 'ERROR:NO_STREAM_JOINED',
    NO_HOST: 'ERROR:NO_STREAM_HOST_FOUND',
    TIMEOUT: 'ERROR:TIMEOUT_OR_NO_RESPONSE',
};
const USER_CORRECTABLE_JOIN_ACKS = new Set([Status.NO_HOST, 'ERROR:WRONG_STREAM_PASSWORD']);

async function currentHostForContext(io, context) {
    const hostSocket = context?.streamId ? await getHostSocket(io, context.streamId) : null;
    return hostSocket?.connected === true &&
        hostSocket.id === context?.hostSocketId &&
        hostSocket.data?.streamId === context?.streamId &&
        hostSocket.data?.hostCreateAttemptId === context?.hostCreateAttemptId &&
        hostSocket.data?.protocolVersion === PROTOCOL_VERSION ? hostSocket : null;
}

function staleOk(callback, event, socket, streamId, extra = {}) {
    logger.debug({ socket_event: event, socket: socket.id, streamId, classification: 'stale_attempt_ignored', message: 'Ignoring stale v2 signaling.', ...extra });
    ack(callback, Status.OK);
}

export default function (io, socket) {

    async function resolveJoinedRelay(event, payload, callback) {
        const streamId = getStreamId(socket);
        if (!streamId) {
            logger.warn({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined.' });
            ack(callback, Status.NO_STREAM_JOINED);
            return null;
        }

        const negotiationAttemptId = validAttemptId(payload?.negotiationAttemptId);
        if (!negotiationAttemptId) {
            logger.warn({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, reason: 'BAD_NEGOTIATION_ATTEMPT_ID' });
            ack(callback, Status.BAD_DATA);
            return null;
        }

        const context = socket.data?.relayHostContext;
        const hostSocket = await currentHostForContext(io, context);
        if (!hostSocket) {
            staleOk(callback, event, socket, streamId, { clientId: socket.data.clientId, negotiationAttemptId });
            return null;
        }

        if (hostSocket.data?.currentClientSocketIds?.[socket.data.clientId] !== socket.id) {
            staleOk(callback, event, socket, streamId, { clientId: socket.data.clientId, negotiationAttemptId });
            return null;
        }

        return { streamId, hostSocket, negotiationAttemptId };
    }

    function relayToHost(event, relay, targetEvent, payload, callback) {
        relay.hostSocket.timeout(SOCKET_TIMEOUT).emit(targetEvent, payload, async (err, response) => {
            if (!socket.connected) return;
            if (!(await currentHostForContext(io, socket.data?.relayHostContext))) {
                staleOk(callback, event, socket, relay.streamId, { clientId: socket.data.clientId, negotiationAttemptId: relay.negotiationAttemptId });
                return;
            }

            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: socket.data.clientId, negotiationAttemptId: relay.negotiationAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: Status.TIMEOUT });
                ack(callback, Status.TIMEOUT);
                return;
            }

            const ackStatus = response?.status || Status.BAD_DATA;
            if (ackStatus !== Status.OK) logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: socket.data.clientId, negotiationAttemptId: relay.negotiationAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: ackStatus });
            ack(callback, ackStatus);
        });
    }

    const streamJoin = async (payload, callback) => {
        const event = '[STREAM:JOIN]';
        const logJoin = (level, result, ackStatus, extra = {}) => logger[level]({ event_name: 'stream_join_outcome', socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload?.streamId, protocol_version: PROTOCOL_VERSION, result, ack_status: ackStatus, ...extra });

        logger.debug({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload?.streamId, protocol_version: PROTOCOL_VERSION, payload: redactLogPayload(payload), message: 'New v2 stream join request' });

        if (!isObject(payload) || isStreamIdValid(payload.streamId) !== true || !payload.passwordHash) {
            socket.data.errorCounter += 1;
            logJoin('warn', 'error', Status.BAD_DATA);
            ack(callback, Status.BAD_DATA);
            return;
        }

        const joinedStreamId = getStreamId(socket);
        if (joinedStreamId && joinedStreamId !== payload.streamId) {
            socket.data.errorCounter += 1;
            logJoin('warn', 'error', 'ERROR:STREAM_ID_ALREADY_SET');
            ack(callback, 'ERROR:STREAM_ID_ALREADY_SET');
            return;
        }

        const hostSocket = await getHostSocket(io, payload.streamId);
        if (!hostSocket?.connected || hostSocket.data?.protocolVersion !== PROTOCOL_VERSION) {
            socket.data.errorCounter += 1;
            logJoin('info', 'user_error', Status.NO_HOST);
            ack(callback, Status.NO_HOST);
            return;
        }

        const context = { streamId: payload.streamId, hostSocketId: hostSocket.id, hostCreateAttemptId: hostSocket.data?.hostCreateAttemptId, protocolVersion: PROTOCOL_VERSION, };
        const liveHostSocket = io.sockets.sockets.get(hostSocket.id);
        const hostData = liveHostSocket?.data ?? hostSocket.data;
        hostData.currentClientSocketIds ??= {};

        const iceServers = getIceServers(socket.data.clientId);
        const joinAttemptId = randomUUID();
        socket.data.pendingJoinAttemptId = joinAttemptId;
        await disconnectOlderClientSockets(io, payload.streamId, socket.data.clientId, socket.id, logger, event, { host_socket: hostSocket.id });

        const joinPayload = { clientId: socket.data.clientId, passwordHash: payload.passwordHash, iceServers, protocolVersion: PROTOCOL_VERSION, joinAttemptId, };

        hostSocket.timeout(SOCKET_TIMEOUT).emit('STREAM:JOIN', joinPayload, async (err, response) => {
            if (!socket.connected) return;
            if (socket.data.pendingJoinAttemptId !== joinAttemptId) {
                staleOk(callback, event, socket, payload.streamId, { clientId: socket.data.clientId, joinAttemptId });
                return;
            }
            if (!(await currentHostForContext(io, context))) {
                socket.data.pendingJoinAttemptId = undefined;
                logJoin('warn', 'error', 'ERROR:HOST_SOCKET_DISCONNECTED', { joinAttemptId });
                ack(callback, 'ERROR:HOST_SOCKET_DISCONNECTED');
                return;
            }

            if (err) {
                socket.data.pendingJoinAttemptId = undefined;
                logJoin('warn', 'error', Status.TIMEOUT, { joinAttemptId });
                ack(callback, Status.TIMEOUT);
                return;
            }

            if (response?.status !== Status.OK) {
                socket.data.pendingJoinAttemptId = undefined;
                socket.data.errorCounter += 1;
                const ackStatus = response?.status || Status.BAD_DATA;
                logJoin(USER_CORRECTABLE_JOIN_ACKS.has(ackStatus) ? 'info' : 'warn', USER_CORRECTABLE_JOIN_ACKS.has(ackStatus) ? 'user_error' : 'error', ackStatus, { joinAttemptId });
                ack(callback, ackStatus);
                return;
            }

            socket.data.pendingJoinAttemptId = undefined;
            socket.data.protocolVersion = PROTOCOL_VERSION;
            socket.data.relayHostContext = context;
            socket.data.joinAttemptId = joinAttemptId;
            hostData.currentClientSocketIds[socket.data.clientId] = socket.id;
            socket.join(payload.streamId);

            logJoin('info', 'ok', Status.OK, { joinAttemptId });
            ack(callback, Status.OK, { iceServers, protocolVersion: PROTOCOL_VERSION });
        });
    };

    socket.removeAllListeners('STREAM:JOIN');
    socket.on('STREAM:JOIN', streamJoin);

    const clientAnswer = async (payload, callback) => {
        const event = '[CLIENT:ANSWER]';
        if (!isObject(payload) || !payload.answer) {
            socket.data.errorCounter += 1;
            ack(callback, Status.BAD_DATA);
            return;
        }

        const relay = await resolveJoinedRelay(event, payload, callback);
        if (!relay) return;

        relayToHost(event, relay, 'CLIENT:ANSWER', { clientId: socket.data.clientId, answer: payload.answer, negotiationAttemptId: relay.negotiationAttemptId, }, callback);
    };

    const clientCandidate = async (payload, callback) => {
        const event = '[CLIENT:CANDIDATE]';
        if (!isObject(payload) || !Object.prototype.hasOwnProperty.call(payload, 'candidate')) {
            socket.data.errorCounter += 1;
            ack(callback, Status.BAD_DATA);
            return;
        }

        const queueKey = `${event}:${socket.data.clientId}:${payload.negotiationAttemptId}`;
        return enqueueSocketTask(socket, queueKey, async () => {
            const relay = await resolveJoinedRelay(event, payload, callback);
            if (!relay) return;

            if (isEndOfCandidates(payload.candidate)) {
                ack(callback, Status.OK);
                return;
            }

            relayToHost(event, relay, 'CLIENT:CANDIDATE', { clientId: socket.data.clientId, candidate: payload.candidate, negotiationAttemptId: relay.negotiationAttemptId, }, callback);
        });
    };

    const streamLeave = async (...args) => {
        const event = '[STREAM:LEAVE]';
        const callback = getNoPayloadAck(args);
        if (!callback) return;

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.removeAllListeners('CLIENT:CANDIDATE');
        socket.removeAllListeners('STREAM:LEAVE');
        installStaleClientAckHandlers(socket);

        const streamId = getStreamId(socket);
        const context = socket.data?.relayHostContext;
        const clientId = socket.data.clientId;
        const joinAttemptId = socket.data.joinAttemptId;

        if (!streamId) {
            ack(callback, Status.OK);
            return;
        }

        leaveJoinedRooms(socket);
        clearClientRelayState(socket);

        const hostSocket = await currentHostForContext(io, context);
        if (!hostSocket) {
            staleOk(callback, event, socket, streamId, { clientId, joinAttemptId });
            return;
        }

        if (hostSocket.data?.currentClientSocketIds?.[clientId] !== socket.id) {
            staleOk(callback, event, socket, streamId, { clientId, joinAttemptId });
            return;
        }

        const liveHostSocket = io.sockets.sockets.get(hostSocket.id);
        const hostData = liveHostSocket?.data ?? hostSocket.data;
        delete hostData.currentClientSocketIds?.[clientId];

        hostSocket.timeout(SOCKET_TIMEOUT).emit('STREAM:LEAVE', { clientId, joinAttemptId }, (err, response) => {
            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: Status.TIMEOUT });
                ack(callback, Status.TIMEOUT);
                return;
            }
            const ackStatus = response?.status || Status.BAD_DATA;
            if (ackStatus !== Status.OK) logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: PROTOCOL_VERSION, result: 'error', ack_status: ackStatus });
            ack(callback, ackStatus);
        });
    };

    socket.removeAllListeners('CLIENT:ANSWER');
    socket.on('CLIENT:ANSWER', clientAnswer);
    socket.removeAllListeners('CLIENT:CANDIDATE');
    socket.on('CLIENT:CANDIDATE', clientCandidate);
    socket.removeAllListeners('STREAM:LEAVE');
    socket.on('STREAM:LEAVE', streamLeave);
}
