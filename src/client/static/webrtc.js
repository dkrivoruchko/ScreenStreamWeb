export const isStreamIdValid = (id) => typeof id === 'string' && /^\d+$/.test(id) && id.length === 8
export const isStreamPasswordValid = (password) => typeof password === 'string' && /^[a-zA-Z0-9]+$/.test(password) && password.length === 6

export class StreamState {
    isServerAvailable = false;
    isTokenAvailable = false;
    isSocketConnected = false;
    isJoiningStream = false;

    streamId = null;
    isStreamJoined = false;
    isStreamRunning = false;

    error = null;
}

export class WebRTC {
    #clientId;
    #streamState;
    #getTurnstileTokenAsync;
    #onNewTrack;

    #socket = null;
    #socketReconnectCounter = 0;
    #peerConnection = null;
    #hostOfferTimeout = null;

    #iceServers = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'];

    constructor(clientId, streamState, getTurnstileTokenAsync, onNewTrack) {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.constructor');
        this.#clientId = clientId;
        this.#streamState = streamState;
        this.#getTurnstileTokenAsync = getTurnstileTokenAsync;
        this.#onNewTrack = onNewTrack;
    }

    async #isServerOnline() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.isServerOnline');
        try {
            const response = await fetch('/app/ping');
            return response.ok;
        } catch (ignore) {
            return false;
        }
    }

    async waitForServerOnlineAndConnect() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.waitForServerOnlineAndConnect');
        const online = await this.#isServerOnline();
        this.#streamState.isServerAvailable = online;
        if (online) {
            this.#getTurnstileTokenAsync(this.#clientId)
                .then((token) => this.#connectSocket(token))
                .catch((err) => this.#streamState.error = err);
        } else {
            setTimeout(() => { this.waitForServerOnlineAndConnect() }, 3000);
        }
    }

    async #connectSocket(token) {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket');
        this.#streamState.isTokenAvailable = true;

        if (this.#socket) {
            this.#streamState.error = 'WEBRTC_ERROR:SOCKET_EXIST';
            return;
        }

        this.#socketReconnectCounter += 1;
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.connectSocket: Attempt: ${this.#socketReconnectCounter}`);

        this.#socket = io({ path: '/app/socket', transports: ['websocket'], auth: { clientToken: token }, reconnection: false });

        this.#socket.on('connect', () => {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket: connect');
            window.DD_LOGS && DD_LOGS.setGlobalContextProperty('socket', this.#socket.id);

            this.#socketReconnectCounter = 0;

            this.#streamState.isSocketConnected = true;
            this.#streamState.isTokenAvailable = false;
        });

        this.#socket.on('disconnect', (reason) => {
            window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.connectSocket: [disconnect] => ${reason}`);
            window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('socket');

            this.#socket = null;
            this.#streamState.isSocketConnected = false;
            this.#streamState.isServerAvailable = false;
            this.#streamState.isTokenAvailable = false;
            if (this.#streamState.isStreamJoined && !this.#streamState.isStreamRunning) this.leaveStream(false);

            if (this.#socketReconnectCounter >= 5) {
                window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.connectSocket: failed after [${this.#socketReconnectCounter}] attempts. Give up.`);
                this.#streamState.error = 'WEBRTC_ERROR:SOCKET_CONNECT_FAILED';
            } else {
                setTimeout(() => { this.waitForServerOnlineAndConnect() }, 3000);
            }
        });

        this.#socket.on('connect_error', (error) => {
            window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.connectSocket: [connect_error] => ${error.message}`, { error });

            this.#socket = null;
            this.#streamState.isSocketConnected = false;
            this.#streamState.isServerAvailable = false;
            this.#streamState.isTokenAvailable = false;

            if (this.#streamState.isStreamJoined && !this.#streamState.isStreamRunning) this.leaveStream(false);

            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}
            this.#streamState.error = error.status;
        });

        this.#socket.on('SOCKET:ERROR', (error, callback) => {
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.connectSocket: [SOCKET:ERROR]: ' + error.status, { error: error.status });

            // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
            // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
            // SOCKET_CHECK_ERROR:NO_CLIENT_ID
            // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
            // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED
            this.#streamState.error = error.status;

            // Server always disconnects socket on this event. To disable reconnect
            this.#socketReconnectCounter = 5;

            callback({ status: 'OK' });
        });
    }

    async joinStream(streamId, password) {

        this.#streamState.error = null;

        if (!isStreamIdValid(streamId)) {
            window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.joinStream: Bad stream id: '${streamId}'`, { stream_id: streamId });
            this.#streamState.error = 'ERROR:NO_STREAM_HOST_FOUND';
            return;
        }

        if (!this.#streamState.isSocketConnected) {
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.joinStream: No socket connected');
            this.#streamState.error = 'WEBRTC_ERROR:NO_SOCKET_CONNECTED';
            return;
        }

        if (!this.#socket) {
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.joinStream: No socket available');
            this.#streamState.error = 'WEBRTC_ERROR:NO_SOCKET_AVAILABLE';
            return;
        }

        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.joinStream: ${streamId}`, { stream_id: streamId });
        this.#streamState.isJoiningStream = true;

        const buffer = await window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(this.#clientId + streamId + password));
        const passwordHash = window.btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_');

        this.#socket.timeout(5000).emit('STREAM:JOIN', { streamId, passwordHash }, (err, response) => {
            if (err) {
                window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.joinStream: [STREAM:JOIN] timeout: ${err}`);
                this.#streamState.isJoiningStream = false;
                this.#streamState.error = 'ERROR:TIMEOUT:STREAM:JOIN';
                return;
            }
            if (!response || !response.status || response.status !== 'OK') {
                window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.joinStream ${streamId}: [STREAM:JOIN] error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:JOIN]', error: response });

                this.#streamState.isJoiningStream = false;
                this.#streamState.error = response.status;
                return;
            }

            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.joinStream: [STREAM:JOIN] OK', { socket_event: '[STREAM:JOIN]' });

            this.#streamState.isJoiningStream = false;
            this.#streamState.streamId = streamId;
            this.#streamState.isStreamJoined = true;

            this.#socket
                .off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM')
                .on('STREAM:START', () => {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:START]', { socket_event: '[STREAM:START]' });
                    this.#startStream();
                })
                .on('STREAM:STOP', () => {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:STOP]', { socket_event: '[STREAM:STOP]' });
                    this.#stopStream();
                })
                .on('REMOVE:CLIENT', (callback) => {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [REMOVE:CLIENT]', { socket_event: '[REMOVE:CLIENT]' });
                    callback({ status: 'OK' });
                    this.leaveStream(false);
                })
                .on('REMOVE:STREAM', () => {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [REMOVE:STREAM]', { socket_event: '[REMOVE:STREAM]' });
                    this.leaveStream(false, true);
                });
        });
    }

    #startStream() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream');

        if (this.#peerConnection) {
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: PeerConnection exist. Cleaning it first.');
            this.#stopStream();
        }

        this.#peerConnection = new RTCPeerConnection({
            bundlePolicy: 'max-bundle',
            iceCandidatePoolSize: 8,
            iceServers: [{ urls: this.#iceServers.sort(() => .5 - Math.random()).slice(0, 3) }],
        });

        this.#hostOfferTimeout = setTimeout(() => {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: HOST:OFFER timeout. Leaving stream.');
            this.leaveStream(false);
        }, 5000);

        this.#peerConnection.onconnectionstatechange = (event) => {
            if (this.#peerConnection.connectionState === 'disconnected') {
                window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: PeerConnection state change to "disconnected". Stopping stream.');
                this.leaveStream(true);
            }
        }

        this.#peerConnection.ontrack = (event) => {
            this.#onNewTrack(event.track);
            this.#streamState.isStreamRunning = true;
        }

        this.#peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.#socket.timeout(5000).emit('CLIENT:CANDIDATE', { candidate: event.candidate.toJSON() }, (err, response) => {
                    if (err) {
                        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: [CLIENT:CANDIDATE] timeout: ${err}`);
                        this.#streamState.error = 'ERROR:TIMEOUT:CLIENT:CANDIDATE';
                    } else if (!response || !response.status || response.status !== 'OK') {
                        window.DD_LOGS && DD_LOGS.logger.info(`WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:CANDIDATE]', error: response });
                        this.#streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
                    } else {
                        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:CANDIDATE] send OK', { socket_event: '[CLIENT:CANDIDATE]' });
                    }
                });
            } else {
                this.#peerConnection.onicecandidate = undefined;
            }
        };

        this.#socket.on('HOST:CANDIDATE', (hostCandidate, callback) => {
            if (!hostCandidate || !hostCandidate.candidate) {
                callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host candidates', { socket_event: '[HOST:CANDIDATE]', error: 'ERROR:EMPTY_OR_BAD_DATA', hostCandidate: hostCandidate.candidate });
                this.#streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATE';
                return;
            }

            callback({ status: 'OK' });
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:CANDIDATE]', { socket_event: '[HOST:CANDIDATE]' });

            this.#peerConnection.addIceCandidate(new RTCIceCandidate(hostCandidate.candidate));
        });

        this.#socket.once('HOST:OFFER', async (hostOffer, callback) => {
            clearTimeout(this.#hostOfferTimeout);
            this.#hostOfferTimeout = null;

            if (!hostOffer || !hostOffer.offer) {
                callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host offer', { socket_event: '[HOST:OFFER]', error: 'ERROR:EMPTY_OR_BAD_DATA', offer: JSON.stringify(hostOffer) });
                this.#streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
                return;
            }

            callback({ status: 'OK' });
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:OFFER]', { socket_event: '[HOST:OFFER]' });

            await this.#peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: hostOffer.offer }));
            const answer = await this.#peerConnection.createAnswer({ voiceActivityDetection: false });
            await this.#peerConnection.setLocalDescription(answer);

            this.#socket.timeout(5000).emit('CLIENT:ANSWER', { answer: answer.sdp }, (err, response) => {
                if (err) {
                    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: [CLIENT:ANSWER] timeout: ${err}`);
                    this.#streamState.error = 'ERROR:TIMEOUT:CLIENT:ANSWER';
                } else if (!response || !response.status || response.status !== 'OK') {
                    window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:ANSWER]', error: response });
                    this.#streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
                } else {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:ANSWER] send OK', { socket_event: '[CLIENT:ANSWER]' });
                }
            });
        });
    }

    #stopStream() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.stopStream');

        clearTimeout(this.#hostOfferTimeout);
        this.#hostOfferTimeout = null;

        this.#socket && this.#socket.off('HOST:CANDIDATE').off('HOST:OFFER');

        if (this.#peerConnection) {
            this.#peerConnection.close();
            this.#peerConnection = null;
        }

        this.#streamState.isStreamRunning = false;
    }

    leaveStream(notifyServer, forcedByServer = false) {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.leaveStream: notifyServer=${notifyServer}, forcedByServer=${forcedByServer}`);

        this.#stopStream();

        this.#socket && this.#socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');

        notifyServer && this.#socket && this.#socket.timeout(5000).emit('STREAM:LEAVE', (err, response) => {
            if (err) {
                window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.leaveStream: [STREAM:LEAVE] timeout: ${err}`);
            } else if (!response || !response.status || response.status !== 'OK') {
                window.DD_LOGS && DD_LOGS.logger.info(`WebRTC.leaveStream: Error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:LEAVE]', error: response });
            } else {
                window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.leaveStream: [STREAM:LEAVE] send OK', { socket_event: '[STREAM:LEAVE]' });
            }
        });

        this.#streamState.isStreamJoined = false;
        this.#streamState.streamId = null;
    }
}