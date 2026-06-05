import { io } from 'socket.io-client';

export const isStreamIdValid = (id) => typeof id === 'string' && /^\d{8}$/.test(id);
export const isStreamPasswordValid = (password) => typeof password === 'string' && /^[a-zA-Z0-9]{6}$/.test(password);

const PROTOCOL_VERSION = 2;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_PENDING_HOST_CANDIDATES_PER_ATTEMPT = 32;
const TRANSIENT_JOIN_ERRORS = new Set(['ERROR:TIMEOUT:STREAM:JOIN', 'ERROR:HOST_SOCKET_DISCONNECTED', 'ERROR:TIMEOUT_OR_NO_RESPONSE']);
const USER_CORRECTABLE_JOIN_ERRORS = new Set(['ERROR:NO_STREAM_HOST_FOUND', 'ERROR:WRONG_STREAM_PASSWORD']);

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
        .map((server) => ({ urls: server }));
}

function log(level, message, context = {}) {
    if (window.DD_LOGS && DD_LOGS.logger) {
        DD_LOGS.logger[level](message, context);
    } else {
        console[level](message, context);
    }
}

function ackIgnored(callback, message, socketEvent, classification, context = {}) {
    if (callback) callback({ status: 'OK' });
    log('debug', message, Object.assign({ socket_event: socketEvent, classification }, context));
}

function getConnectErrorStatus(error) {
    const status = typeof error === 'string' ? error : error?.message;
    if (typeof status === 'string') {
        if (status.startsWith('ERROR:TURNSTILE:')) return status;
        if (status.startsWith('ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_') || status.startsWith('ERROR:TOKEN_VERIFICATION_FAILED:TURNSTILE_')) {
            return 'ERROR:TURNSTILE:FAILED';
        }
    }
    return 'WEBRTC_ERROR:CONNECT_ERROR';
}

class HostCandidateBuffer {
    constructor() {
        this.negotiationAttemptId = null;
        this.pending = [];
    }

    enqueue(negotiationAttemptId, candidates) {
        const key = negotiationAttemptId || null;
        if (this.negotiationAttemptId !== key) {
            this.negotiationAttemptId = key;
            this.pending = [];
        }

        for (const candidate of candidates) {
            if (this.pending.length >= MAX_PENDING_HOST_CANDIDATES_PER_ATTEMPT) {
                this.pending.shift();
                log('warn', 'WebRTC.onHostCandidate: Pending host candidate buffer overflow. Dropping oldest candidate.', { socket_event: '[HOST:CANDIDATE]', negotiationAttemptId, limit: MAX_PENDING_HOST_CANDIDATES_PER_ATTEMPT, });
            }
            this.pending.push(candidate);
        }
    }

    shift(negotiationAttemptId) {
        if (this.negotiationAttemptId !== (negotiationAttemptId || null) || this.pending.length === 0) return undefined;
        return this.pending.shift();
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
        this.iceServers = getDefaultIceServers();
        this.hostProtocolVersion = null;
        this.negotiationAttemptId = null;
        this.hostCandidateBuffer = new HostCandidateBuffer();
        this.hostCandidateFlushPromise = null;
        this.hostCandidateFlushPeerConnection = null;
        this.hostOfferTimeout = null;
        this.peerDisconnectedTimeout = null;

        this._isConnecting = false;
        this._timeoutId = null;
        this._lifecycleId = 0;
        this._negotiationToken = 0;
        this._joinToken = 0;
        this.pendingJoinRequest = null;

    }

    hasJoinIntent() {
        return Boolean(this.pendingJoinRequest || this.streamState.isJoiningStream || (this.streamState.isStreamJoined && this.streamState.streamId && this.streamPassword));
    }

    hasLocalMediaProgress() {
        const iceState = this.peerConnection?.iceConnectionState;
        return this.streamState.isStreamRunning || this.peerConnection?.connectionState === 'connected' || iceState === 'connected' || iceState === 'completed';
    }

    sendClientAnswer(answer, negotiationAttemptId, isCurrentNegotiation) {
        const payload = { answer };
        if (negotiationAttemptId) payload.negotiationAttemptId = negotiationAttemptId;

        this.socket.timeout(7000).emit('CLIENT:ANSWER', payload, (error, response) => {
            if (!isCurrentNegotiation()) return;

            if (error) {
                const hasProgress = this.hasLocalMediaProgress();
                const classification = hasProgress ? 'answer_ack_timeout_post_media' : 'answer_ack_timeout_pre_media';
                log(hasProgress ? 'warn' : 'debug', `WebRTC.onHostOffer: [CLIENT:ANSWER] timeout: ${error}`, { classification, negotiationAttemptId, });
                if (!hasProgress) {
                    this.leaveStream(true);
                    this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
                }
            } else if (!response || response.status !== 'OK') {
                log('warn', 'WebRTC.onHostOffer: [CLIENT:ANSWER] error', { socket_event: '[CLIENT:ANSWER]', reason: response?.status || 'ERROR:EMPTY_OR_BAD_DATA', negotiationAttemptId });
                if (!this.hasLocalMediaProgress()) {
                    this.leaveStream(true);
                    this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
                }
            }
        });
    }

