import logger from '../../logger.js';

export default async function installAndDispatch(io, socket, event, handler, payload, callback) {
    let callbackCalled = false;
    const trackedCallback = (...args) => {
        callbackCalled = true;
        callback?.(...args);
    };

    try {
        socket.removeAllListeners(event);
        handler(io, socket);

        const listener = socket.listeners(event).at(-1);
        if (!listener) {
            logger.error({ socket_event: event, socket: socket.id, reason: 'HANDLER_NOT_INSTALLED' });
            trackedCallback({ status: 'ERROR:HANDLER_NOT_INSTALLED' });
            return;
        }

        return await listener(payload, trackedCallback);
    } catch (cause) {
        logger.error({ socket_event: event, socket: socket.id, reason: 'ROUTED_HANDLER_FAILED', message: cause?.message });
        if (!callbackCalled) trackedCallback({ status: 'ERROR:ROUTED_HANDLER_FAILED' });
    }
}
