import { Locales } from './locales.js';
import { isStreamIdValid, isStreamPasswordValid, WebRTC } from './webrtc.js';

function log(level, message, context = {}) {
    if (window.DD_LOGS && DD_LOGS.logger) {
        DD_LOGS.logger[level](message, context);
    } else {
        console[level](message, context);
    }
}

const clientId = generateRandomString(24);
const crc = ('00000000' + CRC32(clientId).toString(16).toUpperCase()).slice(-8);
const publicId = crc.substring(0, 4) + "-" + crc.substring(4);

if (window.DD_LOGS && DD_LOGS.setGlobalContextProperty) {
    DD_LOGS.setGlobalContextProperty('clientId', clientId);
    DD_LOGS.setGlobalContextProperty('publicId', publicId);
}

const UIElements = {
    startForm: document.getElementById('startForm'),
    startContainer: document.getElementById('start-container'),
    streamIdInput: document.getElementById('stream-id'),
    passwordInput: document.getElementById('stream-password'),
    streamJoinButton: document.getElementById('streamJoinButton'),
    streamCancelButton: document.getElementById('streamCancelButton'),
    joinProgress: document.getElementById('join-progress'),
    joinStatus: document.getElementById('join-status'),
    turnstileContainer: document.getElementById('turnstile-container'),
    streamJoinCell: document.getElementById('stream-join'),
    streamErrorCell: document.getElementById('stream-error'),
    streamWaitContainer: document.getElementById('stream-wait-container'),
    streamWaitContainerText: document.getElementById('stream-wait-container-text'),
    streamWaitStreamId: document.getElementById('stream-wait-stream-id'),
    streamingHeader: document.getElementById('streaming-header'),
    streamingContainerText: document.getElementById('streaming-container-text'),
    videoContainer: document.getElementById('video-container'),
    videoElement: document.getElementById('video-element'),
};

const TURNSTILE_LOAD_TIMEOUT_MS = 10000;
const USER_CORRECTABLE_UI_ERRORS = new Set([
    'ERROR:WRONG_STREAM_ID',
    'ERROR:NO_STREAM_HOST_FOUND',
    'ERROR:WRONG_STREAM_PASSWORD',
    'ERROR:STREAM_ENDED',
    'ERROR:CLIENT_REMOVED',
    'ERROR:CONNECTION_FAILED'
]);
const ERROR_UI_KEYS = new Map([
    ['ERROR:WRONG_STREAM_ID', 'ERROR:WRONG_STREAM_ID'],
    ['ERROR:NO_STREAM_HOST_FOUND', 'ERROR:NO_STREAM_HOST_FOUND'],
    ['ERROR:WRONG_STREAM_PASSWORD', 'ERROR:WRONG_STREAM_PASSWORD'],
    ['ERROR:STREAM_ENDED', 'ERROR:STREAM_ENDED'],
    ['ERROR:CLIENT_REMOVED', 'ERROR:CLIENT_REMOVED'],
    ['ERROR:WEBRTC_NOT_SUPPORTED', 'ERROR:WEBRTC_NOT_SUPPORTED'],
    ['ERROR:TURNSTILE:200100', 'ERROR:TURNSTILE:200100'],
    ['ERROR:TURNSTILE:SCRIPT_LOAD_FAILED', 'ERROR:TURNSTILE:SCRIPT_LOAD_FAILED'],
    ['ERROR:TURNSTILE:TIMEOUT', 'ERROR:TURNSTILE:TIMEOUT'],
    ['ERROR:TIMEOUT:STREAM:JOIN', 'ERROR:CONNECTION_FAILED'],
    ['ERROR:HOST_SOCKET_DISCONNECTED', 'ERROR:CONNECTION_FAILED'],
    ['ERROR:TIMEOUT_OR_NO_RESPONSE', 'ERROR:CONNECTION_FAILED'],
    ['WEBRTC_ERROR:CONNECT_ERROR', 'ERROR:CONNECTION_FAILED'],
    ['WEBRTC_ERROR:SOCKET_CONNECT_FAILED', 'ERROR:CONNECTION_FAILED'],
    ['WEBRTC_ERROR:SOCKET_IO_CLIENT_UNAVAILABLE', 'ERROR:CONNECTION_FAILED'],
    ['WEBRTC_ERROR:NO_SOCKET_CONNECTED', 'ERROR:CONNECTION_FAILED'],
    ['WEBRTC_ERROR:NO_SOCKET_AVAILABLE', 'ERROR:CONNECTION_FAILED'],
]);
const ERROR_TEXT_FALLBACKS = {
    'ERROR:WEBRTC_NOT_SUPPORTED': 'This web browser does not support WebRTC. Please consider using a different browser.',
    'ERROR:TURNSTILE:200100': 'Incorrect device clock time. Please adjust and reload the page.',
    'ERROR:TURNSTILE:SCRIPT_LOAD_FAILED': 'Security check could not be loaded on this device. Please reload the page or try another browser/device.',
    'ERROR:TURNSTILE:TIMEOUT': 'Security check timed out on this device. Please reload the page or try another browser/device.',
    'ERROR:TURNSTILE:FAILED': 'Security check failed on this device. Please reload the page or try another browser/device.',
    'ERROR:WRONG_STREAM_ID': 'Wrong stream id',
    'ERROR:NO_STREAM_HOST_FOUND': 'Stream not found',
    'ERROR:WRONG_STREAM_PASSWORD': 'Wrong stream password',
    'ERROR:STREAM_ENDED': 'The host ended this stream.',
    'ERROR:CLIENT_REMOVED': 'The host removed this viewer from the stream.',
    'ERROR:CONNECTION_FAILED': 'Reload this page and try again.',
    'ERROR:UNSPECIFIED': 'Something went wrong. Reload this page and try again.',
};

