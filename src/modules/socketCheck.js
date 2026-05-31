import logger from '../logger.js';

const validClientEvents = ['STREAM:JOIN', 'CLIENT:ANSWER', 'CLIENT:CANDIDATE', 'STREAM:LEAVE'];
const validHostEvents = ['STREAM:CREATE', 'STREAM:REMOVE', 'STREAM:START', 'HOST:OFFER', 'HOST:CANDIDATE', 'STREAM:STOP', 'REMOVE:CLIENT'];

const MAX_ERRORS_PER_SOCKET = 10;
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

export default function (socket) {
    const rejectSocket = async (event, cause) => {
        try {
            await socket.timeout(3000).emitWithAck('SOCKET:ERROR', { status: `SOCKET_CHECK_ERROR:${cause.message}` });
        } catch (err) {
        }
        socket.disconnect(true);
    };

    socket.use((packet, next) => {
        const [event, ...args] = packet;
        try {
            const payloadSize = JSON.stringify(args).length;
            if (payloadSize > MAX_PAYLOAD_SIZE) {
                logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'PAYLOAD_TOO_LARGE', size: payloadSize });
                throw new Error('PAYLOAD_TOO_LARGE');
            }

            if (!socket.data || (socket.data.isClient !== true && socket.data.isHost !== true)) {
                logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'UNVERIFIED_SOCKET' });
                throw new Error('UNVERIFIED_SOCKET');
            }

            if (socket.data.isClient === true && socket.data.isHost === true) {
                logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'INVALID_SOCKET_STATE' });
                throw new Error('INVALID_SOCKET_STATE');
            }

            if (socket.data.isClient === true) {
                if (!socket.data.clientId || typeof socket.data.clientId !== 'string' || socket.data.clientId.length === 0) {
                    logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'NO_CLIENT_ID' });
                    throw new Error('NO_CLIENT_ID');
                }

                if (!validClientEvents.includes(event)) {
                    logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'UNKNOWN_CLIENT_EVENT' });
                    throw new Error('UNKNOWN_CLIENT_EVENT');
                }

                if (socket.data.errorCounter >= MAX_ERRORS_PER_SOCKET) {
                    logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'ERROR_LIMIT_REACHED' });
                    throw new Error('ERROR_LIMIT_REACHED');
                }
            }

            if (socket.data.isHost === true && !validHostEvents.includes(event)) {
                logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'UNKNOWN_HOST_EVENT' });
                throw new Error('UNKNOWN_HOST_EVENT');
            }

            if (typeof args.at(-1) !== 'function') {
                logger.warn({ socket_event: `[${event}]`, socket: socket.id, reason: 'ACK_CALLBACK_REQUIRED' });
                throw new Error('ACK_CALLBACK_REQUIRED');
            }

            next();
        } catch (cause) {
            rejectSocket(event, cause);
            next(cause);
        }
    });
}