    async isServerOnlineAsync() {
        try {
            const response = await fetch('/app/ping');
            return response.status === 204;
        } catch {
            return false;
        }
    }

    async waitForServerOnlineAndConnect() {
        if (this._isConnecting) {
            log('info', 'WebRTC.waitForServerOnlineAndConnect: Already connecting...');
            return;
        }
        if (!this.hasJoinIntent()) return;
        const runId = this._lifecycleId;
        const isCurrent = () => runId === this._lifecycleId && this.hasJoinIntent();
        this._isConnecting = true;

        try {
            const online = await this.isServerOnlineAsync();
            if (!isCurrent()) return;
            this.streamState.isServerAvailable = online;

            if (!online) {
                setTimeout(() => {
                    if (isCurrent()) this.waitForServerOnlineAndConnect();
                }, 3000);
                return;
            }

            const token = await this.getTurnstileTokenAsync(this.clientId);
            if (!isCurrent()) return;
            this.connectSocket(token);
        } catch (error) {
            if (!isCurrent()) return;
            const reason = error?.message || error;
            log('warn', `WebRTC.waitForServerOnlineAndConnect: token error: ${reason}`, { event_name: 'turnstile_result', phase: 'turnstile', result: 'error', reason });
            this.pendingJoinRequest = null;
            this.streamState.isJoiningStream = false;
            this.streamState.error = getConnectErrorStatus(error);
        } finally {
            if (runId === this._lifecycleId) this._isConnecting = false;
        }
    }

