import logger, { redactLogPayload } from '../../logger.js';
import { randomUUID } from 'node:crypto';
import { getIceServers } from '../iceServers.js';
import { ack, PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from '../signalingV2/common.js';
import { clearClientRelayState, disconnectOlderClientSockets, enqueueSocketTask, getHostSocket, getNoPayloadAck, getStreamId, installStaleClientAckHandlers, isEndOfCandidates, isStreamIdValid, leaveJoinedRooms } from '../stream.js';

const SOCKET_TIMEOUT = 5000;

const Status = {
    OK: 'OK',
    BAD_DATA: 'ERROR:EMPTY_OR_BAD_DATA',
    NO_STREAM_JOINED: 'ERROR:NO_STREAM_JOINED',
    NO_HOST: 'ERROR:NO_STREAM_HOST_FOUND',
    HOST_DISCONNECTED: 'ERROR:HOST_SOCKET_DISCONNECTED',
    TIMEOUT: 'ERROR:TIMEOUT_OR_NO_RESPONSE',
};
const USER_CORRECTABLE_JOIN_ACKS = new Set([Status.NO_HOST, 'ERROR:WRONG_STREAM_PASSWORD']);

function relayContext(hostSocket, streamId) {
    return { streamId, hostSocketId: hostSocket.id, protocolVersion: hostSocket.data?.protocolVersion };
}

function isLegacyHost(hostSocket) {
    return hostSocket?.connected === true && hostSocket.data?.protocolVersion !== V2_PROTOCOL_VERSION;
}

function matchesRelayContext(hostSocket, context) {
    return isLegacyHost(hostSocket) && hostSocket.id === context?.hostSocketId && hostSocket.data?.streamId === context?.streamId;
}

async function currentHostForContext(io, context) {
    const hostSocket = context?.streamId ? await getHostSocket(io, context.streamId) : null;
    return matchesRelayContext(hostSocket, context) ? hostSocket : null;
}

function staleOk(callback, event, socket, streamId, extra = {}) {
    logger.debug({ socket_event: event, socket: socket.id, streamId, classification: 'stale_attempt_ignored', message: 'Ignoring stale legacy bridge signaling.', ...extra });
    ack(callback, Status.OK);
}

export default function (io, socket) {

    async function resolveRelay(event, callback) {
        const streamId = getStreamId(socket);
        if (!streamId) {
            ack(callback, Status.NO_STREAM_JOINED);
            return null;
        }

        const hostSocket = await currentHostForContext(io, socket.data?.relayHostContext);
        if (!hostSocket) {
            staleOk(callback, event, socket, streamId, { clientId: socket.data.clientId });
            return null;
        }

        if (hostSocket.data?.currentClientSocketIds?.[socket.data.clientId] !== socket.id) {
            staleOk(callback, event, socket, streamId, { clientId: socket.data.clientId });
            return null;
        }

        return { streamId, hostSocket };
    }

    function relayToHost(event, relay, targetEvent, payload, callback) {
        relay.hostSocket.timeout(SOCKET_TIMEOUT).emit(targetEvent, payload, async (err, response) => {
            if (!socket.connected) return;
            if (!(await currentHostForContext(io, socket.data?.relayHostContext))) {
                staleOk(callback, event, socket, relay.streamId, { clientId: socket.data.clientId });
                return;
            }
            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: socket.data.clientId, protocol_version: 1, result: 'error', ack_status: Status.TIMEOUT });
                ack(callback, Status.TIMEOUT);
                return;
            }
            const ackStatus = response?.status || Status.BAD_DATA;
            if (ackStatus !== Status.OK) logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId: relay.streamId, clientId: socket.data.clientId, protocol_version: 1, result: 'error', ack_status: ackStatus });
            ack(callback, ackStatus);
        });
    }

    const streamJoin = async (payload, callback) => {
        const event = '[STREAM:JOIN]';
        const logJoin = (level, result, ackStatus, extra = {}) => logger[level]({ event_name: 'stream_join_outcome', socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload?.streamId, protocol_version: 1, result, ack_status: ackStatus, ...extra });
        logger.debug({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload?.streamId, payload: redactLogPayload(payload), message: 'New v2 web join for legacy host' });

        if (!payload || isStreamIdValid(payload.streamId) !== true || !payload.passwordHash) {
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
        if (!isLegacyHost(hostSocket)) {
            socket.data.errorCounter += 1;
            logJoin('info', 'user_error', Status.NO_HOST);
            ack(callback, hostSocket ? Status.NO_HOST : Status.NO_HOST);
            return;
        }

        const context = relayContext(hostSocket, payload.streamId);
        const liveHostSocket = io.sockets.sockets.get(hostSocket.id);
        const hostData = liveHostSocket?.data ?? hostSocket.data;
        hostData.currentClientSocketIds ??= {};

        const iceServers = getIceServers(socket.data.clientId);
        const joinRequestId = randomUUID();
        socket.data.pendingJoinAttemptId = joinRequestId;
        await disconnectOlderClientSockets(io, payload.streamId, socket.data.clientId, socket.id, logger, event, { host_socket: hostSocket.id });
        socket.data.protocolVersion = 1;
        socket.data.relayHostContext = context;
        hostData.currentClientSocketIds[socket.data.clientId] = socket.id;
        socket.join(payload.streamId);
        const clearAcceptedJoin = () => {
            if (hostData.currentClientSocketIds?.[socket.data.clientId] === socket.id) delete hostData.currentClientSocketIds[socket.data.clientId];
            leaveJoinedRooms(socket);
            clearClientRelayState(socket);
        };

        hostSocket.timeout(SOCKET_TIMEOUT).emit('STREAM:JOIN', { clientId: socket.data.clientId, passwordHash: payload.passwordHash, iceServers }, async (err, response) => {
            if (!socket.connected) {
                clearAcceptedJoin();
                return;
            }
            if (socket.data.pendingJoinAttemptId !== joinRequestId) {
                staleOk(callback, event, socket, payload.streamId, { clientId: socket.data.clientId });
                return;
            }
            if (!(await currentHostForContext(io, context))) {
                socket.data.pendingJoinAttemptId = undefined;
                clearAcceptedJoin();
                logJoin('warn', 'error', Status.HOST_DISCONNECTED);
                ack(callback, Status.HOST_DISCONNECTED);
                return;
            }

            if (err) {
                socket.data.pendingJoinAttemptId = undefined;
                clearAcceptedJoin();
                logJoin('warn', 'error', Status.TIMEOUT);
                ack(callback, Status.TIMEOUT);
                return;
            }

            if (response?.status !== Status.OK) {
                socket.data.pendingJoinAttemptId = undefined;
                clearAcceptedJoin();
                socket.data.errorCounter += 1;
                const ackStatus = response?.status || Status.BAD_DATA;
                logJoin(USER_CORRECTABLE_JOIN_ACKS.has(ackStatus) ? 'info' : 'warn', USER_CORRECTABLE_JOIN_ACKS.has(ackStatus) ? 'user_error' : 'error', ackStatus);
                ack(callback, ackStatus);
                return;
            }

            socket.data.pendingJoinAttemptId = undefined;
            logJoin('info', 'ok', Status.OK);
            ack(callback, Status.OK, { iceServers, protocolVersion: 1 });
        });
    };

    socket.removeAllListeners('STREAM:JOIN');
    socket.on('STREAM:JOIN', streamJoin);

    const clientAnswer = async (payload, callback) => {
        const event = '[CLIENT:ANSWER]';
        if (!payload || !payload.answer) {
            socket.data.errorCounter += 1;
            ack(callback, Status.BAD_DATA);
            return;
        }

        const relay = await resolveRelay(event, callback);
        if (!relay) return;
        relayToHost(event, relay, 'CLIENT:ANSWER', { clientId: socket.data.clientId, answer: payload.answer }, callback);
    };

    const clientCandidate = async (payload, callback) => {
        const event = '[CLIENT:CANDIDATE]';
        const hasCandidate = payload && Object.prototype.hasOwnProperty.call(payload, 'candidate');
        if (!hasCandidate) {
            socket.data.errorCounter += 1;
            ack(callback, Status.BAD_DATA);
            return;
        }

        if (isEndOfCandidates(payload.candidate)) {
            ack(callback, Status.OK);
            return;
        }

        const queueKey = `${event}:${socket.data.clientId}:${getStreamId(socket) || socket.data?.relayHostContext?.streamId || ''}`;
        return enqueueSocketTask(socket, queueKey, async () => {
            const relay = await resolveRelay(event, callback);
            if (!relay) return;
            relayToHost(event, relay, 'CLIENT:CANDIDATE', { clientId: socket.data.clientId, candidate: payload.candidate }, callback);
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

        if (!streamId) {
            ack(callback, Status.OK);
            return;
        }

        leaveJoinedRooms(socket);
        clearClientRelayState(socket);

        const hostSocket = await currentHostForContext(io, context);
        if (!hostSocket) {
            staleOk(callback, event, socket, streamId, { clientId });
            return;
        }

        if (hostSocket.data?.currentClientSocketIds?.[clientId] !== socket.id) {
            staleOk(callback, event, socket, streamId, { clientId });
            return;
        }

        const liveHostSocket = io.sockets.sockets.get(hostSocket.id);
        const hostData = liveHostSocket?.data ?? hostSocket.data;
        delete hostData.currentClientSocketIds?.[clientId];

        hostSocket.timeout(SOCKET_TIMEOUT).emit('STREAM:LEAVE', { clientId }, (err, response) => {
            if (err) {
                logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId, protocol_version: 1, result: 'error', ack_status: Status.TIMEOUT });
                ack(callback, Status.TIMEOUT);
                return;
            }
            const ackStatus = response?.status || Status.BAD_DATA;
            if (ackStatus !== Status.OK) logger.warn({ event_name: 'webrtc_relay_failure', socket_event: event, socket: socket.id, streamId, clientId, protocol_version: 1, result: 'error', ack_status: ackStatus });
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