window.streamState = new Proxy({
    isServerAvailable: false,
    isTokenAvailable: false,
    isSocketConnected: false,
    isJoiningStream: false,
    streamId: null,
    isStreamJoined: false,
    isStreamConnecting: false,
    isStreamRunning: false,
    isReconnectMode: false,
    error: null,
}, {
    set(target, key, value) {
        const oldValue = target[key];
        target[key] = value;
        onNewState(key, oldValue, value, target);
        return true;
    }
});

const getTranslation = (key, fallback) => {
    const translated = locales.getTranslationByKey(key);
    return (translated && translated !== `[${key}]`) ? translated : fallback;
};

const getErrorUiKey = (error) => {
    const errorCode = normalizeErrorCode(error);
    if (ERROR_UI_KEYS.has(errorCode)) return ERROR_UI_KEYS.get(errorCode);
    if (errorCode.startsWith('ERROR:TURNSTILE:')) return 'ERROR:TURNSTILE:FAILED';
    if (errorCode.startsWith('ERROR:TIMEOUT:CLIENT:') || errorCode.startsWith('WEBRTC_ERROR:NEGOTIATION_ERROR:')) return 'ERROR:CONNECTION_FAILED';
    return 'ERROR:UNSPECIFIED';
};

const decorateAboutLinks = () => {
    const opensInNewTab = getTranslation('opens-new-tab', 'opens in a new tab');
    document.querySelectorAll('[data-i18n-key="stream-about"] a[href^="https://"]').forEach((link) => {
        const linkText = link.textContent.trim();
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.classList.add('external-link');
        if (linkText) link.setAttribute('aria-label', `${linkText} (${opensInNewTab})`);
        if (link.querySelector('.external-link-icon')) return;
        link.insertAdjacentHTML('beforeend', '<svg class="external-link-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 3h8v8h-1.5V5.56l-7.47 7.47-1.06-1.06 7.47-7.47H5V3Z"/><path d="M3.5 4.5H2v9.5h9.5v-1.5h-8v-8Z"/></svg>');
    });
};

const normalizeErrorCode = (error) => {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message || error.name || 'ERROR:UNSPECIFIED';
    if (error && typeof error === 'object') return error.status || error.message || error.error || 'ERROR:UNSPECIFIED';
    return 'ERROR:UNSPECIFIED';
};

const setDataFromUrlParams = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const streamId = urlParams.get('id');
    if (isStreamIdValid(streamId)) {
        UIElements.streamIdInput.value = streamId;

        const streamPassword = urlParams.get('p');
        if (isStreamPasswordValid(streamPassword)) {
            UIElements.passwordInput.value = streamPassword;
        }
    }
};

const getStartupCompatibilityError = () => {
    const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
    if (typeof RTCPeerConnection === 'undefined') return 'ERROR:WEBRTC_NOT_SUPPORTED';
    if (!window.crypto || typeof window.crypto.subtle === 'undefined') return 'ERROR:WEBRTC_NOT_SUPPORTED';
    return null;
};

const startTurnstileLoadWatchdog = () => {
    setTimeout(() => {
        if (window.__turnstileScriptStatus === 'loaded' || window.__turnstileScriptStatus === 'failed') return;
        log('warn', 'Turnstile script load timeout', { event_name: 'turnstile_script_load', phase: 'script', result: 'timeout', reason: 'ERROR:TURNSTILE:SCRIPT_LOAD_TIMEOUT' });
    }, TURNSTILE_LOAD_TIMEOUT_MS);
};

