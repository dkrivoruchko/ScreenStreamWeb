export class WebRTC {
    clientId = this.#generateRandomString(24);
    #socketConnectCounter = 0;
    #disableAutoReconnect = false;
    #socket = null;
    #currentStreamId = null;
    #currentPasswordHash = null;
    #autoJoinCounter = 0;
    #peerConnection = null;
    #isJoinedToStream = false;
    #hostOfferTimeout = null;

    #getTurnstileTokenAsync;
    #onSocketConnect;
    #onSocketDisconnect;
    #onJoinStream;
    #onShowStream;
    #onHideStream;
    #onLeaveStream;
    #onError;

    constructor(getTurnstileTokenAsync, onSocketConnect, onSocketDisconnect, onJoinStream, onShowStream, onHideStream, onLeaveStream, onError) {
        this.#getTurnstileTokenAsync = getTurnstileTokenAsync;
        this.#onSocketConnect = onSocketConnect;
        this.#onSocketDisconnect = onSocketDisconnect;
        this.#onJoinStream = onJoinStream;
        this.#onShowStream = onShowStream;
        this.#onHideStream = onHideStream;
        this.#onLeaveStream = onLeaveStream;
        this.#onError = onError;
    }

    async #isServerOnline() {
        try {
            const response = await fetch('/app/ping');
            return response.ok;
        } catch (ignore) {
            return false;
        }
    }

    async waitForServerOnlineAndConnect() {
        const online = await this.#isServerOnline();
        if (online === true) {
            this.#getTurnstileTokenAsync(this.clientId)
                .then((token) => this.#connectSocket(token))
                .catch((err) => this.#onError(err));
        } else
            setTimeout(() => { this.waitForServerOnlineAndConnect() }, 2000);
    }

    async #connectSocket(token) {
        if (this.#socket) {
            this.#onError('WEBRTC_ERROR:SOCKET_EXIST');
            return;
        }

        this.#socketConnectCounter += 1;

        if (this.#socketConnectCounter >= 5) {
            window.DD_LOGS && DD_LOGS.logger.error(`WebRTC: connectSocket: failed after [${this.#socketConnectCounter}] attempts. Give up.`);
            this.#socketConnectCounter = 0;
            this.#onError('WEBRTC_ERROR:SOCKET_CONNECT_FAILED');
            return;
        }

        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: connectSocket: Attempt: ${this.#socketConnectCounter}`);
        this.#disableAutoReconnect = false;

        this.#socket = io({ path: '/app/socket', transports: ['websocket'], auth: { clientToken: token }, reconnection: false });

        this.#socket.on('connect', () => {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: connect');
            window.DD_LOGS && DD_LOGS.setGlobalContextProperty('socket', this.#socket.id);

            this.#socketConnectCounter = 0;
            this.#onSocketConnect(this.#isJoinedToStream);
            this.#autoJoinStream();
        });

        this.#socket.on('disconnect', (reason) => {
            window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: disconnect [${reason}]`);
            window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('socket');

            this.#socket = null;
            this.#onSocketDisconnect(this.#isJoinedToStream);
            if (!this.#disableAutoReconnect) setTimeout(() => { this.waitForServerOnlineAndConnect() }, 2000);
        });

        this.#socket.on('connect_error', (error) => {
            window.DD_LOGS && DD_LOGS.logger.error('WebRTC: connect_error: ' + error.message, { error });

            if (this.#isJoinedToStream) this.leaveStream(false);
            this.#onError(error.status);

            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}

            this.#disableAutoReconnect = true;

            this.#socket = null;
            this.#onSocketDisconnect(this.#isJoinedToStream);
            setTimeout(() => { this.waitForServerOnlineAndConnect(); }, 2000);
        });

        this.#socket.on('SOCKET:ERROR', (error, callback) => { // Server always disconnects socket on this event
            window.DD_LOGS && DD_LOGS.logger.error('WebRTC: SOCKET:ERROR: ' + error.status, { error: error.status });

            if (this.#isJoinedToStream) this.leaveStream(false);
            this.#onError(error.status);

            // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
            // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
            // SOCKET_CHECK_ERROR:NO_CLIENT_ID
            // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
            // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED

            this.#disableAutoReconnect = true;
            callback({ status: 'OK' });
        });
    }

    #autoJoinStream() {
        if (this.#currentStreamId != null && this.#currentPasswordHash != null) {
            window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: autoJoinStream: Attempt: ${this.#autoJoinCounter}`);
            this.joinStream(this.#currentStreamId, this.#currentPasswordHash, true);
        }
    }

    joinStream(streamId, passwordHash, autoJoin) {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: joinStream: autoJoin=${autoJoin}`);
        this.#onError(null);

        this.#socket.timeout(5000).emit('STREAM:JOIN', { streamId, passwordHash }, (err, response) => {
            if (err) {
                window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: [STREAM:JOIN] timeout: ${err}`);
                this.#onError('ERROR:TIMEOUT:STREAM:JOIN');
                return;
            }
            if (!response || !response.status || response.status !== 'OK') {
                window.DD_LOGS && DD_LOGS.logger.error(`WebRTC: Error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:JOIN]', error: response });

                if (!autoJoin || this.#autoJoinCounter >= 3) {
                    if (autoJoin) this.leaveStream(false);
                    this.#onError(response.status);
                    return;
                }

                this.#autoJoinCounter += 1;
                setTimeout(() => { this.#autoJoinStream() }, this.#autoJoinCounter * 2000);
                return;
            }

            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: [STREAM:JOIN] send OK', { socket_event: '[STREAM:JOIN]' });

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

            this.#autoJoinCounter = 0;
            this.#currentStreamId = streamId;
            this.#currentPasswordHash = passwordHash;
            this.#isJoinedToStream = true;

            this.#onJoinStream(streamId, autoJoin && this.#peerConnection != null);
        });
    }

    #startStream() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: startStream');

        if (this.#peerConnection) {
            window.DD_LOGS && DD_LOGS.logger.console.warn('WebRTC: PeerConnection exist. Cleaning it first.');
            this.#stopStream();
        }

        this.#peerConnection = new RTCPeerConnection({
            bundlePolicy: 'max-bundle',
            iceCandidatePoolSize: 8,
            iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'] }],
        });

        this.#hostOfferTimeout = setTimeout(() => {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: HOST:OFFER timeout. Leaving stream.');
            this.leaveStream(false, false, true);
        }, 5000);

        this.#peerConnection.onconnectionstatechange = (event) => {
            if (this.#peerConnection.connectionState === 'disconnected') {
                window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: PeerConnection state change to "disconnected". Stopping stream.');
                this.#stopStream();
            }
        }

        this.#peerConnection.ontrack = (event) => this.#onShowStream(event.track);

        let clientCandidates = [];

        this.#peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                clientCandidates.push(event.candidate.toJSON());
            } else {
                this.#peerConnection.onicecandidate = undefined;

                this.#socket.timeout(5000).emit('CLIENT:CANDIDATES', { candidates: clientCandidates }, (err, response) => {
                    if (err) {
                        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: [CLIENT:CANDIDATES] timeout: ${err}`);
                        this.#onError('ERROR:TIMEOUT:CLIENT:CANDIDATES');
                    } else if (!response || !response.status || response.status !== 'OK') {
                        window.DD_LOGS && DD_LOGS.logger.error(`WebRTC: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:CANDIDATES]', error: response });
                        this.#onError('WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATES');
                    } else {
                        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: [CLIENT:CANDIDATES] send OK', { socket_event: '[CLIENT:CANDIDATES]', candidates: clientCandidates.length });
                    }
                    clientCandidates = [];
                });
            }
        };

        this.#socket.once('HOST:CANDIDATES', (hostCandidates, callback) => {
            if (!hostCandidates || !hostCandidates.candidates || !Array.isArray(hostCandidates.candidates)) {
                callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                window.DD_LOGS && DD_LOGS.logger.error('WebRTC: Error in host candidates', { socket_event: '[HOST:CANDIDATES]', error: 'ERROR:EMPTY_OR_BAD_DATA', hostCandidates: JSON.stringify(hostCandidates) });
                this.#onError('WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATES');
                return;
            }

            callback({ status: 'OK' });
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [HOST:CANDIDATES]', { socket_event: '[HOST:CANDIDATES]' });

            hostCandidates.candidates.forEach(candidateString => this.#peerConnection.addIceCandidate(new RTCIceCandidate(candidateString)));
        });

        this.#socket.once('HOST:OFFER', async (hostOffer, callback) => {
            clearTimeout(this.#hostOfferTimeout);
            this.#hostOfferTimeout = null;

            if (!hostOffer || !hostOffer.offer) {
                callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                window.DD_LOGS && DD_LOGS.logger.error('WebRTC: Error in host offer', { socket_event: '[HOST:OFFER]', error: 'ERROR:EMPTY_OR_BAD_DATA', offer: JSON.stringify(hostOffer) });
                this.#onError('WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER');
                return;
            }

            callback({ status: 'OK' });
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [HOST:OFFER]', { socket_event: '[HOST:OFFER]' });

            await this.#peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: hostOffer.offer }));
            const answer = await this.#peerConnection.createAnswer({ voiceActivityDetection: false });
            await this.#peerConnection.setLocalDescription(answer);

            this.#socket.timeout(5000).emit('CLIENT:ANSWER', { answer: answer.sdp }, (err, response) => {
                if (err) {
                    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: [CLIENT:ANSWER] timeout: ${err}`);
                    this.#onError('ERROR:TIMEOUT:CLIENT:ANSWER');
                } else if (!response || !response.status || response.status !== 'OK') {
                    window.DD_LOGS && DD_LOGS.logger.error(`WebRTC: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:ANSWER]', error: response });
                    this.#onError('WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER');
                } else {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: [CLIENT:ANSWER] send OK', { socket_event: '[CLIENT:ANSWER]' });
                }
            });
        });
    }

    #stopStream() {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: stopStream');

        this.#socket && this.#socket.off('HOST:CANDIDATES').off('HOST:OFFER');

        if (this.#peerConnection) {
            this.#peerConnection.close();
            this.#peerConnection.onconnectionstatechange = null;
            this.#peerConnection = null;
        }

        clearTimeout(this.#hostOfferTimeout);
        this.#hostOfferTimeout = null;

        this.#onHideStream();
    }

    leaveStream(notifyServer, forcedByServer = false, autoReJoin = false) {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: leaveStream: notifyServer=${notifyServer}, forcedByServer=${forcedByServer}, autoReJoin=${autoReJoin}`);

        this.#stopStream();

        this.#socket && this.#socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');

        notifyServer === true && this.#socket && this.#socket.timeout(5000).emit('STREAM:LEAVE', (err, response) => {
            if (err) {
                window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC: [STREAM:LEAVE] timeout: ${err}`);
            } else if (!response || !response.status || response.status !== 'OK') {
                window.DD_LOGS && DD_LOGS.logger.error(`WebRTC: Error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:LEAVE]', error: response });
            } else {
                window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: [STREAM:LEAVE] send OK', { socket_event: '[STREAM:LEAVE]' });
            }
        });

        this.#autoJoinCounter = 0;
        this.#currentStreamId = null;
        this.#currentPasswordHash = null;
        this.#isJoinedToStream = false;

        this.#onLeaveStream(forcedByServer, autoReJoin);
    }

    #generateRandomString(length) {
        let result = '';
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const charactersLength = characters.length;
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * charactersLength));
        }
        return result;
    }
}