    connectSocket(token) {
        this.streamState.isTokenAvailable = true;

        if (typeof io !== 'function') {
            log('warn', 'WebRTC.connectSocket: Socket.IO client is unavailable', { event_name: 'socketio_client_load', reason: 'WEBRTC_ERROR:SOCKET_IO_CLIENT_UNAVAILABLE' });
            this.pendingJoinRequest = null;
            this.streamState.isJoiningStream = false;
            this.streamState.error = 'WEBRTC_ERROR:SOCKET_IO_CLIENT_UNAVAILABLE';
            return;
        }

        if (this.socket) {
            this.streamState.error = 'WEBRTC_ERROR:SOCKET_EXIST';
            return;
        }

        this.socketReconnectCounter += 1;
        log('info', 'WebRTC.connectSocket: connecting socket', { event_name: 'socket_connect_attempt', attempt: this.socketReconnectCounter });

        const socket = io({
            path: '/app/socket',
            transports: ['websocket'],
            auth: { clientToken: token },
            reconnection: false,
        });
        this.socket = socket;

        socket.on('connect', () => {
            if (this.socket !== socket) {
                socket.disconnect();
                return;
            }
            if (!this.hasJoinIntent()) {
                log('info', 'WebRTC.connectSocket: Socket connected without active join intent. Disconnecting.');
                this.disconnectSocket();
                return;
            }
            if (window.DD_LOGS && DD_LOGS.setGlobalContextProperty) {
                DD_LOGS.setGlobalContextProperty('socket', socket.id);
            }

            this.socketReconnectCounter = 0;

            this.streamState.isSocketConnected = true;
            this.streamState.isTokenAvailable = false;
            log('info', 'WebRTC.connectSocket: socket connected', { event_name: 'socket_connect_result', result: 'ok', socket: socket.id });

            if (this.pendingJoinRequest) {
                const { streamId, password } = this.pendingJoinRequest;
                this.pendingJoinRequest = null;
                this.streamState.isJoiningStream = false;
                this.joinStream(streamId, password);
            } else if (this.streamState.isStreamJoined && this.streamState.streamId && this.streamPassword) {
                log('info', 'WebRTC.connectSocket: Socket reconnected. Rejoining stream.', { streamId: this.streamState.streamId });
                this.clearJoinRetry();
                this.streamState.isReconnectMode = true;
                this.joinStream(this.streamState.streamId, this.streamPassword);
            }
        });

        socket.on('disconnect', (reason) => {
            if (this.socket !== socket) return;
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

        socket.on('connect_error', (error) => {
            if (this.socket !== socket) return;
            log('warn', `WebRTC.connectSocket: [connect_error] => ${error.message}`, { event_name: 'socket_connect_result', result: 'error', reason: error.message });

            this.cleanupSocket();

            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
            //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}
            if (this.streamState.isStreamJoined && this.streamState.streamId && this.streamPassword && this.socketReconnectCounter < 10) {
                setTimeout(() => this.waitForServerOnlineAndConnect(), 3000);
            } else {
                this.pendingJoinRequest = null;
                this.streamState.isJoiningStream = false;
                this.streamState.error = getConnectErrorStatus(error);
            }
        });

        socket.on('SOCKET:ERROR', (error, callback) => {
            if (this.socket !== socket) return;
            log('warn', `WebRTC.connectSocket: [SOCKET:ERROR]: ${error.status}`, { reason: error.status });

            // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
            // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
            // SOCKET_CHECK_ERROR:NO_CLIENT_ID
            // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
            // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED
            this.streamState.error = error.status;

            // Server always disconnects socket on this event. 
            this.socketReconnectCounter = 5;

            if (callback) callback({ status: 'OK' });
        });
    }

    disconnectSocket() {
        const socket = this.socket;
        if (!socket) return;
        this.removeStreamSocketListeners();
        socket.off('connect')
            .off('disconnect')
            .off('connect_error')
            .off('SOCKET:ERROR');
        socket.disconnect();
        if (window.DD_LOGS && DD_LOGS.removeGlobalContextProperty) {
            DD_LOGS.removeGlobalContextProperty('socket');
        }
        this.socket = null;
        this.streamState.isSocketConnected = false;
        this.streamState.isTokenAvailable = false;
        this.streamState.isServerAvailable = false;
    }

    cleanupSocket() {
        this.clearJoinRetry();
        clearTimeout(this.hostOfferTimeout);
        clearTimeout(this.peerDisconnectedTimeout);
        this.hostOfferTimeout = null;
        this.peerDisconnectedTimeout = null;
        this.socket = null;
        this.streamState.isSocketConnected = false;
        this.streamState.isServerAvailable = false;
        this.streamState.isTokenAvailable = false;
        if (this.streamState.isStreamJoined) {
            if (this.streamState.streamId && this.streamPassword) {
                this._negotiationToken += 1;
                this._joinToken += 1;
                this.closePeerConnectionOnly();
                this.negotiationAttemptId = null;
                this.streamState.isReconnectMode = true;
                this.streamState.isJoiningStream = false;
                this.streamState.isStreamConnecting = false;
                this.streamState.isStreamRunning = false;
            } else {
                this.leaveStream(false);
            }
        }
    }

    clearJoinRetry() {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
    }

    async joinStream(streamId, password, attempt = 0) {
        this.streamState.error = null;

        if (!isStreamIdValid(streamId)) {
            log('warn', `WebRTC.joinStream: Bad stream id: '${streamId}'`, { streamId });
            this.streamState.error = 'ERROR:WRONG_STREAM_ID';
            return;
        }

        if (!isStreamPasswordValid(password)) {
            log('warn', 'WebRTC.joinStream: Bad stream password');
            this.streamState.error = 'ERROR:WRONG_STREAM_PASSWORD';
            return;
        }

        if (this.streamState.isJoiningStream) {
            log('info', 'WebRTC.joinStream: Already joining stream. Ignoring.');
            return;
        }

        if (!this.streamState.isSocketConnected) {
            log('info', 'WebRTC.joinStream: Socket unavailable. Connecting before join.', { event_name: 'join_deferred', streamId });
            this.pendingJoinRequest = { streamId, password };
            this.streamState.isJoiningStream = true;
            this.waitForServerOnlineAndConnect();
            return;
        }

        if (!this.socket) {
            log('warn', 'WebRTC.joinStream: No socket available');
            this.streamState.error = 'WEBRTC_ERROR:NO_SOCKET_AVAILABLE';
            return;
        }

        this.pendingJoinRequest = { streamId, password };
        this.streamState.isJoiningStream = true;
        this.clearJoinRetry();
        const joinToken = ++this._joinToken;
        const runId = this._lifecycleId;
        const joinSocket = this.socket;
        const isCurrentJoin = () => runId === this._lifecycleId && this.socket === joinSocket && this._joinToken === joinToken;

        try {
            const data = this.clientId + streamId + password;
            const hashBuffer = await window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(data));
            if (!isCurrentJoin() || !this.streamState.isJoiningStream) return;
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const passwordHash = btoa(String.fromCharCode(...hashArray)).replace(/\+/g, '-').replace(/\//g, '_');

            joinSocket.timeout(7000).emit('STREAM:JOIN', { streamId, passwordHash, protocolVersion: PROTOCOL_VERSION }, (error, response) => {
                if (!isCurrentJoin()) return;
                const retryJoinOrSetError = (errorStatus) => {
                    const isTransient = TRANSIENT_JOIN_ERRORS.has(errorStatus);
                    if ((this.streamState.isReconnectMode && isTransient) || (attempt < 3 && isTransient)) {
                        const timeout = Math.min(Math.floor(2000 * (1.1 ** (attempt))), 15_000);
                        log('debug', `WebRTC.joinStream: ${streamId}. Attempt: ${attempt} failed. Attempting to reconnect with ${timeout}ms timeout...`, { streamId });
                        this._timeoutId = setTimeout(() => {
                            if (!isCurrentJoin()) return;
                            this.streamState.isJoiningStream = false;
                            this.joinStream(streamId, password, attempt + 1);
                        }, timeout);
                    } else {
                        this.pendingJoinRequest = null;
                        this.streamState.isJoiningStream = false;
                        if (this.streamState.isReconnectMode && this.streamState.isStreamJoined) {
                            this.leaveStream(false);
                        }
                        this.streamState.error = errorStatus;
                    }
                };

                if (error) {
                    log('debug', `WebRTC.joinStream: [STREAM:JOIN] timeout: ${error}`);
                    retryJoinOrSetError('ERROR:TIMEOUT:STREAM:JOIN');
                    return;
                }
                if (!response || response.status !== 'OK') {
                    const reason = response?.status || 'ERROR:STREAM:JOIN';
                    log(USER_CORRECTABLE_JOIN_ERRORS.has(reason) ? 'info' : 'warn', 'WebRTC.joinStream: [STREAM:JOIN] error', { socket_event: '[STREAM:JOIN]', reason });
                    retryJoinOrSetError(reason);
                    return;
                }
                if (response.protocolVersion !== 1 && response.protocolVersion !== PROTOCOL_VERSION) {
                    log('warn', 'WebRTC.joinStream: [STREAM:JOIN] bad protocolVersion', { socket_event: '[STREAM:JOIN]', reason: 'ERROR:BAD_PROTOCOL_VERSION', protocol_version: response.protocolVersion });
                    retryJoinOrSetError('ERROR:BAD_PROTOCOL_VERSION');
                    return;
                }
                this.pendingJoinRequest = null;
                this.streamState.isJoiningStream = false;
                this.hostProtocolVersion = response.protocolVersion === PROTOCOL_VERSION ? PROTOCOL_VERSION : 1;
                this.streamState.streamId = streamId;
                this.streamPassword = password;
                this.streamState.isStreamJoined = true;
                this.streamState.isReconnectMode = false;
                this.iceServers = response.iceServers?.length ? response.iceServers : getDefaultIceServers();
                this.setupSocketEventListeners(attempt, joinToken);
            });
        } catch (error) {
            if (!isCurrentJoin()) return;
            this.pendingJoinRequest = null;
            this.streamState.isJoiningStream = false;
            log('warn', `WebRTC.joinStream: failed to prepare join request: ${error?.message || error}`, { reason: error?.message || error });
            this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:STREAM_JOIN';
        }
    }

    setupSocketEventListeners(attempt, joinToken) {
        this.removeStreamSocketListeners();

        this.socket.on('STREAM:START', () => {
            this.streamState.isStreamConnecting = true;
            clearTimeout(this.hostOfferTimeout);
            this.hostOfferTimeout = setTimeout(() => {
                if (!this.streamState.isStreamJoined || this.streamState.isStreamRunning) return;
                log('warn', 'WebRTC: [HOST:OFFER] timeout.', { socket_event: '[HOST:OFFER]', streamId: this.streamState.streamId, attempt });
                this.leaveStream(true);
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
            }, 20_000);
        });
        this.socket.on('STREAM:STOP', () => {
            this.stopStream(false);
        });
        this.socket.on('STREAM:REJOIN', () => {
            if (!this.streamState.streamId || !this.streamPassword) return;
            const streamId = this.streamState.streamId;
            const password = this.streamPassword;
            this.stopStream(true);
            this.hostProtocolVersion = null;
            this.removeStreamSocketListeners();
            this.streamState.isReconnectMode = true;
            this.joinStream(streamId, password);
        });
        this.socket.on('REMOVE:CLIENT', (callback) => {
            if (callback) callback({ status: 'OK' });
            this.leaveStream(false);
            this.streamState.error = 'ERROR:CLIENT_REMOVED';
        });
        this.socket.on('REMOVE:STREAM', () => {
            this.leaveStream(false, true);
            this.streamState.error = 'ERROR:STREAM_ENDED';
        });
        this.socket.on('HOST:OFFER', (hostOffer, callback) => {
            if (joinToken !== this._joinToken) {
                ackIgnored(callback, 'WebRTC: stale [HOST:OFFER] ignored', '[HOST:OFFER]', 'stale_join_ignored');
                return;
            }
            this.onHostOffer(hostOffer, callback, attempt);
        });
        this.socket.on('HOST:CANDIDATE', (hostCandidates, callback) => {
            if (joinToken !== this._joinToken) {
                ackIgnored(callback, 'WebRTC: stale [HOST:CANDIDATE] ignored', '[HOST:CANDIDATE]', 'stale_join_ignored');
                return;
            }
            this.onHostCandidate(hostCandidates, callback);
        });
    }

    removeStreamSocketListeners() {
        if (!this.socket) return;
        this.socket.off('STREAM:START')
            .off('STREAM:STOP')
            .off('STREAM:REJOIN')
            .off('REMOVE:CLIENT')
            .off('REMOVE:STREAM')
            .off('HOST:OFFER')
            .off('HOST:CANDIDATE');
    }

    async logSelectedCandidatePair(peerConnection, isCurrentNegotiation) {
        const stats = await peerConnection.getStats();
        if (!isCurrentNegotiation()) return;

        const hasTurnServer = this.iceServers.some((server) => server.urls.startsWith('turn:'));

        stats.forEach((report) => {
            if (report.type !== 'candidate-pair' || report.state !== 'succeeded') return;

            const localCandidate = stats.get(report.localCandidateId);
            const remoteCandidate = stats.get(report.remoteCandidateId);
            if (!localCandidate || !remoteCandidate) return;

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

            log('debug', `WebRTC.onHostOffer: PeerConnection relay protocol: ${relayProtocol}`, { relayProtocol, hasTurnServer, localType, remoteType });
        });
    }

    schedulePeerReconnect(attempt, delayMs = 1000) {
        const streamId = this.streamState.streamId;
        const password = this.streamPassword;
        const reconnectToken = ++this._negotiationToken;

        this.streamState.isStreamRunning = false;
        this.streamState.isReconnectMode = true;
        this._joinToken += 1;
        this.closePeerConnectionOnly();
        this.negotiationAttemptId = null;
        this._timeoutId = setTimeout(() => {
            if (reconnectToken !== this._negotiationToken) return;
            this.joinStream(streamId, password, attempt + 1);
        }, delayMs);
    }

    sendClientCandidate(candidate, isCurrentNegotiation) {
        const candidatePayload = { candidate };
        if (this.negotiationAttemptId) candidatePayload.negotiationAttemptId = this.negotiationAttemptId;

        this.socket.timeout(7000).emit('CLIENT:CANDIDATE', candidatePayload, (error, response) => {
            if (!isCurrentNegotiation()) return;

            if (error) {
                const hasProgress = this.hasLocalMediaProgress();
                const phase = hasProgress ? 'post_media' : 'pre_media';
                log(hasProgress ? 'warn' : 'debug', `WebRTC.onHostOffer: [CLIENT:CANDIDATE] timeout: ${error}`, { classification: 'candidate_timeout_episode', phase, negotiationAttemptId: this.negotiationAttemptId, });
                if (!hasProgress) {
                    this.leaveStream(true);
                    this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
                }
            } else if (!response || response.status !== 'OK') {
                log('warn', 'WebRTC.onHostOffer: [CLIENT:CANDIDATE] error', { socket_event: '[CLIENT:CANDIDATE]', reason: response?.status || 'ERROR:EMPTY_OR_BAD_DATA', negotiationAttemptId: this.negotiationAttemptId });
                if (!this.hasLocalMediaProgress()) {
                    this.leaveStream(true);
                    this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
                }
            }
        });
    }

    async onHostOffer(hostOffer, callback, attempt) {
        if (!hostOffer || typeof hostOffer.offer !== 'string' || hostOffer.offer.length === 0) {
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            log('warn', 'WebRTC.onHostOffer: Error in host offer', { socket_event: '[HOST:OFFER]', reason: 'ERROR:EMPTY_OR_BAD_DATA' });
            if (!this.streamState.isStreamRunning) {
                this.leaveStream(true);
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
            }
            return;
        }

        const hostIsV2 = this.hostProtocolVersion === PROTOCOL_VERSION;
        const offerAttemptId = hostIsV2 && ATTEMPT_ID_PATTERN.test(hostOffer?.negotiationAttemptId) ? hostOffer.negotiationAttemptId : null;
        if (hostIsV2 && !offerAttemptId) {
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            log('warn', 'WebRTC.onHostOffer: Bad negotiationAttemptId', { socket_event: '[HOST:OFFER]', reason: 'BAD_OR_MISSING_NEGOTIATION_ATTEMPT_ID', });
            return;
        }

        if (hostIsV2 && this.negotiationAttemptId && offerAttemptId !== this.negotiationAttemptId) {
            ackIgnored(callback, 'WebRTC.onHostOffer: Ignoring stale offer for different negotiation attempt.', '[HOST:OFFER]', 'stale_attempt_ignored', { activeNegotiationAttemptId: this.negotiationAttemptId, negotiationAttemptId: offerAttemptId, });
            return;
        }

        clearTimeout(this.hostOfferTimeout);
        this.hostOfferTimeout = null;
        this.streamState.isStreamConnecting = true;

        if (this.peerConnection) {
            if (callback) callback({ status: 'OK' });
            log('debug', 'WebRTC.onHostOffer: Ignoring offer while negotiation is active.', { socket_event: '[HOST:OFFER]', activeNegotiationAttemptId: this.negotiationAttemptId, negotiationAttemptId: offerAttemptId, });
            return;
        }

        const nextNegotiationAttemptId = offerAttemptId || (hostIsV2 ? this.negotiationAttemptId : null);
        const nextHostCandidateBufferId = nextNegotiationAttemptId || null;
        if (this.hostCandidateBuffer.negotiationAttemptId !== nextHostCandidateBufferId) this.hostCandidateBuffer.pending = [];
        this.hostCandidateBuffer.negotiationAttemptId = nextHostCandidateBufferId;
        this.negotiationAttemptId = nextNegotiationAttemptId;

        const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
        const negotiationToken = ++this._negotiationToken;
        let peerConnection;
        try {
            peerConnection = new RTCPeerConnection({ bundlePolicy: 'balanced', iceServers: this.iceServers, });
        } catch (error) {
            log('error', 'WebRTC.onHostOffer: Failed to create RTCPeerConnection', { socket_event: '[CLIENT:ANSWER]', error });
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            this.closePeerConnectionOnly();
            if (!this.streamState.isStreamRunning) {
                this.leaveStream(true);
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
            }
            return;
        }

        this.peerConnection = peerConnection;

        const isCurrentNegotiation = () => negotiationToken === this._negotiationToken && this.peerConnection === peerConnection;
        let remoteTrackReceived = false;
        const markStreamRunningIfReady = (reason) => {
            if (!isCurrentNegotiation() || !remoteTrackReceived || this.streamState.isStreamRunning) return;

            const iceState = peerConnection.iceConnectionState;
            const isConnected = peerConnection.connectionState === 'connected' || iceState === 'connected' || iceState === 'completed';
            if (!isConnected) return;

            log('info', 'WebRTC.onHostOffer: Stream media ready.', { event_name: 'webrtc_media_connection', socket_event: '[HOST:OFFER]', result: 'ok', protocol_version: this.hostProtocolVersion, negotiationAttemptId: this.negotiationAttemptId, phase: reason, });
            this.streamState.isStreamConnecting = false;
            this.streamState.isStreamRunning = true;
        };

        peerConnection.oniceconnectionstatechange = async () => {
            if (!isCurrentNegotiation()) return;

            const state = peerConnection.iceConnectionState;
            log('debug', `WebRTC.onHostOffer: PeerConnection: iceConnectionState change to "${state}".`);
            if (state === 'connected' || state === 'completed') {
                await this.logSelectedCandidatePair(peerConnection, isCurrentNegotiation);
                markStreamRunningIfReady(`iceConnectionState:${state}`);
            }
        };

        peerConnection.onconnectionstatechange = () => {
            if (!isCurrentNegotiation()) return;

            const state = peerConnection.connectionState;
            log('debug', `WebRTC.onHostOffer: PeerConnection: connectionState change to "${state}".`);

            if (state === 'connected') {
                clearTimeout(this.peerDisconnectedTimeout);
                this.peerDisconnectedTimeout = null;
                markStreamRunningIfReady('connectionState:connected');
                return;
            }

            if (state === 'disconnected' || state === 'failed') {
                if (this.streamState.isSocketConnected && this.streamState.isServerAvailable && !this.streamState.isReconnectMode) {
                    if (state === 'disconnected') {
                        if (this.peerDisconnectedTimeout) return;
                        const disconnectedToken = this._negotiationToken;
                        this.peerDisconnectedTimeout = setTimeout(() => {
                            this.peerDisconnectedTimeout = null;
                            if (disconnectedToken !== this._negotiationToken || this.peerConnection !== peerConnection || peerConnection.connectionState !== 'disconnected') return;
                            log('info', 'WebRTC.onHostOffer: PeerConnection: disconnected grace expired.');
                            this.schedulePeerReconnect(attempt);
                        }, 8000);
                        return;
                    }
                    clearTimeout(this.peerDisconnectedTimeout);
                    this.peerDisconnectedTimeout = null;
                    log('info', 'WebRTC.onHostOffer: PeerConnection: Attempting to reconnect...');
                    this.schedulePeerReconnect(attempt);
                } else if (!this.streamState.isSocketConnected || !this.streamState.isServerAvailable) {
                    log('info', 'WebRTC.onHostOffer: PeerConnection failed. Stopping stream.');
                    this.leaveStream(true);
                }
            }
        };

        peerConnection.ontrack = (event) => {
            if (!isCurrentNegotiation()) return;
            remoteTrackReceived = true;
            this.onNewTrack(event.track);
            markStreamRunningIfReady('track');
        };

        peerConnection.onicecandidate = (event) => {
            if (!isCurrentNegotiation()) return;

            if (event.candidate && event.candidate.candidate !== '') {
                this.sendClientCandidate(event.candidate.toJSON(), isCurrentNegotiation);
            } else {
                peerConnection.onicecandidate = null;
            }
        };

        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: hostOffer.offer }));
            if (!isCurrentNegotiation()) { if (callback) callback({ status: 'OK' }); return; }
            if (!hostIsV2 && callback) {
                callback({ status: 'OK' });
                callback = null;
            }

