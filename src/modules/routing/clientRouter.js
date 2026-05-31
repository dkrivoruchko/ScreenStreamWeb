import logger from '../../logger.js';
import webClientToAndroidV1 from './webClientToAndroidV1Bridge.js';
import webClientToAndroid from '../signalingV2/webClientToAndroid.js';
import { PROTOCOL_VERSION } from '../signalingV2/common.js';
import { getHostSocket, isStreamIdValid } from '../stream.js';
import installAndDispatch from './installAndDispatch.js';

export default function (io, socket) {
    const event = 'STREAM:JOIN';

    const routeJoin = async (payload, callback) => {
        try {
            const hostSocket = payload && isStreamIdValid(payload.streamId) ? await getHostSocket(io, payload.streamId) : null;
            const clientIsV2 = payload?.protocolVersion === PROTOCOL_VERSION;
            const hostIsV2 = hostSocket?.data?.protocolVersion === PROTOCOL_VERSION;

            logger.debug({ socket_event: `[${event}:route]`, socket: socket.id, streamId: payload?.streamId, host_socket: hostSocket?.id, client_protocol_version: clientIsV2 ? PROTOCOL_VERSION : 1, host_protocol_version: hostSocket ? (hostIsV2 ? PROTOCOL_VERSION : 1) : null, handler: hostIsV2 ? 'signalingV2/webClientToAndroid' : 'webClientToAndroidV1Bridge', });

            if (!clientIsV2) {
                logger.warn({ socket_event: `[${event}:route]`, socket: socket.id, streamId: payload?.streamId, protocol_version: payload?.protocolVersion, reason: 'BAD_PROTOCOL_VERSION' });
                callback?.({ status: 'ERROR:BAD_PROTOCOL_VERSION' });
                return;
            }

            await installAndDispatch(io, socket, event, hostIsV2 ? webClientToAndroid : webClientToAndroidV1, payload, callback);
        } catch (cause) {
            logger.error({ socket_event: `[${event}:route]`, socket: socket.id, reason: 'ROUTE_FAILED', message: cause?.message });
            callback?.({ status: 'ERROR:ROUTE_FAILED' });
        } finally {
            socket.removeAllListeners(event);
            socket.on(event, routeJoin);
        }
    };

    socket.removeAllListeners(event);
    socket.on(event, routeJoin);
}
