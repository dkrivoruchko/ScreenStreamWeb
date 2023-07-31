import { isStreamIdValid, getStreamId, getHostSocket } from './stream.js';

export default function (io, socket) {

    // [STREAM:JOIN] ========================================================================================================

    const streamJoin = async (payload, callback) => {
        const event = '[STREAM:JOIN]';

        if (!socket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, streamId: payload.streamId, payload, message: 'New stream join request' }));

        if (!payload || isStreamIdValid(payload.streamId) !== true || !payload.passwordHash) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'EMPTY_OR_BAD_DATA', message: 'Bad stream join request' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            return;
        }

        const streamId = getStreamId(socket)
        if (streamId && streamId != payload.streamId) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, error: 'STREAM_ID_ALREADY_SET', message: `Stream id set to: ${streamId}` }));

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
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));

            socket.data.errorCounter += 1;
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Got new client. Sending to host' }));

        socket.removeAllListeners('CLIENT:ANSWER');
        socket.on('CLIENT:ANSWER', clientAnswer);

        socket.removeAllListeners('CLIENT:CANDIDATE');
        socket.on('CLIENT:CANDIDATE', clientCandidate);

        socket.removeAllListeners('STREAM:LEAVE');
        socket.on('STREAM:LEAVE', streamLeave);

        hostSocket.emit('STREAM:JOIN', { clientId: socket.data.clientId, passwordHash: payload.passwordHash }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `STREAM:JOIN Host response: ${response.status}` }));

            if (response.status !== 'OK') { // ERROR:EMPTY_OR_BAD_DATA, ERROR:WRONG_STREAM_PASSWORD
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId: payload.streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for STREAM:JOIN' }));

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
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId: streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client answer request' }));

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
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId: streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:ANSWER', { clientId: socket.data.clientId, answer: payload.answer }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:ANSWER Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for CLIENT:ANSWER' }));

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
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Socket not connected. Ignoring.' }));
            return;
        }

        const streamId = getStreamId(socket)
        if (!streamId) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, clientId: socket.data.clientId, message: 'No stream joined. Ignoring.' }));
            callback({ status: 'ERROR:NO_STREAM_JOINED' });
            return;
        }

        if (!payload || !payload.candidate) {
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId, payload, error: 'EMPTY_OR_BAD_DATA', message: 'Bad client candidate request' }));

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
            console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('CLIENT:CANDIDATE', { clientId: socket.data.clientId, candidate: payload.candidate }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, message: `CLIENT:CANDIDATE Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, streamId, clientId: socket.data.clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for CLIENT:CANDIDATE' }));

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
        socket.removeAllListeners('CLIENT:CANDIDATE');
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
            console.error(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, error: 'NO_STREAM_HOST_FOUND', message: 'No host for stream found' }));
            callback({ status: 'ERROR:NO_STREAM_HOST_FOUND' });
            return;
        }

        if (!hostSocket.connected) {
            console.warn(JSON.stringify({ socket_event: event, socket: socket.id, message: 'Host socket not connected. Ignoring.' }));
            callback({ status: 'ERROR:HOST_SOCKET_DISCONNECTED' });
            return;
        }

        console.debug(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, message: 'Relaying to host' }));

        hostSocket.emit('STREAM:LEAVE', { clientId }, response => {
            console.debug(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, message: `STREAM:LEAVE Host response: ${response.status}` }));

            if (response.status !== 'OK') {
                console.error(JSON.stringify({ socket_event: event, socket: socketId, streamId, clientId, host_socket: hostSocket.id, error: response.status, message: 'Host error for STREAM:LEAVE' }));

                socket.data.errorCounter += 1;
                callback({ status: response.status });
            } else {
                callback({ status: 'OK' });
            }
        });
    }
}