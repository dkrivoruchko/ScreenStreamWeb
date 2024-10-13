export const isStreamIdValid = (id) => typeof id === 'string' && /^\d{8}$/.test(id);
export const isStreamPasswordValid = (password) => typeof password === 'string' && /^[a-zA-Z0-9]{6}$/.test(password);

const DEFAULT_ICE_SERVERS = [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
    'stun:stun2.l.google.com:19302',
    'stun:stun3.l.google.com:19302',
    'stun:stun4.l.google.com:19302',
];

function getDefaultIceServers() {
    return DEFAULT_ICE_SERVERS
        .sort(() => 0.5 - Math.random())
        .slice(0, 2)
        .map(server => ({ urls: server }));
}

function log(level, message, context = {}) {
    if (window.DD_LOGS && DD_LOGS.logger) {
        DD_LOGS.logger[level](message, context);
    } else {
        console[level](message, context);
    }
}

export class WebRTC {
    constructor(clientId, streamState, getTurnstileTokenAsync, onNewTrack) {
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

        log('debug', 'WebRTC.constructor');
    }

    async isServerOnlineAsync() {
        log('debug', 'WebRTC.isServerOnlineAsync');
        try {
            const response = await fetch('/app/ping');
            return response.status === 204;
        } catch {
            return false;
        }
    }

    async waitForServerOnlineAndConnect() {
        log('debug', 'WebRTC.waitForServerOnlineAndConnect');
        const online = await this.isServerOnlineAsync();
        this.streamState.isServerAvailable = online;

        if (online) {
            try {
                const token = await this.getTurnstileTokenAsync(this.clientId);
                this.connectSocket(token);
            } catch (error) {
                this.streamState.error = error;
            }
        } else {
            setTimeout(() => this.waitForServerOnlineAndConnect(), 3000);
        }
    }

    connectSocket(token) {
        log('debug', 'WebRTC.connectSocket');
        this.streamState.isTokenAvailable = true;

        if (this.socket) {
            this.streamState.error = 'WEBRTC_ERROR:SOCKET_EXIST';
            return;
        }

        this.socketReconnectCounter += 1;
        log('debug', `WebRTC.connectSocket: Attempt: ${this.socketReconnectCounter}`);

        this.socket = io({
            path: '/app/socket',
            transports: ['websocket'],
            auth: { clientToken: token },
            reconnection: false,
        });

        this.socket.on('connect', () => {
            log('debug', 'WebRTC.connectSocket: connect');
            if (window.DD_LOGS && DD_LOGS.setGlobalContextProperty) {
                DD_LOGS.setGlobalContextProperty('socket', this.socket.id);
            }

            this.socketReconnectCounter = 0;

            this.streamState.isSocketConnected = true;
            this.streamState.isTokenAvailable = false;
        });

        this.socket.on('disconnect', (reason) => {
            log('debug', `WebRTC.connectSocket: [disconnect] => ${reason}`);
            if (window.DD_LOGS && DD_LOGS.removeGlobalContextProperty) {
                DD_LOGS.removeGlobalContextProperty('socket');
            }

            this.cleanupSocket();

            if (this.socketReconnectCounter >= 10) {
                log('warn', `WebRTC.connectSocket: failed after [${this.socketReconnectCounter}] attempts. Giving up.`);
                this.streamState.error = 'WEBRTC_ERROR:SOCKET_CONNECT_FAILED';
            } else {
                setTimeout(() => this.waitForServerOnlineAndConnect(), 3000);
            }
        });

        this.socket.on('connect_error', (error) => {
            log('warn', `WebRTC.connectSocket: [connect_error] => ${error.message}`, { error: error.message });

            this.cleanupSocket();

            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}
            this.streamState.error = error.message || 'WEBRTC_ERROR:CONNECT_ERROR'; // || 'WEBRTC_ERROR:CONNECT_ERROR'
        });

