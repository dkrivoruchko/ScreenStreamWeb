import { Locales } from './locales.js';
import { StreamState, WebRTC } from './webrtc.js';

const clientId = generateRandomString(24);
window.DD_LOGS && DD_LOGS.setGlobalContextProperty('clientId', clientId);

const UIElements = {
    startContainer: document.getElementById('start-container'),
    streamIdInput: document.getElementById('stream-id'),
    passwordInput: document.getElementById('stream-password'),
    streamJoinButton: document.getElementById('streamJoinButton'),
    joinButtonLoader: document.getElementById('joinButtonLoader'),

    streamJoinCell: document.getElementById('stream-join'),
    streamErrorCell: document.getElementById('stream-error'),

    streamWaitContainer: document.getElementById('stream-wait-container'),
    streamWaitContainerText: document.getElementById('stream-wait-container-text'),

    streamingHeader: document.getElementById('streaming-header'),
    streamingContainerText: document.getElementById('streaming-container-text'),
    videoContainer: document.getElementById('video-container'),
    videoElement: document.getElementById('video-element'),
};

const isStreamIdValid = (id) => typeof id === 'string' && /^\d+$/.test(id) && id.length === 8
const isStreamPasswordValid = (password) => typeof password === 'string' && /^[a-zA-Z0-9]+$/.test(password) && password.length === 6
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
}

const supportedLocales = ['zh-TW', 'ar', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];
const locales = new Locales(supportedLocales, navigator.languages);
window.DD_LOGS && DD_LOGS.logger.debug(`Browser locales: [${navigator.languages}], using locale: ${locales.selectedLocale}`);
locales.fetchTranslation().then(() => {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            locales.translateDocument();
            setDataFromUrlParams();
        });
    } else {
        locales.translateDocument();
        setDataFromUrlParams();
    }
});

const streamState = new Proxy(new StreamState(), {
    set: function (target, key, value) {
        const oldValue = target[key];
        target[key] = value;
        onNewState(key, oldValue, value, target);
        return true;
    }
});

let hideTimeout = null;

const streamingContainerOnMouseMove = () => {
    UIElements.streamingHeader.className = 'visible';
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => { UIElements.streamingHeader.className = 'hidden'; }, 2500);
};

const streamingContainerOnMouseOut = () => {
    clearTimeout(hideTimeout);
    UIElements.streamingHeader.className = 'hidden';
};

const onNewState = (key, oldValue, newValue, state) => {
    if (newValue === oldValue) return;
    window.DD_LOGS && DD_LOGS.logger.debug(`onNewState: [${key}] ${oldValue} => ${newValue}\n${JSON.stringify(state)}`);

    if (key === 'error' && state.error) {
        window.DD_LOGS && DD_LOGS.logger.warn(`onNewState.error: ${state.error}`, { error: state.error });
    }
    if (key === 'streamId') {
        if (state.streamId) window.DD_LOGS && DD_LOGS.setGlobalContextProperty('streamId', state.streamId);
        else window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('streamId');
    }

    UIElements.startContainer.style.display = (!state.isStreamJoined) ? 'block' : 'none';
    UIElements.streamWaitContainer.style.display = (state.isStreamJoined && !state.isStreamRunning) ? 'block' : 'none';
    UIElements.streamingHeader.style.display = (state.isStreamRunning) ? 'block' : 'none';
    UIElements.videoContainer.style.display = (state.isStreamRunning) ? 'block' : 'none';

    UIElements.joinButtonLoader.style.display = (!state.isServerAvailable || (state.isServerAvailable && state.isTokenAvailable) || state.isJoiningStream) ? 'block' : 'none';

    UIElements.streamJoinButton.style.display = (state.isSocketConnected && !state.isJoiningStream) ? 'table-cell' : 'none';

    UIElements.streamErrorCell.style.display = (state.error) ? 'block' : 'none';

    if (state.error) {
        if (state.error == 'ERROR:WRONG_STREAM_ID') {
            UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Wrong stream id';
        } else if (state.error == 'ERROR:NO_STREAM_HOST_FOUND') {
            UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Stream not found';
        } else if (state.error == 'ERROR:WRONG_STREAM_PASSWORD') {
            UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Wrong stream password';
        } else {
            UIElements.streamErrorCell.innerText = (locales.getTranslationByKey('ERROR:UNSPECIFIED') || 'Something went wrong. Reload this page and try again.') + `\n[${state.error}]\n\n`;
            UIElements.streamJoinCell.style.display = 'none';
            UIElements.streamJoinButton.style.display = 'none';
            UIElements.joinButtonLoader.style.display = 'none';
        }
    }

    if (key === 'isStreamJoined' && state.isStreamJoined) {
        UIElements.streamWaitContainerText.innerText =
            locales.getTranslationByKey(UIElements.streamWaitContainerText.getAttribute('data-i18n-key')) || 'Waiting for host to start the stream';
        UIElements.streamingContainerText.innerText =
            (locales.getTranslationByKey(UIElements.streamingContainerText.getAttribute('data-i18n-key')) || 'Stream Id: {streamId}').replace('{streamId}', state.streamId);
    }

    if (key === 'isStreamRunning') {
        if (state.isStreamRunning) {
            window.addEventListener('mousemove', streamingContainerOnMouseMove);
            window.addEventListener('touchstart', streamingContainerOnMouseMove);
            window.addEventListener('mouseout', streamingContainerOnMouseOut);
            streamingContainerOnMouseMove();
        } else {
            if (UIElements.videoElement) {
                if (UIElements.videoElement.srcObject) {
                    UIElements.videoElement.srcObject.getTracks().forEach(track => track.stop());
                }
                UIElements.videoElement.srcObject = null;
            }

            clearTimeout(hideTimeout);
            window.removeEventListener('mousemove', streamingContainerOnMouseMove);
            window.removeEventListener('touchstart', streamingContainerOnMouseMove);
            window.removeEventListener('mouseout', streamingContainerOnMouseOut);
        }
    }
}

const onNewTrack = (track) => {
    window.DD_LOGS && DD_LOGS.logger.debug(`onNewTrack: ${track.id}`, { track_id: track.id });

    if (!UIElements.videoElement.srcObject) {
        UIElements.videoElement.srcObject = new MediaStream();
    }

    UIElements.videoElement.srcObject.addTrack(track);
};

const webRTC = new WebRTC(clientId, streamState, window.getTurnstileTokenAsync, onNewTrack);

document.getElementById('streamLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

document.getElementById('streamWaitLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

UIElements.streamJoinButton.addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.joinStream(UIElements.streamIdInput.value, UIElements.passwordInput.value);
});

window.onloadTurnstileCallback = () => { webRTC.waitForServerOnlineAndConnect(); };

window.addEventListener('beforeunload', () => webRTC.leaveStream(false));

function generateRandomString(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
};

// const parseArabic = (str) => {
//     return Number(str
//         .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => d.charCodeAt(0) - 1632) // convert Arabic digits
//         .replace(/[۰۱۲۳۴۵۶۷۸۹]/g, d => d.charCodeAt(0) - 1776) // convert Persian digits
//     );
// }