const supportedLocales = ['zh-TW', 'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];
const locales = new Locales(supportedLocales, navigator.languages);

const initialize = () => {
    locales.translateDocument();
    decorateAboutLinks();
    document.getElementById('client-id').innerText = publicId;
    const clientIdText = `${getTranslation('client-id', 'Client ID:')} ${publicId}`;
    document.getElementById('streaming-client-id').innerText = clientIdText;
    document.getElementById('stream-wait-client-id').innerText = clientIdText;
    setDataFromUrlParams();
    const startupCompatibilityError = getStartupCompatibilityError();
    if (startupCompatibilityError) {
        window.streamState.error = startupCompatibilityError;
        return;
    }
    startTurnstileLoadWatchdog();
};

locales.fetchTranslation().catch(error => {
    log('warn', `Error fetching translations: ${error.message}`, { reason: error.message });
}).finally(() => {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
});

let hideTimeout = null;

const streamingContainerOnMouseMove = () => {
    UIElements.streamingHeader.className = 'visible';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
        UIElements.streamingHeader.className = 'hidden';
    }, 2500);
};

const streamingContainerOnMouseOut = () => {
    clearTimeout(hideTimeout);
    UIElements.streamingHeader.className = 'hidden';
};

const renderState = (state) => {
    if (state.streamId) {
        if (window.DD_LOGS && DD_LOGS.setGlobalContextProperty) {
            DD_LOGS.setGlobalContextProperty('streamId', state.streamId);
        }
    } else if (window.DD_LOGS && DD_LOGS.removeGlobalContextProperty) {
        DD_LOGS.removeGlobalContextProperty('streamId');
    }

    UIElements.startContainer.style.display = (state.error || !state.isStreamJoined) ? 'block' : 'none';
    UIElements.streamWaitContainer.style.display = (!state.error && state.isStreamJoined && !state.isStreamRunning) ? 'block' : 'none';
    UIElements.streamingHeader.style.display = (!state.error && state.isStreamRunning) ? 'block' : 'none';
    UIElements.videoContainer.style.display = (!state.error && state.isStreamRunning) ? 'block' : 'none';

    const isJoining = !state.error && state.isJoiningStream;
    UIElements.streamJoinCell.className = isJoining ? 'joining' : '';
    UIElements.joinProgress.style.display = isJoining ? 'flex' : 'none';
    const hasActiveTurnstileTokenFlow = UIElements.turnstileContainer.children.length > 0 || typeof window.__activeTurnstileCancel === 'function';
    if (!isJoining && hasActiveTurnstileTokenFlow && typeof window.clearTurnstileTokenWidget === 'function') {
        window.clearTurnstileTokenWidget();
    }
    UIElements.joinStatus.innerText = (state.isServerAvailable && !state.isTokenAvailable && !state.isSocketConnected)
        ? getTranslation('stream-verifying', 'Verifying...')
        : getTranslation('stream-connecting', 'Connecting...');

    UIElements.streamJoinButton.style.display = (!state.isJoiningStream) ? 'inline-block' : 'none';

    UIElements.streamErrorCell.style.display = (state.error) ? 'block' : 'none';

    if (state.error) {
        const uiErrorKey = getErrorUiKey(state.error);
        const isUserCorrectableError = USER_CORRECTABLE_UI_ERRORS.has(uiErrorKey);
        UIElements.streamErrorCell.innerText = getTranslation(uiErrorKey, ERROR_TEXT_FALLBACKS[uiErrorKey] || ERROR_TEXT_FALLBACKS['ERROR:UNSPECIFIED']);

        UIElements.streamJoinCell.style.display = isUserCorrectableError ? '' : 'none';
        return;
    }

    UIElements.streamJoinCell.style.display = '';

    if (state.isStreamJoined) {
        UIElements.streamWaitContainerText.innerText = state.isReconnectMode
            ? getTranslation('stream-reconnecting', 'Reconnecting to stream...')
            : state.isStreamConnecting
                ? getTranslation('stream-connecting-stream', 'Connecting to stream...')
                : getTranslation('stream-waiting', 'Waiting for host to start the stream');
        UIElements.streamWaitStreamId.innerText = getTranslation(UIElements.streamWaitStreamId.getAttribute('data-i18n-key'), 'Stream Id: {streamId}').replace('{streamId}', state.streamId);

        UIElements.streamingContainerText.innerText = getTranslation(UIElements.streamingContainerText.getAttribute('data-i18n-key'), 'Stream Id: {streamId}').replace('{streamId}', state.streamId);
    }
};

