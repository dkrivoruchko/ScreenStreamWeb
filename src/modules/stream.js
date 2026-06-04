const STREAM_ID_LENGTH = 8;
const STREAM_ID_CHARACTERS = '0123456789';
const MAX_ROOM_FETCH_RETRIES = 3;
const STALE_CLIENT_EVENTS = ['CLIENT:ANSWER', 'CLIENT:CANDIDATE', 'STREAM:LEAVE'];
const socketTaskQueues = new WeakMap();

export function createNewStreamId(io) {
    let newId;
    const charactersLength = STREAM_ID_CHARACTERS.length;
    do {
        newId = '';
        for (let i = 0; i < STREAM_ID_LENGTH; i++) {
            newId += STREAM_ID_CHARACTERS.charAt(Math.floor(Math.random() * charactersLength));
        }
    } while (io.sockets.adapter.rooms.has(newId));

    return newId;
}

export function isStreamIdValid(streamId) {
    return typeof streamId === 'string' && /^\d{8}$/.test(streamId);
}

export function isEndOfCandidates(candidate) {
    return candidate === null || candidate === '' || (typeof candidate === 'object' && candidate.candidate === '');
}

export function getStreamId(socket) {
    return Array.from(socket.rooms).find(room => room !== socket.id);
}

export function leaveJoinedRooms(socket) {
    socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
}

export function clearClientRelayState(socket) {
    socket.data.relayHostContext = undefined;
    socket.data.protocolVersion = undefined;
    socket.data.joinAttemptId = undefined;
    socket.data.pendingJoinAttemptId = undefined;
}

export function isClientInStream(socket, streamId, clientId) {
    return socket.data?.isClient === true &&
        socket.data?.clientId === clientId &&
        (socket.data?.relayHostContext?.streamId === streamId || socket.rooms.has(streamId));
}

export async function getHostSocket(io, streamId) {
    let retries = 0;
    while (retries < MAX_ROOM_FETCH_RETRIES) {
        try {
            const socketsInStream = await io.in(streamId).fetchSockets();
            return socketsInStream.find(item => item.data?.isHost === true) ?? null;
        } catch (error) {
            retries++;
            if (retries === MAX_ROOM_FETCH_RETRIES) return null;

            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    return null;
}

export function installStaleClientAckHandlers(socket) {
    STALE_CLIENT_EVENTS.forEach(event => {
        socket.removeAllListeners(event);
        socket.on(event, (...args) => {
            const callback = args.at(-1);
            if (typeof callback === 'function') callback({ status: 'OK' });
        });
    });
}

export function getNoPayloadAck(args) {
    const callback = args.at(-1);
    if (typeof callback !== 'function') return null;
    if (args.length !== 1) {
        callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
        return null;
    }
    return callback;
}

export async function getClientSocket(io, streamId, clientId, preferredSocketId) {
    if (!streamId || !clientId) return null;

    if (preferredSocketId) {
        const preferredSockets = await io.in(preferredSocketId).fetchSockets();
        const preferredSocket = preferredSockets.find(item =>
            item.id === preferredSocketId &&
            item.connected &&
            isClientInStream(item, streamId, clientId)
        );
        if (preferredSocket) return preferredSocket;
    }

    const socketsInStream = await io.in(streamId).fetchSockets();
    return socketsInStream.find(item => item.data?.isClient === true && item.data?.clientId === clientId && item.connected) ?? null;
}

export async function disconnectOlderClientSockets(io, streamId, clientId, keepSocketId, logger, event, extra = {}) {
    const allSockets = await io.fetchSockets();
    allSockets
        .filter(item => item.id !== keepSocketId && item.connected && isClientInStream(item, streamId, clientId))
        .forEach(oldClientSocket => {
            logger.debug({
                socket_event: event,
                socket: oldClientSocket.id,
                streamId,
                clientId,
                message: 'Disconnecting older client socket',
                ...extra
            });
            leaveJoinedRooms(oldClientSocket);
            clearClientRelayState(oldClientSocket);
            installStaleClientAckHandlers(oldClientSocket);
            oldClientSocket.disconnect();
        });
}

export function enqueueSocketTask(socket, key, task) {
    let queues = socketTaskQueues.get(socket);
    if (!queues) {
        queues = new Map();
        socketTaskQueues.set(socket, queues);
    }

    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous
        .catch(() => { })
        .then(task)
        .finally(() => {
            if (queues.get(key) === next) queues.delete(key);
        });

    queues.set(key, next);
    return next;
}

export async function invalidateClientsForRejoin(io, streamId, hostSocketId) {
    const socketsInStream = await io.in(streamId).fetchSockets();
    socketsInStream
        .filter(item => item.id !== hostSocketId && item.data?.isClient === true && item.connected)
        .forEach(clientSocket => {
            clientSocket.emit('STREAM:REJOIN');
            leaveJoinedRooms(clientSocket);
            clearClientRelayState(clientSocket);
            installStaleClientAckHandlers(clientSocket);
        });
}
