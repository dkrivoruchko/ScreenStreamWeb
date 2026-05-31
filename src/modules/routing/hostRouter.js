import logger from '../../logger.js';
import socketHandlerHost from '../socketHandlerHost.js';
import androidHost from '../signalingV2/androidHost.js';
import { PROTOCOL_VERSION } from '../signalingV2/common.js';
import installAndDispatch from './installAndDispatch.js';

export default function (io, socket) {
    const event = 'STREAM:CREATE';

    const routeCreate = async (payload, callback) => {
        const hasProtocolVersion = payload && Object.prototype.hasOwnProperty.call(payload, 'protocolVersion');
        if (hasProtocolVersion && payload.protocolVersion !== PROTOCOL_VERSION) {
            logger.warn({ socket_event: `[${event}:route]`, socket: socket.id, protocol_version: payload.protocolVersion, reason: 'BAD_PROTOCOL_VERSION' });
            callback?.({ status: 'ERROR:BAD_PROTOCOL_VERSION' });
            return;
        }

        const protocolVersion = hasProtocolVersion ? PROTOCOL_VERSION : 1;
        const useV2 = protocolVersion === PROTOCOL_VERSION;
        logger.debug({ socket_event: `[${event}:route]`, socket: socket.id, protocol_version: protocolVersion, handler: useV2 ? 'signalingV2/androidHost' : 'socketHandlerHost', });

        try {
            await installAndDispatch(io, socket, event, useV2 ? androidHost : socketHandlerHost, payload, callback);
        } finally {
            socket.removeAllListeners(event);
            socket.on(event, routeCreate);
        }
    };

    socket.removeAllListeners(event);
    socket.on(event, routeCreate);
}