const onNewState = (key, oldValue, newValue, state) => {
    if (newValue === oldValue) return;

    if (key === 'error' && state.error) {
        const rawErrorCode = normalizeErrorCode(state.error);
        const uiErrorKey = getErrorUiKey(state.error);
        log(USER_CORRECTABLE_UI_ERRORS.has(uiErrorKey) ? 'info' : 'warn', `onNewState.error: ${rawErrorCode}`, { reason: rawErrorCode, ui_error_key: uiErrorKey });
    }

    renderState(state);

    if (key === 'isStreamRunning') {
        if (state.isStreamRunning) {
            window.addEventListener('mousemove', streamingContainerOnMouseMove);
            window.addEventListener('touchstart', streamingContainerOnMouseMove);
            window.addEventListener('mouseout', streamingContainerOnMouseOut);
            streamingContainerOnMouseMove();
        } else {
            if (UIElements.videoElement && UIElements.videoElement.srcObject) {
                UIElements.videoElement.srcObject.getTracks().forEach(track => track.stop());
                UIElements.videoElement.srcObject = null;
            }

            clearTimeout(hideTimeout);
            window.removeEventListener('mousemove', streamingContainerOnMouseMove);
            window.removeEventListener('touchstart', streamingContainerOnMouseMove);
            window.removeEventListener('mouseout', streamingContainerOnMouseOut);
        }
    }
};

renderState(window.streamState);

const onNewTrack = (track) => {
    let mediaStream = UIElements.videoElement.srcObject;
    if (!mediaStream) {
        mediaStream = new MediaStream();
        UIElements.videoElement.srcObject = mediaStream;
    }

    const tracks = mediaStream.getTracks();
    tracks.filter(existingTrack => existingTrack.kind === track.kind && existingTrack.id !== track.id)
        .forEach(existingTrack => {
            mediaStream.removeTrack(existingTrack);
            existingTrack.stop();
        });

    if (!tracks.some(existingTrack => existingTrack.id === track.id)) {
        mediaStream.addTrack(track);
    }
};

const webRTC = new WebRTC(clientId, window.streamState, window.getTurnstileTokenAsync, onNewTrack);

document.getElementById('streamLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

document.getElementById('streamWaitLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

UIElements.streamCancelButton.addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(false);
});

UIElements.startForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!UIElements.startForm.reportValidity()) return;
    log('info', 'WebRTC.joinStream: user submitted join form', { event_name: 'join_submit', streamId: UIElements.streamIdInput.value });
    webRTC.joinStream(UIElements.streamIdInput.value, UIElements.passwordInput.value);
});

window.onloadTurnstileCallback = () => {
    window.__turnstileScriptStatus = 'loaded';
    window.dispatchEvent(new Event('turnstile-script-loaded'));
    log('info', 'Turnstile script loaded', { event_name: 'turnstile_script_load', phase: 'script', result: 'ok' });
    if (window.streamState.error) return;
    const startupCompatibilityError = getStartupCompatibilityError();
    if (startupCompatibilityError) {
        window.streamState.error = startupCompatibilityError;
    }
};

window.onTurnstileScriptError = () => {
    window.__turnstileScriptStatus = 'failed';
    window.dispatchEvent(new Event('turnstile-script-failed'));
    log('warn', 'Turnstile script failed to load', { event_name: 'turnstile_script_load', phase: 'script', result: 'error', reason: 'ERROR:TURNSTILE:SCRIPT_LOAD_FAILED' });
};

window.addEventListener('beforeunload', () => {
    webRTC.leaveStream(false);
});

function generateRandomString(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let result = '';
    const array = new Uint8Array(length);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(array);
    } else {
        for (let i = 0; i < length; i++) {
            array[i] = Math.floor(Math.random() * 256);
        }
    }

    for (let i = 0; i < length; i++) {
        result += characters.charAt(array[i] % charactersLength);
    }

    return result;
}

function CRC32(r) { for (var a, o = [], c = 0; c < 256; c++) { a = c; for (var f = 0; f < 8; f++)a = 1 & a ? 3988292384 ^ a >>> 1 : a >>> 1; o[c] = a } for (var n = -1, t = 0; t < r.length; t++)n = n >>> 8 ^ o[255 & (n ^ r.charCodeAt(t))]; return (-1 ^ n) >>> 0 };