        this.socket.on('SOCKET:ERROR', (error, callback) => {
            log('warn', `WebRTC.connectSocket: [SOCKET:ERROR]: ${error.status}`, { error: error.status });

            // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
            // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
            // SOCKET_CHECK_ERROR:NO_CLIENT_ID
            // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
            // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED
            this.streamState.error = error.status;

            // Server always disconnects socket on this event. To disable reconnect
            this.socketReconnectCounter = 5;

            if (callback) callback({ status: 'OK' });
        });
    }

    cleanupSocket() {
        this.socket = null;
        this.streamState.isSocketConnected = false;
        this.streamState.isServerAvailable = false;
        this.streamState.isTokenAvailable = false;
        if (this.streamState.isStreamJoined && !this.streamState.isStreamRunning) {
            this.leaveStream(false);
        }
    }

    async joinStream(streamId, password, attempt = 0) {
        this.streamState.error = null;

        if (!isStreamIdValid(streamId)) {
            log('warn', `WebRTC.joinStream: Bad stream id: '${streamId}'`, { streamId });
            this.streamState.error = 'ERROR:WRONG_STREAM_ID';
            return;
        }

        if (!this.streamState.isSocketConnected) {
            log('warn', 'WebRTC.joinStream: No socket connected');
            this.streamState.error = 'WEBRTC_ERROR:NO_SOCKET_CONNECTED';
            return;
        }

        if (!this.socket) {
            log('warn', 'WebRTC.joinStream: No socket available');
            this.streamState.error = 'WEBRTC_ERROR:NO_SOCKET_AVAILABLE';
            return;
        }

        if (this.streamState.isJoiningStream) {
            log('info', 'WebRTC.joinStream: Already joining stream. Ignoring.');
            return;
        }

        log('debug', `WebRTC.joinStream: ${streamId}. Attempt: ${attempt}`, { streamId });
        this.streamState.isJoiningStream = true;

        try {
            const data = this.clientId + streamId + password;
            const hashBuffer = await window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(data));
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const passwordHash = btoa(String.fromCharCode(...hashArray))
                .replace(/\+/g, '-')
                .replace(/\//g, '_');

            this.socket.timeout(5000).emit('STREAM:JOIN', { streamId, passwordHash }, (error, response) => {
                this.streamState.isJoiningStream = false;
                if (error) {
                    log('debug', `WebRTC.joinStream: [STREAM:JOIN] timeout: ${error}`);
                    this.streamState.error = 'ERROR:TIMEOUT:STREAM:JOIN';
                    return;
                }
                if (!response || response.status !== 'OK') {
                    log('warn', `WebRTC.joinStream: [STREAM:JOIN] error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:JOIN]', error: response });
                    this.streamState.error = response.status;
                    return;
                }

                log('debug', 'WebRTC.joinStream: [STREAM:JOIN] OK', { socket_event: '[STREAM:JOIN]' });
                this.streamState.streamId = streamId;
                this.streamPassword = password;
                this.streamState.isStreamJoined = true;
                this.iceServers = response.iceServers?.length ? response.iceServers : getDefaultIceServers();

                this.setupSocketEventListeners(attempt);
            });
        } catch (error) {
            this.streamState.isJoiningStream = false;
            this.streamState.error = error;
        }
    }

    setupSocketEventListeners(attempt) {
        this.socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');

        this.socket.on('STREAM:START', () => {
            log('debug', 'WebRTC: receive [STREAM:START]', { socket_event: '[STREAM:START]' });
            this.startStream(attempt);
        });
        this.socket.on('STREAM:STOP', () => {
            log('debug', 'WebRTC: receive [STREAM:STOP]', { socket_event: '[STREAM:STOP]' });
            this.stopStream();
        });
        this.socket.on('REMOVE:CLIENT', (callback) => {
            log('debug', 'WebRTC: receive [REMOVE:CLIENT]', { socket_event: '[REMOVE:CLIENT]' });
            if (callback) callback({ status: 'OK' });
            this.leaveStream(false);
        });
        this.socket.on('REMOVE:STREAM', () => {
            log('debug', 'WebRTC: receive [REMOVE:STREAM]', { socket_event: '[REMOVE:STREAM]' });
            this.leaveStream(false, true);
        });
    }

    async startStream(attempt) {
        log('debug', `WebRTC.startStream [${attempt}]`);

        if (this.peerConnection) {
            log('warn', 'WebRTC.startStream: Existing PeerConnection found. Stopping it first.');
            this.stopStream();
        }

        const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
        this.peerConnection = new RTCPeerConnection({
            bundlePolicy: 'balanced',
            iceServers: this.iceServers,
        });

        this.hostOfferTimeout = setTimeout(() => {
            log('info', 'WebRTC.startStream: HOST:OFFER timeout. Leaving stream.');
            this.leaveStream(true);
        }, 5000);

        this.peerConnection.oniceconnectionstatechange = async () => {
            const state = this.peerConnection.iceConnectionState;
            log('debug', `WebRTC.startStream: PeerConnection: iceConnectionState change to "${state}".`);
            if (state === 'connected' || state === 'completed') {
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

                            log('debug', `WebRTC.startStream: PeerConnection relay protocol: ${relayProtocol}`, { relayProtocol, hasTurnServer, localType, remoteType });
                        }
                    }
                });
            }
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection.connectionState;
            log('debug', `WebRTC.startStream: PeerConnection: connectionState change to "${state}".`);

            if (state === 'disconnected' || state === 'failed') {
                if (attempt === 0 && this.streamState.isSocketConnected && this.streamState.isServerAvailable) {
                    log('info', 'WebRTC.startStream: PeerConnection: Attempting to reconnect...');
                    const streamId = this.streamState.streamId;
                    const password = this.streamPassword;
                    this.leaveStream(true);
                    setTimeout(() => this.joinStream(streamId, password, attempt + 1), 1000);
                } else {
                    log('info', 'WebRTC.startStream: PeerConnection: Reconnection failed. Stopping stream.');
                    this.leaveStream(true);
                }
            }
        };

        this.peerConnection.ontrack = (event) => {
            this.onNewTrack(event.track);
            this.streamState.isStreamRunning = true;
        };

        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.timeout(5000).emit('CLIENT:CANDIDATE', { candidate: event.candidate.toJSON() }, (error, response) => {
                    if (error) {
                        log('debug', `WebRTC.startStream: [CLIENT:CANDIDATE] timeout: ${error}`);
                        this.streamState.error = 'ERROR:TIMEOUT:CLIENT:CANDIDATE';
                    } else if (!response || response.status !== 'OK') {
                        log('warn', `WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:CANDIDATE]', error: response });
                        this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
                    } else {
                        log('debug', 'WebRTC.startStream: [CLIENT:CANDIDATE] send OK', { socket_event: '[CLIENT:CANDIDATE]' });
                    }
                });
            } else {
                this.peerConnection.onicecandidate = null;
            }
        };

        this.socket.on('HOST:CANDIDATE', (hostCandidates, callback) => {
            if (!hostCandidates || !hostCandidates.candidates) {
                if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                log('warn', 'WebRTC.startStream: Error in host candidates', { socket_event: '[HOST:CANDIDATE]', error: 'ERROR:EMPTY_OR_BAD_DATA', hostCandidate: hostCandidates.candidates });
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATE';
                return;
            }

            if (callback) callback({ status: 'OK' });
            log('debug', 'WebRTC.startStream: receive [HOST:CANDIDATE]', { socket_event: '[HOST:CANDIDATE]' });

            hostCandidates.candidates.forEach((candidate) => {
                this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => {
                    log('warn', 'WebRTC.startStream: Failed to add host candidate', { socket_event: '[HOST:CANDIDATE]', error });
                });
            });
        });

        this.socket.once('HOST:OFFER', async (hostOffer, callback) => {
            clearTimeout(this.hostOfferTimeout);
            this.hostOfferTimeout = null;

            if (!hostOffer || !hostOffer.offer) {
                if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
                log('warn', 'WebRTC.startStream: Error in host offer', { socket_event: '[HOST:OFFER]', error: 'ERROR:EMPTY_OR_BAD_DATA', offer: JSON.stringify(hostOffer) });
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
                return;
            }

            if (callback) callback({ status: 'OK' });
            log('debug', 'WebRTC.startStream: receive [HOST:OFFER]', { socket_event: '[HOST:OFFER]' });

            try {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: hostOffer.offer }));
                const answer = await this.peerConnection.createAnswer({ voiceActivityDetection: false });
                await this.peerConnection.setLocalDescription(answer);

                this.socket.timeout(5000).emit('CLIENT:ANSWER', { answer: answer.sdp }, (error, response) => {
                    if (error) {
                        log('debug', `WebRTC.startStream: [CLIENT:ANSWER] timeout: ${error}`);
                        this.streamState.error = 'ERROR:TIMEOUT:CLIENT:ANSWER';
                    } else if (!response || response.status !== 'OK') {
                        log('warn', `WebRTC.startStream: Error: ${JSON.stringify(response)}`, { socket_event: '[CLIENT:ANSWER]', error: response });
                        this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
                    } else {
                        log('debug', 'WebRTC.startStream: [CLIENT:ANSWER] send OK', { socket_event: '[CLIENT:ANSWER]' });
                    }
                });
            } catch (error) {
                log('error', 'WebRTC.startStream: Error during offer/answer negotiation', { socket_event: '[CLIENT:ANSWER]', error });
                this.streamState.error = error;
            }
        });
    }

    stopStream() {
        log('debug', 'WebRTC.stopStream');

        clearTimeout(this.hostOfferTimeout);
        this.hostOfferTimeout = null;

        if (this.socket) {
            this.socket.off('HOST:CANDIDATE').off('HOST:OFFER');
        }

        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        this.streamState.isStreamRunning = false;
    }

    leaveStream(notifyServer = true, forcedByServer = false) {
        log('debug', `WebRTC.leaveStream: notifyServer=${notifyServer}, forcedByServer=${forcedByServer}`);

        this.stopStream();

        if (this.socket) {
            this.socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');
        }

        if (notifyServer && this.socket) {
            this.socket.timeout(5000).emit('STREAM:LEAVE', (error, response) => {
                if (error) {
                    log('debug', `WebRTC.leaveStream: [STREAM:LEAVE] timeout: ${error}`);
                } else if (!response || response.status !== 'OK') {
                    log('warn', `WebRTC.leaveStream: Error: ${JSON.stringify(response)}`, { socket_event: '[STREAM:LEAVE]', error: response });
                } else {
                    log('debug', 'WebRTC.leaveStream: [STREAM:LEAVE] send OK', { socket_event: '[STREAM:LEAVE]' });
                }
            });
        }

        this.streamState.isStreamJoined = false;
        this.streamState.streamId = null;
        this.streamPassword = null;
    }
}