export const isStreamIdValid = (id) => typeof id === 'string' && /^\d+$/.test(id) && id.length === 8
export const isStreamPasswordValid = (password) => typeof password === 'string' && /^[a-zA-Z0-9]+$/.test(password) && password.length === 6

const DEFAULT_ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'];
function getDefaultIceServers() {
    return DEFAULT_ICE_SERVERS.sort(() => .5 - Math.random()).slice(0, 2).map(server => ({ urls: server }));
}

export function WebRTC(clientId, streamState, getTurnstileTokenAsync, onNewTrack) {
    this.clientId = clientId;
    this.streamState = streamState;
    this.getTurnstileTokenAsync = getTurnstileTokenAsync;
    this.onNewTrack = onNewTrack;

    this.socket = null;
    this.socketReconnectCounter = 0;

    this.streamPassword = null;

    this.peerConnection = null;
    this.hostOfferTimeout = null;

    this.iceServers = getDefaultIceServers();

    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.constructor');
};
WebRTC.prototype.isServerOnlineAsync = function () {
    return new Promise((resolve) => {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.isServerOnlineAsync');
        fetch('/app/ping').then(response => resolve(response.status === 204)).catch(() => resolve(false));
    });
};
WebRTC.prototype.waitForServerOnlineAndConnect = function () {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.waitForServerOnlineAndConnect');
    this.isServerOnlineAsync().then(online => {
        this.streamState.isServerAvailable = online;
        if (online) {
            this.getTurnstileTokenAsync(this.clientId)
                .then(token => this.connectSocket(token))
                .catch(error => this.streamState.error = error);
        } else {
            setTimeout(() => this.waitForServerOnlineAndConnect(), 3000);
        }
    });
};
WebRTC.prototype.connectSocket = function (token) {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket');
    this.streamState.isTokenAvailable = true;

    if (this.socket) {
        this.streamState.error = 'WEBRTC_ERROR:SOCKET_EXIST';
        return;
    }

    this.socketReconnectCounter += 1;
    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.connectSocket: Attempt: ${this.socketReconnectCounter}`);

    this.socket = io({ path: '/app/socket', transports: ['websocket'], auth: { clientToken: token }, reconnection: false });

    this.socket.on('connect', () => {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket: connect');
        window.DD_LOGS && DD_LOGS.setGlobalContextProperty('socket', this.socket.id);

        this.socketReconnectCounter = 0;

        this.streamState.isSocketConnected = true;
        this.streamState.isTokenAvailable = false;
    });

    this.socket.on('disconnect', (reason) => {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.connectSocket: [disconnect] => ${reason}`);
        window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('socket');

        this.socket = null;
        this.streamState.isSocketConnected = false;
        this.streamState.isServerAvailable = false;
        this.streamState.isTokenAvailable = false;
        if (this.streamState.isStreamJoined && !this.streamState.isStreamRunning) this.leaveStream(false);

        if (this.socketReconnectCounter >= 10) {
            window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.connectSocket: failed after [${this.socketReconnectCounter}] attempts. Give up.`);
            this.streamState.error = 'WEBRTC_ERROR:SOCKET_CONNECT_FAILED'; //TODO may be reload page
        } else {
            setTimeout(() => this.waitForServerOnlineAndConnect(), 3000);
        }
    });

    this.socket.on('connect_error', (error) => {
        window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.connectSocket: [connect_error] => ${error.message}`, { error: error.message });

        this.socket = null;
        this.streamState.isSocketConnected = false;
        this.streamState.isServerAvailable = false;
        this.streamState.isTokenAvailable = false;

        if (this.streamState.isStreamJoined && !this.streamState.isStreamRunning) this.leaveStream(false);

        //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
        //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
        //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}
        this.streamState.error = error.message;
    });

    this.socket.on('SOCKET:ERROR', (error, callback) => {
        window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.connectSocket: [SOCKET:ERROR]: ' + error.status, { error: error.status });

        // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
        // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
        // SOCKET_CHECK_ERROR:NO_CLIENT_ID
        // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
        // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED
        this.streamState.error = error.status;

        // Server always disconnects socket on this event. To disable reconnect
        this.socketReconnectCounter = 5;

        callback({ status: 'OK' });
    });
};
WebRTC.prototype.joinStream = function (streamId, password, attempt = 0) {
    this.streamState.error = null;

    if (!isStreamIdValid(streamId)) {
        window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.joinStream: Bad stream id: '${streamId}'`, { streamId });
        this.streamState.error = 'ERROR:WRONG_STREAM_ID';
        return;
    }

    if (!this.streamState.isSocketConnected) {
        window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.joinStream: No socket connected');
        this.streamState.error = 'WEBRTC_ERROR:NO_SOCKET_CONNECTED';
        return;
    }

    if (!this.socket) {
        window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.joinStream: No socket available');
        this.streamState.error = 'WEBRTC_ERROR:NO_SOCKET_AVAILABLE';
        return;
    }

    if (this.streamState.isJoiningStream == true) {
        window.DD_LOGS && DD_LOGS.logger.info('WebRTC.joinStream: isJoiningStream==true. Ignoring');
        return;
    }

    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.joinStream: ${streamId}. Attempt: ${attempt}`, { streamId });
    this.streamState.isJoiningStream = true;

    window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(this.clientId + streamId + password))
        .then(buffer => {
            const passwordHash = window.btoa(String.fromCharCode.apply(null, new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_');

            this.socket.timeout(5000).emit('STREAM:JOIN', { streamId, passwordHash }, (error, response) => {
                if (error) {
                    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.joinStream: [STREAM:JOIN] timeout: ${error}`);
                    this.streamState.isJoiningStream = false;
                    this.streamState.error = 'ERROR:TIMEOUT:STREAM:JOIN';
                    return;
                }
                if (!response || !response.status || response.status !== 'OK') {
                    window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.joinStream ${streamId}: [STREAM:JOIN] error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:JOIN]', error: response });

                    this.streamState.isJoiningStream = false;
                    this.streamState.error = response.status;
                    return;
                }

                window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.joinStream: [STREAM:JOIN] OK', { socket_event: '[STREAM:JOIN]' });

                this.streamState.isJoiningStream = false;
                this.streamState.streamId = streamId;
                this.streamPassword = password;
                this.streamState.isStreamJoined = true;
                if (Array.isArray(response.iceServers) && response.iceServers.length !== 0) {
                    this.iceServers = response.iceServers;
                } else {
                    this.iceServers = getDefaultIceServers();
                }

                this.socket
                    .off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM')
                    .on('STREAM:START', () => {
                        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:START]', { socket_event: '[STREAM:START]' });
                        this.startStream(attempt);
                    })
                    .on('STREAM:STOP', () => {
                        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:STOP]', { socket_event: '[STREAM:STOP]' });
                        this.stopStream();
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
        })
        .catch(error => this.streamState.error = error);
};
WebRTC.prototype.startStream = function (attempt) {
    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream [${attempt}]`);

    if (this.peerConnection) {
        window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: PeerConnection exist. Cleaning it first.');
        this.stopStream();
    }

    const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;

    this.peerConnection = new RTCPeerConnection({
        bundlePolicy: 'balanced',
        iceServers: this.iceServers,
    });

    this.hostOfferTimeout = setTimeout(() => {
        window.DD_LOGS && DD_LOGS.logger.info('WebRTC.startStream: HOST:OFFER timeout. Leaving stream.');
        this.leaveStream(true);
    }, 5000);

    this.peerConnection.oniceconnectionstatechange = async (event) => {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: PeerConnection: iceConnectionState change to "${event.currentTarget.iceConnectionState}".`);
        if (this.peerConnection.iceConnectionState !== 'connected' && this.peerConnection.iceConnectionState !== 'completed') return;

        const stats = await this.peerConnection.getStats();
        const hasTurnServer = this.iceServers.some(server => server.urls.startsWith('turn:'));

        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                const localCandidate = stats.get(report.localCandidateId);
                const remoteCandidate = stats.get(report.remoteCandidateId);

                if (localCandidate && remoteCandidate) {
                    const localType = localCandidate.candidateType;
                    const remoteType = remoteCandidate.candidateType;

                    let relayProtocol = 'UNKNOWN';

                    if (localType === 'relay' || remoteType === 'relay') {
                        relayProtocol = 'TURN';
                    } else if (['srflx', 'prflx'].includes(localType) || ['srflx', 'prflx'].includes(remoteType)) {
                        relayProtocol = 'STUN';
                    } else if (localType === 'host' || remoteType === 'host') {
                        relayProtocol = 'HOST';
                    }

                    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: PeerConnection relay protocol: ${relayProtocol}`, { relayProtocol, hasTurnServer, localType, remoteType });
                }
            }
        });

    }

    this.peerConnection.onconnectionstatechange = (event) => {
        window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: PeerConnection: connectionState change to "${event.currentTarget.connectionState}".`);

        if (this.peerConnection.connectionState === 'disconnected' || this.peerConnection.connectionState === 'failed') {
            if (attempt == 0 && this.streamState.isSocketConnected && this.streamState.isServerAvailable) {
                window.DD_LOGS && DD_LOGS.logger.info('WebRTC.startStream: PeerConnection: Attempting to reconnect...');
                const streamId = this.streamState.streamId;
                const password = this.streamPassword;
                this.leaveStream(true);
                setTimeout(() => this.joinStream(streamId, password, attempt + 1), 1000);
            } else {
                window.DD_LOGS && DD_LOGS.logger.info('WebRTC.startStream: PeerConnection: Reconnection failed. Stopping stream.');
                this.leaveStream(true);
            }
        }
    }

    this.peerConnection.ontrack = (event) => {
        this.onNewTrack(event.track);
        this.streamState.isStreamRunning = true;
    }

    this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            this.socket.timeout(5000).emit('CLIENT:CANDIDATE', { candidate: event.candidate.toJSON() }, (error, response) => {
                if (error) {
                    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: [CLIENT:CANDIDATE] timeout: ${error}`);
                    this.streamState.error = 'ERROR:TIMEOUT:CLIENT:CANDIDATE';
                } else if (!response || !response.status || response.status !== 'OK') {
                    window.DD_LOGS && DD_LOGS.logger.info(`WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:CANDIDATE]', error: response });
                    this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
                } else {
                    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:CANDIDATE] send OK', { socket_event: '[CLIENT:CANDIDATE]' });
                }
            });
        } else {
            this.peerConnection.onicecandidate = undefined;
        }
    };

    this.socket.on('HOST:CANDIDATE', (hostCandidates, callback) => {
        if (!hostCandidates || !hostCandidates.candidates) {
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host candidates', { socket_event: '[HOST:CANDIDATE]', error: 'ERROR:EMPTY_OR_BAD_DATA', hostCandidate: hostCandidates.candidates });
            this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATE';
            return;
        }

        callback({ status: 'OK' });
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:CANDIDATE]', { socket_event: '[HOST:CANDIDATE]' });

        hostCandidates.candidates.forEach((candidate) => this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)));
    });

    this.socket.once('HOST:OFFER', (hostOffer, callback) => {
        clearTimeout(this.hostOfferTimeout);
        this.hostOfferTimeout = null;

        if (!hostOffer || !hostOffer.offer) {
            callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host offer', { socket_event: '[HOST:OFFER]', error: 'ERROR:EMPTY_OR_BAD_DATA', offer: JSON.stringify(hostOffer) });
            this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
            return;
        }

        callback({ status: 'OK' });
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:OFFER]', { socket_event: '[HOST:OFFER]' });

        try {
            const hostCodecs = JSON.stringify(hostOffer.offer.split("\n").filter(line => line.startsWith("a=rtpmap:")).map(line => line.split(" ")[1].slice(0, -1)));
            window.DD_LOGS && DD_LOGS.logger.debug(`HostCodecs: ${hostCodecs}`, { hostCodecs });
        } catch (e) {
            window.DD_LOGS && DD_LOGS.logger.debug(`HostCodecs: ${e.message}`, e);
        }

        this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: hostOffer.offer }))
            .then(() => this.peerConnection.createAnswer({ voiceActivityDetection: false }))
            .then(answer => {
                try {
                    const clientCodecs = JSON.stringify(answer.sdp.split("\n").filter(line => line.startsWith("a=rtpmap:")).map(line => line.split(" ")[1].slice(0, -1)));
                    window.DD_LOGS && DD_LOGS.logger.debug(`ClientCodecs: ${clientCodecs}`, { clientCodecs });
                } catch (e) {
                    window.DD_LOGS && DD_LOGS.logger.debug(`ClientCodecs: ${e.message}`, e);
                }

                this.peerConnection.setLocalDescription(answer).then(() => {
                    this.socket.timeout(5000).emit('CLIENT:ANSWER', { answer: answer.sdp }, (error, response) => {
                        if (error) {
                            window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.startStream: [CLIENT:ANSWER] timeout: ${error}`);
                            this.streamState.error = 'ERROR:TIMEOUT:CLIENT:ANSWER';
                        } else if (!response || !response.status || response.status !== 'OK') {
                            window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:ANSWER]', error: response });
                            this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
                        } else {
                            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:ANSWER] send OK', { socket_event: '[CLIENT:ANSWER]' });
                        }
                    });
                })
                    .catch(error => this.streamState.error = error);
            })
            .catch(error => this.streamState.error = error);
    });
};
WebRTC.prototype.stopStream = function () {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.stopStream');

    clearTimeout(this.hostOfferTimeout);
    this.hostOfferTimeout = null;

    this.socket && this.socket.off('HOST:CANDIDATE').off('HOST:OFFER');

    if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
    }

    this.streamState.isStreamRunning = false;
};
WebRTC.prototype.leaveStream = function (notifyServer, forcedByServer = false) {
    window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.leaveStream: notifyServer=${notifyServer}, forcedByServer=${forcedByServer}`);

    this.stopStream();

    this.socket && this.socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');

    notifyServer && this.socket && this.socket.timeout(5000).emit('STREAM:LEAVE', (error, response) => {
        if (error) {
            window.DD_LOGS && DD_LOGS.logger.debug(`WebRTC.leaveStream: [STREAM:LEAVE] timeout: ${error}`);
        } else if (!response || !response.status || response.status !== 'OK') {
            window.DD_LOGS && DD_LOGS.logger.warn(`WebRTC.leaveStream: Error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:LEAVE]', error: response });
        } else {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.leaveStream: [STREAM:LEAVE] send OK', { socket_event: '[STREAM:LEAVE]' });
        }
    });

    this.streamState.isStreamJoined = false;
    this.streamState.streamId = null;
    this.streamPassword = null;
};