            await this.flushPendingHostCandidates(peerConnection, negotiationToken);

            const answer = await peerConnection.createAnswer({ voiceActivityDetection: false });
            await peerConnection.setLocalDescription(answer);
            if (!isCurrentNegotiation()) { if (callback) callback({ status: 'OK' }); return; }
            if (callback) callback({ status: 'OK' });
            this.sendClientAnswer(answer.sdp, this.negotiationAttemptId, isCurrentNegotiation);
        } catch (error) {
            if (!isCurrentNegotiation()) {
                if (callback) callback({ status: 'OK' });
                log('debug', 'WebRTC.onHostOffer: Ignoring stale negotiation error', { socket_event: '[CLIENT:ANSWER]', error });
                return;
            }
            log('error', 'WebRTC.onHostOffer: Error during offer/answer negotiation', { socket_event: '[CLIENT:ANSWER]', error });
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            this.closePeerConnectionOnly();
            if (!this.streamState.isStreamRunning) {
                this.leaveStream(true);
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
            }
        }
    }

    async onHostCandidate(hostCandidates, callback) {
        const hostIsV2 = this.hostProtocolVersion === PROTOCOL_VERSION;
        const candidateAttemptId = hostIsV2 && ATTEMPT_ID_PATTERN.test(hostCandidates?.negotiationAttemptId) ? hostCandidates.negotiationAttemptId : null;
        const hasSingleCandidate = Object.prototype.hasOwnProperty.call(hostCandidates || {}, 'candidate');
        const candidates = Array.isArray(hostCandidates?.candidates) ? hostCandidates.candidates : (hasSingleCandidate ? [hostCandidates.candidate] : null);

        if (!candidates) {
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            log('warn', 'WebRTC.onHostCandidate: Error in host candidates', { socket_event: '[HOST:CANDIDATE]', reason: 'ERROR:EMPTY_OR_BAD_DATA' });
            if (!this.streamState.isStreamRunning) {
                this.leaveStream(true);
                this.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATE';
            }
            return;
        }

        if (hostIsV2 && !candidateAttemptId) {
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            log('warn', 'WebRTC.onHostCandidate: Bad negotiationAttemptId', { socket_event: '[HOST:CANDIDATE]', reason: 'BAD_OR_MISSING_NEGOTIATION_ATTEMPT_ID', });
            return;
        }

        if (hostIsV2 && this.negotiationAttemptId && candidateAttemptId !== this.negotiationAttemptId) {
            ackIgnored(callback, 'WebRTC.onHostCandidate: Ignoring stale candidates for different negotiation attempt.', '[HOST:CANDIDATE]', 'stale_attempt_ignored', {
                activeNegotiationAttemptId: this.negotiationAttemptId,
                negotiationAttemptId: candidateAttemptId,
            });
            return;
        }

        const isEndOfCandidates = (candidate) => candidate === null || candidate === '' || (candidate !== null && typeof candidate === 'object' && candidate.candidate === '');
        const isValidCandidate = (candidate) => isEndOfCandidates(candidate) || (candidate !== null && typeof candidate === 'object' && typeof candidate.candidate === 'string' && (candidate.sdpMid == null || typeof candidate.sdpMid === 'string') && (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex)));
        if (!candidates.every(isValidCandidate)) {
            if (callback) callback({ status: 'ERROR:EMPTY_OR_BAD_DATA' });
            log('warn', 'WebRTC.onHostCandidate: Bad host candidate shape', {
                socket_event: '[HOST:CANDIDATE]',
                reason: 'ERROR:EMPTY_OR_BAD_DATA',
                negotiationAttemptId: candidateAttemptId || this.negotiationAttemptId,
            });
            return;
        }

        if (callback) callback({ status: 'OK' });

        this.hostCandidateBuffer.enqueue(candidateAttemptId, candidates);

        const targetPeerConnection = this.peerConnection;
        if (!targetPeerConnection || !targetPeerConnection.remoteDescription) {
            return;
        }

        await this.flushPendingHostCandidates(targetPeerConnection, this._negotiationToken);
    }

    async flushPendingHostCandidates(peerConnection, negotiationToken) {
        if (this.hostCandidateFlushPromise && this.hostCandidateFlushPeerConnection === peerConnection) {
            return this.hostCandidateFlushPromise;
        }

        const flushPromise = (async () => {
            while (true) {
                if (negotiationToken !== this._negotiationToken || this.peerConnection !== peerConnection) return;
                const pendingCandidate = this.hostCandidateBuffer.shift(this.negotiationAttemptId);
                if (pendingCandidate === undefined) return;
                try {
                    if (pendingCandidate === null || pendingCandidate === '' || pendingCandidate?.candidate === '') {
                        await peerConnection.addIceCandidate(null);
                    } else {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(pendingCandidate));
                    }
                } catch (error) {
                    log('warn', 'WebRTC.flushPendingHostCandidates: Failed to add host candidate', { socket_event: '[HOST:CANDIDATE]', error });
                }
            }
        })();
        this.hostCandidateFlushPromise = flushPromise;
        this.hostCandidateFlushPeerConnection = peerConnection;

        try {
            await flushPromise;
        } finally {
            if (this.hostCandidateFlushPromise === flushPromise) {
                this.hostCandidateFlushPromise = null;
                this.hostCandidateFlushPeerConnection = null;
            }
        }
    }

    closePeerConnectionOnly() {
        this.hostCandidateBuffer = new HostCandidateBuffer();
        this.hostCandidateFlushPromise = null;
        this.hostCandidateFlushPeerConnection = null;
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
    }

    stopStream(invalidateJoin = false) {
        this._lifecycleId += 1;
        this._negotiationToken += 1;
        if (invalidateJoin) this._joinToken += 1;
        this.pendingJoinRequest = null;
        this._isConnecting = false;
        clearTimeout(this.hostOfferTimeout);
        clearTimeout(this.peerDisconnectedTimeout);
        this.hostOfferTimeout = null;
        this.peerDisconnectedTimeout = null;

        this.closePeerConnectionOnly();
        this.negotiationAttemptId = null;

        this.streamState.isJoiningStream = false;
        this.streamState.isStreamConnecting = false;
        this.streamState.isStreamRunning = false;
        this.streamState.isReconnectMode = false;
        this.clearJoinRetry();
    }

    leaveStream(notifyServer = true, forcedByServer = false) {
        const hadStream = this.streamState.isStreamJoined;
        this.stopStream(true);
        this.hostProtocolVersion = null;

        this.removeStreamSocketListeners();

        if (notifyServer && this.socket) {
            this.socket.timeout(7000).emit('STREAM:LEAVE', (error, response) => {
                if (error) {
                    log('debug', `WebRTC.leaveStream: [STREAM:LEAVE] timeout: ${error}`);
                } else if (!response || response.status !== 'OK') {
                    log('warn', 'WebRTC.leaveStream: [STREAM:LEAVE] error', { socket_event: '[STREAM:LEAVE]', reason: response?.status || 'ERROR:EMPTY_OR_BAD_DATA' });
                }
            });
        }

        if (!hadStream) this.disconnectSocket();

        this.streamState.isStreamJoined = false;
        this.streamState.streamId = null;
        this.streamPassword = null;
    }
}
