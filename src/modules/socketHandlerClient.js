import { isStreamIdValid, getStreamId, getHostSocket } from './stream.js';

export default function (io, socket) {

    // [STREAM:JOIN] ========================================================================================================

    const streamJoin = async (payload, callback) => {
        const event = '[STREAM:JOIN]';

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, payload, message: 'New stream join request' }));

        if (!payload || isStreamIdValid(payload.streamId) !== true || !payload.passwordHash) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'EMPTY_OR_BAD_DATA', message: 'Bad stream join request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const streamId = getStreamId(socket)
        if (streamId && streamId != payload.streamId) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: payload.streamId, clientId: socket.data.clientId, error: 'STREAM_ID_ALREADY_SET', message: `Stream id set to: ${streamId}` }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:STREAM_ID_ALREADY_SET' });
            return;
        }

        const hostSocket = await getHostSocket(io, payload.streamId);

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: payload.streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Got new client. Sending to host' }));

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.on('CLIENT:ANSWER', clientAnswer);

        socket.removeAllListeners('CLIENT:CANDIDATES');
        socket.on('CLIENT:CANDIDATES', clientCandidates);

        socket.removeAllListeners('STREAM:LEAVE');
        socket.on('STREAM:LEAVE', streamLeave);

        hostSocket.emit('STREAM:JOIN', { clientId: socket.data.clientId, passwordHash: payload.passwordHash }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `STREAM:JOIN Host response: ${response.status}` }));

            if (response.status !== 'OK') { // ERROR:EMPTY_OR_BAD_DATA, ERROR:WRONG_STREAM_PASSWORD
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for STREAM:JOIN' }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });

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
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        const streamId = getStreamId(socket)
        if (!streamId) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        if (!payload || !payload.answer) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client answer request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:ANSWER', { clientId: socket.data.clientId, answer: payload.answer }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:ANSWER Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for CLIENT:ANSWER' }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }

    // [CLIENT:CANDIDATES] ========================================================================================================

    const clientCandidates = async (payload, callback) => {
        const event = '[CLIENT:CANDIDATES]';

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        const streamId = getStreamId(socket)
        if (!streamId) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        if (!payload || !payload.candidates || !Array.isArray(payload.candidates)) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client candidates request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:CANDIDATES', { clientId: socket.data.clientId, candidates: payload.candidates }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:CANDIDATES Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, stream_id: streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for CLIENT:CANDIDATES' }));

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
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.removeAllListeners('CLIENT:CANDIDATES');
        socket.removeAllListeners('STREAM:LEAVE');

        const socketId = socket.id;
        const clientId = socket.data.clientId;

        const streamId = getStreamId(socket)
        if (!streamId) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        socket.leave(streamId);

        const hostSocket = await getHostSocket(io, streamId);

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring...' }));
            return;
        }

        if (!hostSocket) {
            console.error(JSON.stringify({ socket_event: event, socket: socketId, stream_id: streamId, clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socketId, stream_id: streamId, clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('STREAM:LEAVE', { clientId }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socketId, stream_id: streamId, clientId, host_socket: hostSocket.id, message: `STREAM:LEAVE Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socketId, stream_id: streamId, clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for STREAM:LEAVE' }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }
}