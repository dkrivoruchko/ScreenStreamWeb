import logger from '../logger.js';
import { getIceServers } from './iceServers.js';
import { isStreamIdValid, getStreamId, getHostSocket } from './stream.js';

export default function (io, socket) {

    // [STREAM:JOIN] ========================================================================================================

    const streamJoin = async (payload, callback) => {
        const event = '[STREAM:JOIN]';

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload.streamId, payload, message: 'New stream join request' }));

        if (!payload || isStreamIdValid(payload.streamId) !== true || !payload.passwordHash) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, error: 'EMPTY_OR_BAD_DATA', message: 'Bad stream join request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const streamId = getStreamId(socket)
        if (streamId && streamId != payload.streamId) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, error: 'STREAM_ID_ALREADY_SET', message: `Stream id set to: ${streamId}` }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:STREAM_ID_ALREADY_SET' });
            return;
        }

        const hostSocket = await getHostSocket(io, payload.streamId);

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        // Disconnect all other sockets for this clientId
        const allSockets = await io.fetchSockets();
        allSockets
            .filter(item => item.id !== socket.id && item.data && item.data.isClient === true && item.data.clientId === socket.data.clientId)
            .forEach(oldClientSocket => {
                if (oldClientSocket.connected) {
                    logger.debug(JSON.stringify({ socket_event: event, socket: oldClientSocket.id, streamId: payload.streamId, clientId: oldClientSocket.data.clientId, host_socket: hostSocket.id, message: 'Got new client. Disconnecting old socket' }));
                    oldClientSocket.rooms.forEach(room => { if (room != oldClientSocket.id) oldClientSocket.leave(room); });
                    oldClientSocket.disconnect()
                }
            });

        logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Got new client. Sending to host' }));

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.on('CLIENT:ANSWER', clientAnswer);

        socket.removeAllListeners('CLIENT:CANDIDATE');
        socket.on('CLIENT:CANDIDATE', clientCandidate);

        socket.removeAllListeners('STREAM:LEAVE');
        socket.on('STREAM:LEAVE', streamLeave);

        const iceServers = getIceServers(socket.data.clientId);

        hostSocket.emit('STREAM:JOIN', { clientId: socket.data.clientId, passwordHash: payload.passwordHash, iceServers }, response => {
            if (!socket.connected) {
                logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, host_socket: hostSocket.id, message: 'STREAM:JOIN: Client socket disconnected. Ignoring' }));
                return;
            }

            logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `STREAM:JOIN Host response: ${response.status}` }));

            if (response.status !== 'OK') { // ERROR:EMPTY_OR_BAD_DATA, ERROR:WRONG_STREAM_PASSWORD
                logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: `Host error for STREAM:JOIN => ${response.status}` }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK', iceServers });

                socket.join(payload.streamId);
            }
        });
    }

    socket.removeAllListeners('STREAM:JOIN');
    socket.on('STREAM:JOIN', streamJoin);

    // [CLIENT:ANSWER] ========================================================================================================

    const clientAnswer = async (payload, callback) => {
        const event = '[CLIENT:ANSWER]';

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        const streamId = getStreamId(socket)
        if (!streamId) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        if (!payload || !payload.answer) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId: streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client answer request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId: streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:ANSWER', { clientId: socket.data.clientId, answer: payload.answer }, response => {
            if (!socket.connected) {
                logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, host_socket: hostSocket.id, message: 'CLIENT:ANSWER: Client socket disconnected. Ignoring' }));
                return;
            }

            logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:ANSWER Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: `Host error for CLIENT:ANSWER => ${response.status}` }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }

    // [CLIENT:CANDIDATE] ========================================================================================================

    const clientCandidate = async (payload, callback) => {
        const event = '[CLIENT:CANDIDATE]';

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        const streamId = getStreamId(socket)
        if (!streamId) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        if (!payload || !payload.candidate) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client candidate request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:CANDIDATE', { clientId: socket.data.clientId, candidate: payload.candidate }, response => {
            if (!socket.connected) {
                logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, host_socket: hostSocket.id, message: 'CLIENT:CANDIDATE: Client socket disconnected. Ignoring' }));
                return;
            }

            logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:CANDIDATE Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: `Host error for CLIENT:CANDIDATE => ${response.status}` }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }

    // [STREAM:LEAVE] ========================================================================================================

    const streamLeave = async (callback) => {
        const event = '[STREAM:LEAVE]';

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.removeAllListeners('CLIENT:CANDIDATE');
        socket.removeAllListeners('STREAM:LEAVE');

        const socketId = socket.id;
        const clientId = socket.data.clientId;

        const streamId = getStreamId(socket)
        if (!streamId) {
            logger.debug(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        socket.leave(streamId);

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            logger.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        logger.debug(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('STREAM:LEAVE', { clientId }, response => {
            if (!socket.connected) {
                logger.debug(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, message: 'STREAM:LEAVE: Client socket disconnected. Ignoring' }));
                return;
            }

            logger.debug(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, message: `STREAM:LEAVE Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                logger.warn(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, error: response.status, message: `Host error for STREAM:LEAVE => ${response.status}` }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }
}