import { Locales } from './locales.js';
import { WebRTC } from './webrtc.js';

const clientId = generateRandomString(24);
window.DD_LOGS && DD_LOGS.setGlobalContextProperty("clientId", clientId);

const supportedLocales = ['en', 'ru', 'uk'];
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

const UIElements = {
    startContainer: document.getElementById('start-container'),
    streamIdInput: document.getElementById('stream-id'),
    passwordInput: document.getElementById('stream-password'),
    streamJoinButton: document.getElementById('streamJoinButton'),
    joinButtonLoader: document.getElementById('joinButtonLoader'),

    streamError: document.getElementById('stream-error'),

    streamWaitContainer: document.getElementById('stream-wait-container'),
    streamWaitContainerText: document.getElementById('stream-wait-container-text'),

    streamingHeader: document.getElementById('streaming-header'),
    streamingContainerText: document.getElementById('streaming-container-text'),
    videoContainer: document.getElementById('video-container'),
    videoElement: document.getElementById('video-element'),
};

const onBusy = (isBusy) => {
    window.DD_LOGS && DD_LOGS.logger.debug(`onBusy: ${isBusy}`);
    if (isBusy) {
        UIElements.streamJoinButton.style.display = 'none';
        UIElements.joinButtonLoader.style.display = 'block';
    } else {
        UIElements.streamJoinButton.style.display = 'table-cell';
        UIElements.joinButtonLoader.style.display = 'none';
    }
};

const onSocketConnect = (isJoinedToStream) => {
    if (!isJoinedToStream) onBusy(false);
};

const onSocketDisconnect = (isJoinedToStream) => {
    if (!isJoinedToStream) onBusy(true);
};

const onJoinStream = (streamId, streamRunning) => {
    window.DD_LOGS && DD_LOGS.logger.debug(`onJoinStream: streamId=${streamId}, streamRunning=${streamRunning}`);
    window.DD_LOGS && DD_LOGS.setGlobalContextProperty('streamId', streamId);

    UIElements.startContainer.style.display = 'none';

    if (streamRunning) {
        UIElements.streamWaitContainer.style.display = 'none';
        UIElements.streamingHeader.style.display = 'block';
        UIElements.videoContainer.style.display = 'block';
    } else {
        UIElements.streamWaitContainer.style.display = 'block';
        UIElements.streamingHeader.style.display = 'none';
        UIElements.videoContainer.style.display = 'none';
    }

    onBusy(false);

    UIElements.streamWaitContainerText.innerText =
        locales.getTranslationByKey(UIElements.streamWaitContainerText.getAttribute('data-i18n-key')) || 'Waiting for host to start the stream';

    UIElements.streamingContainerText.innerText =
        (locales.getTranslationByKey(UIElements.streamingContainerText.getAttribute('data-i18n-key')) || 'Stream Id: {streamId}').replace('{streamId}', streamId);
};

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

const onShowStream = (track) => {
    window.DD_LOGS && DD_LOGS.logger.debug('onShowStream: Got remote track', { track_id: track.id });

    if (UIElements.videoElement.srcObject != null) {
        UIElements.videoElement.srcObject.addTrack(track);
        return;
    }

    UIElements.videoElement.srcObject = new MediaStream();
    UIElements.videoElement.srcObject.addTrack(track);

    UIElements.videoContainer.style.display = 'block';
    UIElements.streamWaitContainer.style.display = 'none';
    UIElements.streamingHeader.style.display = 'block';

    window.addEventListener('mousemove', streamingContainerOnMouseMove);
    window.addEventListener('touchstart', streamingContainerOnMouseMove);
    window.addEventListener('mouseout', streamingContainerOnMouseOut);
    streamingContainerOnMouseMove();
};

const onHideStream = () => {
    window.DD_LOGS && DD_LOGS.logger.debug('onHideStream');

    if (UIElements.videoElement) {
        if (UIElements.videoElement.srcObject) {
            UIElements.videoElement.srcObject.getTracks().forEach(track => track.stop());
        }
        UIElements.videoElement.srcObject = null;
    }

    clearTimeout(hideTimeout);
    window.removeEventListener('mousemove', streamingContainerOnMouseMove);
    window.removeEventListener('mouseout', streamingContainerOnMouseOut);

    UIElements.videoContainer.style.display = 'none';
    UIElements.streamWaitContainer.style.display = 'block';
    UIElements.streamingHeader.style.display = 'none';
};

const onLeaveStream = (forcedByServer, autoReJoin = false) => {
    window.DD_LOGS && DD_LOGS.logger.debug(`onLeaveStream: forcedByServer=${forcedByServer}, autoReJoin=${autoReJoin}`);
    window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('streamId');

    UIElements.startContainer.style.display = 'block';
    UIElements.streamWaitContainer.style.display = 'none';
    UIElements.streamingHeader.style.display = 'none';
    UIElements.videoContainer.style.display = 'none';

    if (autoReJoin) UIElements.streamJoinButton.click();
};

const onError = (error) => {
    if (error == null) {
        UIElements.streamError.style.display = 'none';
        return;
    }

    window.DD_LOGS && DD_LOGS.logger.error(`onError: ${error}`, { error });

    if (error == 'ERROR:NO_STREAM_HOST_FOUND') {
        onBusy(false);
        UIElements.streamError.innerText = locales.getTranslationByKey(error) || 'Stream not found';
    } else if (error == 'ERROR:WRONG_STREAM_PASSWORD') {
        onBusy(false);
        UIElements.streamError.innerText = locales.getTranslationByKey(error) || 'Wrong stream password';
    } else {
        webRTC.leaveStream(true);
        UIElements.streamError.innerText = (locales.getTranslationByKey('ERROR:UNSPECIFIED') || 'Something went wrong. Reload this page and try again.') + `\n[${error}]`;
        UIElements.streamJoinButton.style.display = 'none';
        UIElements.joinButtonLoader.style.display = 'none';
    }
    UIElements.streamError.style.display = 'block';
};

const webRTC = new WebRTC(clientId, getTurnstileTokenAsync, onSocketConnect, onSocketDisconnect, onJoinStream, onShowStream, onHideStream, onLeaveStream, onError);

document.getElementById('streamLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

document.getElementById('streamWaitLeaveButton').addEventListener('click', (e) => {
    e.preventDefault();
    webRTC.leaveStream(true);
});

UIElements.streamJoinButton.addEventListener('click', async (e) => {
    e.preventDefault();
    const streamId = UIElements.streamIdInput.value;
    const password = UIElements.passwordInput.value;

    window.DD_LOGS && DD_LOGS.logger.debug(`User requested stream: ${streamId}`, { stream_id: streamId });
    onBusy(true);
    onError(null);

    if (!isStreamIdValid(streamId)) {
        window.DD_LOGS && DD_LOGS.logger.warn(`Bad stream id: ${streamId}`, { stream_id: streamId });
        onError('ERROR:NO_STREAM_HOST_FOUND');
        return;
    }

    const buffer = await window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(clientId + streamId + password));
    const passwordHash = window.btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_');
    webRTC.joinStream(streamId, passwordHash, false);
});

window.onloadTurnstileCallback = () => { webRTC.waitForServerOnlineAndConnect(); };
window.addEventListener('beforeunload', () => webRTC.leaveStream(true));

function generateRandomString(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
};