const validClientEvents = ['STREAM:JOIN', 'CLIENT:ANSWER', 'CLIENT:CANDIDATE', 'STREAM:LEAVE'];
const validHostEvents = ['STREAM:CREATE', 'STREAM:REMOVE', 'STREAM:START', 'HOST:OFFER', 'HOST:CANDIDATE', 'STREAM:STOP', 'REMOVE:CLIENT'];

export default function (io, socket) {
    socket.onAny(async event => {
        try {

            if (!socket.data || (socket.data.isClient !== true && socket.data.isHost !== true)) {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'UNVERIFIED_SOCKET', message: "Unverified socket. Disconnecting" }));
                throw new Error('UNVERIFIED_SOCKET');
            }

            if (socket.data.isClient === true && socket.data.isHost === true) {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'INVALID_SOCKET_STATE', message: "Socket is host and client. Disconnecting" }));
                throw new Error('INVALID_SOCKET_STATE');
            }

            if (socket.data.isClient === true) {
                if (!socket.data.clientId || typeof socket.data.clientId !== 'string' || socket.data.clientId.length === 0) {
                    console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'NO_CLIENT_ID', message: "Client id not set. Disconnecting" }));
                    throw new Error('NO_CLIENT_ID');
                }

                if (!validClientEvents.includes(event)) {
                    console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'UNKNOWN_CLIENT_EVENT', message: "Unknown client event. Disconnecting" }));
                    throw new Error('UNKNOWN_CLIENT_EVENT');
                }

                if (socket.data.errorCounter > 8) {
                    console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'ERROR_LIMIT_REACHED', message: "Client error limit reached. Disconnecting" }));
                    throw new Error('ERROR_LIMIT_REACHED');
                }
            }

            if (socket.data.isHost === true && !validHostEvents.includes(event)) {
                console.error(JSON.stringify({ socket_event: event, socket: socket.id, error: 'UNKNOWN_HOST_EVENT', message: "Unknown host event. Disconnecting" }));
                throw new Error('UNKNOWN_HOST_EVENT');
            }

        } catch (cause) {
            try {
                await socket.timeout(3000).emitWithAck('SOCKET:ERROR', { status: `SOCKET_CHECK_ERROR:${cause.message}` });
            } catch (err) {
            }
            socket.disconnect(true);
        }
    });
}