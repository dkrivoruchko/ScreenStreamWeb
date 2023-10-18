/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
var __webpack_exports__ = {};

;// CONCATENATED MODULE: ./src/client/static/src/locales.js
function Locales(supportedTags, browserLanguages) {
  this.selectedLocale = this.lookup(supportedTags, browserLanguages);
  this.defaultLocale = 'en';
  this.translations = {};
  this.defaultTranslations = {};
}
Locales.prototype.fetchTranslation = function () {
  var _this = this;
  return new Promise(function (resolve, reject) {
    fetch("/lang/".concat(_this.selectedLocale, ".json")).then(function (response) {
      return response.json();
    }).then(function (translations) {
      _this.translations = translations;
      if (_this.selectedLocale === _this.defaultLocale) {
        resolve();
        return;
      }
      fetch("/lang/".concat(_this.defaultLocale, ".json")).then(function (response) {
        return response.json();
      }).then(function (defaultTranslations) {
        _this.defaultTranslations = defaultTranslations;
        resolve();
      })["catch"](function (error) {
        window.DD_LOGS && DD_LOGS.logger.warn("Locales: fetchDefaultTranslation for ".concat(_this.defaultLocale, " failed: ").concat(error.message), {
          error: error
        });
        reject(error);
      });
    })["catch"](function (error) {
      window.DD_LOGS && DD_LOGS.logger.warn("Locales: fetchTranslation for ".concat(_this.selectedLocale, " failed: ").concat(error.message), {
        error: error
      });
      reject(error);
    });
  });
};
Locales.prototype.getTranslationByKey = function (key) {
  return this.translations[key] || this.defaultTranslations[key];
};
Locales.prototype.translateDocument = function () {
  var _this2 = this;
  document.querySelectorAll('[data-i18n-key]').forEach(function (element) {
    var value = _this2.getTranslationByKey(element.getAttribute('data-i18n-key'));
    if (value) element.innerHTML = value;
  });
};
Locales.prototype.lookup = function (tags, right) {
  var check = function check(tag, range) {
    var right = range;
    while (true) {
      if (right === '*' || tag === right) return true;
      var index = right.lastIndexOf('-');
      if (index < 0) return false;
      if (right.charAt(index - 2) === '-') index -= 2;
      right = right.slice(0, index);
    }
  };
  var left = tags;
  var rightIndex = -1;
  while (++rightIndex < right.length) {
    var range = right[rightIndex].toLowerCase();
    var leftIndex = -1;
    var next = [];
    while (++leftIndex < left.length) {
      if (check(left[leftIndex].toLowerCase(), range)) {
        return left[leftIndex];
      } else {
        next.push(left[leftIndex]);
      }
    }
    left = next;
  }
  return this.defaultLocale;
};
;// CONCATENATED MODULE: ./src/client/static/src/webrtc.js
var isStreamIdValid = function isStreamIdValid(id) {
  return typeof id === 'string' && /^\d+$/.test(id) && id.length === 8;
};
var isStreamPasswordValid = function isStreamPasswordValid(password) {
  return typeof password === 'string' && /^[a-zA-Z0-9]+$/.test(password) && password.length === 6;
};
function WebRTC(clientId, streamState, getTurnstileTokenAsync, onNewTrack) {
  this.clientId = clientId;
  this.streamState = streamState;
  this.getTurnstileTokenAsync = getTurnstileTokenAsync;
  this.onNewTrack = onNewTrack;
  this.socket = null;
  this.socketReconnectCounter = 0;
  this.peerConnection = null;
  this.hostOfferTimeout = null;
  this.iceServers = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'];
  window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.constructor');
}
;
WebRTC.prototype.isServerOnlineAsync = function () {
  return new Promise(function (resolve) {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.isServerOnlineAsync');
    fetch('/app/ping').then(function (response) {
      return resolve(response.status === 204);
    })["catch"](function () {
      return resolve(false);
    });
  });
};
WebRTC.prototype.waitForServerOnlineAndConnect = function () {
  var _this = this;
  window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.waitForServerOnlineAndConnect');
  this.isServerOnlineAsync().then(function (online) {
    _this.streamState.isServerAvailable = online;
    if (online) {
      _this.getTurnstileTokenAsync(_this.clientId).then(function (token) {
        return _this.connectSocket(token);
      })["catch"](function (error) {
        return _this.streamState.error = error;
      });
    } else {
      setTimeout(function () {
        return _this.waitForServerOnlineAndConnect();
      }, 3000);
    }
  });
};
WebRTC.prototype.connectSocket = function (token) {
  var _this2 = this;
  window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket');
  this.streamState.isTokenAvailable = true;
  if (this.socket) {
    this.streamState.error = 'WEBRTC_ERROR:SOCKET_EXIST';
    return;
  }
  this.socketReconnectCounter += 1;
  window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.connectSocket: Attempt: ".concat(this.socketReconnectCounter));
  this.socket = io({
    path: '/app/socket',
    transports: ['websocket'],
    auth: {
      clientToken: token
    },
    reconnection: false
  });
  this.socket.on('connect', function () {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.connectSocket: connect');
    window.DD_LOGS && DD_LOGS.setGlobalContextProperty('socket', _this2.socket.id);
    _this2.socketReconnectCounter = 0;
    _this2.streamState.isSocketConnected = true;
    _this2.streamState.isTokenAvailable = false;
  });
  this.socket.on('disconnect', function (reason) {
    window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.connectSocket: [disconnect] => ".concat(reason));
    window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('socket');
    _this2.socket = null;
    _this2.streamState.isSocketConnected = false;
    _this2.streamState.isServerAvailable = false;
    _this2.streamState.isTokenAvailable = false;
    if (_this2.streamState.isStreamJoined && !_this2.streamState.isStreamRunning) _this2.leaveStream(false);
    if (_this2.socketReconnectCounter >= 5) {
      window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.connectSocket: failed after [".concat(_this2.socketReconnectCounter, "] attempts. Give up."));
      _this2.streamState.error = 'WEBRTC_ERROR:SOCKET_CONNECT_FAILED';
    } else {
      setTimeout(function () {
        return _this2.waitForServerOnlineAndConnect();
      }, 3000);
    }
  });
  this.socket.on('connect_error', function (error) {
    window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.connectSocket: [connect_error] => ".concat(error.message), {
      error: error.message
    });
    _this2.socket = null;
    _this2.streamState.isSocketConnected = false;
    _this2.streamState.isServerAvailable = false;
    _this2.streamState.isTokenAvailable = false;
    if (_this2.streamState.isStreamJoined && !_this2.streamState.isStreamRunning) _this2.leaveStream(false);

    //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}
    //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}
    //ERROR:TOKEN_VERIFICATION_FAILED:TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}
    _this2.streamState.error = error.message;
  });
  this.socket.on('SOCKET:ERROR', function (error, callback) {
    window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.connectSocket: [SOCKET:ERROR]: ' + error.status, {
      error: error.status
    });

    // SOCKET_CHECK_ERROR:UNVERIFIED_SOCKET
    // SOCKET_CHECK_ERROR:INVALID_SOCKET_STATE
    // SOCKET_CHECK_ERROR:NO_CLIENT_ID
    // SOCKET_CHECK_ERROR:UNKNOWN_CLIENT_EVENT
    // SOCKET_CHECK_ERROR:ERROR_LIMIT_REACHED
    _this2.streamState.error = error.status;

    // Server always disconnects socket on this event. To disable reconnect
    _this2.socketReconnectCounter = 5;
    callback({
      status: 'OK'
    });
  });
};
WebRTC.prototype.joinStream = function (streamId, password) {
  var _this3 = this;
  this.streamState.error = null;
  if (!isStreamIdValid(streamId)) {
    window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.joinStream: Bad stream id: '".concat(streamId, "'"), {
      streamId: streamId
    });
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
  window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.joinStream: ".concat(streamId), {
    streamId: streamId
  });
  this.streamState.isJoiningStream = true;
  window.crypto.subtle.digest('SHA-384', new TextEncoder().encode(this.clientId + streamId + password)).then(function (buffer) {
    var passwordHash = window.btoa(String.fromCharCode.apply(null, new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_');
    _this3.socket.timeout(5000).emit('STREAM:JOIN', {
      streamId: streamId,
      passwordHash: passwordHash
    }, function (error, response) {
      if (error) {
        window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.joinStream: [STREAM:JOIN] timeout: ".concat(error));
        _this3.streamState.isJoiningStream = false;
        _this3.streamState.error = 'ERROR:TIMEOUT:STREAM:JOIN';
        return;
      }
      if (!response || !response.status || response.status !== 'OK') {
        window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.joinStream ".concat(streamId, ": [STREAM:JOIN] error: ").concat(JSON.stringify(response)), {
          socket_event: '[STREAM:JOIN]',
          error: response
        });
        _this3.streamState.isJoiningStream = false;
        _this3.streamState.error = response.status;
        return;
      }
      window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.joinStream: [STREAM:JOIN] OK', {
        socket_event: '[STREAM:JOIN]'
      });
      _this3.streamState.isJoiningStream = false;
      _this3.streamState.streamId = streamId;
      _this3.streamState.isStreamJoined = true;
      _this3.socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM').on('STREAM:START', function () {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:START]', {
          socket_event: '[STREAM:START]'
        });
        _this3.startStream();
      }).on('STREAM:STOP', function () {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [STREAM:STOP]', {
          socket_event: '[STREAM:STOP]'
        });
        _this3.stopStream();
      }).on('REMOVE:CLIENT', function (callback) {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [REMOVE:CLIENT]', {
          socket_event: '[REMOVE:CLIENT]'
        });
        callback({
          status: 'OK'
        });
        _this3.leaveStream(false);
      }).on('REMOVE:STREAM', function () {
        window.DD_LOGS && DD_LOGS.logger.debug('WebRTC: receive [REMOVE:STREAM]', {
          socket_event: '[REMOVE:STREAM]'
        });
        _this3.leaveStream(false, true);
      });
    });
  })["catch"](function (error) {
    return _this3.streamState.error = error;
  });
};
WebRTC.prototype.startStream = function () {
  var _this4 = this;
  window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream');
  if (this.peerConnection) {
    window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: PeerConnection exist. Cleaning it first.');
    this.stopStream();
  }
  var RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
  this.peerConnection = new RTCPeerConnection({
    bundlePolicy: 'balanced',
    iceServers: [{
      urls: this.iceServers.sort(function () {
        return .5 - Math.random();
      }).slice(0, 2)
    }]
  });
  this.hostOfferTimeout = setTimeout(function () {
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: HOST:OFFER timeout. Leaving stream.');
    _this4.leaveStream(true);
  }, 5000);
  this.peerConnection.onconnectionstatechange = function (event) {
    if (_this4.peerConnection.connectionState === 'disconnected') {
      //TODO Try silent reconnect
      window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: PeerConnection state change to "disconnected". Stopping stream.');
      _this4.leaveStream(true);
    }
  };
  this.peerConnection.ontrack = function (event) {
    _this4.onNewTrack(event.track);
    _this4.streamState.isStreamRunning = true;
  };
  this.peerConnection.onicecandidate = function (event) {
    if (event.candidate) {
      _this4.socket.timeout(5000).emit('CLIENT:CANDIDATE', {
        candidate: event.candidate.toJSON()
      }, function (error, response) {
        if (error) {
          window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.startStream: [CLIENT:CANDIDATE] timeout: ".concat(error));
          _this4.streamState.error = 'ERROR:TIMEOUT:CLIENT:CANDIDATE';
        } else if (!response || !response.status || response.status !== 'OK') {
          window.DD_LOGS && DD_LOGS.logger.info("WebRTC.startStream: Error: ".concat(JSON.stringify(response)), {
            socket_event: '[CLIENT:CANDIDATE]',
            error: response
          });
          _this4.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_CANDIDATE';
        } else {
          window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:CANDIDATE] send OK', {
            socket_event: '[CLIENT:CANDIDATE]'
          });
        }
      });
    } else {
      _this4.peerConnection.onicecandidate = undefined;
    }
  };
  this.socket.on('HOST:CANDIDATE', function (hostCandidates, callback) {
    if (!hostCandidates || !hostCandidates.candidates) {
      callback({
        status: 'ERROR:EMPTY_OR_BAD_DATA'
      });
      window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host candidates', {
        socket_event: '[HOST:CANDIDATE]',
        error: 'ERROR:EMPTY_OR_BAD_DATA',
        hostCandidate: hostCandidates.candidates
      });
      _this4.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_CANDIDATE';
      return;
    }
    callback({
      status: 'OK'
    });
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:CANDIDATE]', {
      socket_event: '[HOST:CANDIDATE]'
    });
    hostCandidates.candidates.forEach(function (candidate) {
      return _this4.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    });
  });
  this.socket.once('HOST:OFFER', function (hostOffer, callback) {
    clearTimeout(_this4.hostOfferTimeout);
    _this4.hostOfferTimeout = null;
    if (!hostOffer || !hostOffer.offer) {
      callback({
        status: 'ERROR:EMPTY_OR_BAD_DATA'
      });
      window.DD_LOGS && DD_LOGS.logger.warn('WebRTC.startStream: Error in host offer', {
        socket_event: '[HOST:OFFER]',
        error: 'ERROR:EMPTY_OR_BAD_DATA',
        offer: JSON.stringify(hostOffer)
      });
      _this4.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:HOST_OFFER';
      return;
    }
    callback({
      status: 'OK'
    });
    window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: receive [HOST:OFFER]', {
      socket_event: '[HOST:OFFER]'
    });
    try {
      var hostCodecs = JSON.stringify(hostOffer.offer.split("\n").filter(function (line) {
        return line.startsWith("a=rtpmap:");
      }).map(function (line) {
        return line.split(" ")[1].slice(0, -1);
      }));
      window.DD_LOGS && DD_LOGS.logger.warn("HostCodecs: ".concat(hostCodecs), {
        hostCodecs: hostCodecs
      });
    } catch (e) {
      window.DD_LOGS && DD_LOGS.logger.warn("HostCodecs: ".concat(e.message), e);
    }
    _this4.peerConnection.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: hostOffer.offer
    })).then(function () {
      return _this4.peerConnection.createAnswer({
        voiceActivityDetection: false
      });
    }).then(function (answer) {
      try {
        var clientCodecs = JSON.stringify(answer.sdp.split("\n").filter(function (line) {
          return line.startsWith("a=rtpmap:");
        }).map(function (line) {
          return line.split(" ")[1].slice(0, -1);
        }));
        window.DD_LOGS && DD_LOGS.logger.warn("ClientCodecs: ".concat(clientCodecs), {
          clientCodecs: clientCodecs
        });
      } catch (e) {
        window.DD_LOGS && DD_LOGS.logger.warn("ClientCodecs: ".concat(e.message), e);
      }
      _this4.peerConnection.setLocalDescription(answer).then(function () {
        _this4.socket.timeout(5000).emit('CLIENT:ANSWER', {
          answer: answer.sdp
        }, function (error, response) {
          if (error) {
            window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.startStream: [CLIENT:ANSWER] timeout: ".concat(error));
            _this4.streamState.error = 'ERROR:TIMEOUT:CLIENT:ANSWER';
          } else if (!response || !response.status || response.status !== 'OK') {
            window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.startStream: Error: ".concat(JSON.stringify(response)), {
              socket_event: '[CLIENT:ANSWER]',
              error: response
            });
            _this4.streamState.error = 'WEBRTC_ERROR:NEGOTIATION_ERROR:CLIENT_ANSWER';
          } else {
            window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.startStream: [CLIENT:ANSWER] send OK', {
              socket_event: '[CLIENT:ANSWER]'
            });
          }
        });
      })["catch"](function (error) {
        return _this4.streamState.error = error;
      });
    })["catch"](function (error) {
      return _this4.streamState.error = error;
    });
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
WebRTC.prototype.leaveStream = function (notifyServer) {
  var forcedByServer = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;
  window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.leaveStream: notifyServer=".concat(notifyServer, ", forcedByServer=").concat(forcedByServer));
  this.stopStream();
  this.socket && this.socket.off('STREAM:START').off('STREAM:STOP').off('REMOVE:CLIENT').off('REMOVE:STREAM');
  notifyServer && this.socket && this.socket.timeout(5000).emit('STREAM:LEAVE', function (error, response) {
    if (error) {
      window.DD_LOGS && DD_LOGS.logger.debug("WebRTC.leaveStream: [STREAM:LEAVE] timeout: ".concat(error));
    } else if (!response || !response.status || response.status !== 'OK') {
      window.DD_LOGS && DD_LOGS.logger.warn("WebRTC.leaveStream: Error: ".concat(JSON.stringify(response)), {
        socket_event: '[STREAM:LEAVE]',
        error: response
      });
    } else {
      window.DD_LOGS && DD_LOGS.logger.debug('WebRTC.leaveStream: [STREAM:LEAVE] send OK', {
        socket_event: '[STREAM:LEAVE]'
      });
    }
  });
  this.streamState.isStreamJoined = false;
  this.streamState.streamId = null;
};
;// CONCATENATED MODULE: ./src/client/static/src/main.js


var clientId = generateRandomString(24);
var crc = ('00000000' + CRC32(clientId).toString(16).toUpperCase()).slice(-8);
var publicId = crc.substring(0, 4) + "-" + crc.substring(4);
window.DD_LOGS && DD_LOGS.setGlobalContextProperty('clientId', clientId);
window.DD_LOGS && DD_LOGS.setGlobalContextProperty('publicId', publicId);
var UIElements = {
  startContainer: document.getElementById('start-container'),
  streamIdInput: document.getElementById('stream-id'),
  passwordInput: document.getElementById('stream-password'),
  streamJoinButton: document.getElementById('streamJoinButton'),
  joinButtonLoader: document.getElementById('joinButtonLoader'),
  streamJoinCell: document.getElementById('stream-join'),
  streamErrorCell: document.getElementById('stream-error'),
  streamWaitContainer: document.getElementById('stream-wait-container'),
  streamWaitStreamId: document.getElementById('stream-wait-stream-id'),
  streamingHeader: document.getElementById('streaming-header'),
  streamingContainerText: document.getElementById('streaming-container-text'),
  videoContainer: document.getElementById('video-container'),
  videoElement: document.getElementById('video-element')
};
var setDataFromUrlParams = function setDataFromUrlParams() {
  var urlParams = new URLSearchParams(window.location.search);
  var streamId = urlParams.get('id');
  if (isStreamIdValid(streamId)) {
    UIElements.streamIdInput.value = streamId;
    var streamPassword = urlParams.get('p');
    if (isStreamPasswordValid(streamPassword)) {
      UIElements.passwordInput.value = streamPassword;
    }
  }
};
var checkWebRTCsupport = function checkWebRTCsupport() {
  var connection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
  if (typeof connection === 'undefined') window.streamState = "ERROR:WEBRTC_NOT_SUPPORTED";
};
var supportedLocales = ['zh-TW', 'ar', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'];
var locales = new Locales(supportedLocales, navigator.languages);
window.DD_LOGS && DD_LOGS.logger.debug("Browser locales: [".concat(navigator.languages, "], using locale: ").concat(locales.selectedLocale));
locales.fetchTranslation().then(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      locales.translateDocument();
      setDataFromUrlParams();
      checkWebRTCsupport();
    });
  } else {
    locales.translateDocument();
    setDataFromUrlParams();
    checkWebRTCsupport();
  }
});
try {
  document.getElementById('client-id').innerText = publicId;
  var s = (locales.getTranslationByKey('client-id') || 'Client id:') + ' ' + publicId;
  document.getElementById('streaming-client-id').innerText = s;
  document.getElementById('stream-wait-client-id').innerText = s;
} catch (error) {
  window.DD_LOGS && DD_LOGS.logger.warn("client-id.error: ".concat(error), {
    error: error
  });
}
window.streamState = new Proxy({
  isServerAvailable: false,
  isTokenAvailable: false,
  isSocketConnected: false,
  isJoiningStream: false,
  streamId: null,
  isStreamJoined: false,
  isStreamRunning: false,
  error: null
}, {
  set: function set(target, key, value) {
    var oldValue = target[key];
    target[key] = value;
    onNewState(key, oldValue, value, target);
    return true;
  }
});
var hideTimeout = null;
var streamingContainerOnMouseMove = function streamingContainerOnMouseMove() {
  UIElements.streamingHeader.className = 'visible';
  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(function () {
    UIElements.streamingHeader.className = 'hidden';
  }, 2500);
};
var streamingContainerOnMouseOut = function streamingContainerOnMouseOut() {
  clearTimeout(hideTimeout);
  UIElements.streamingHeader.className = 'hidden';
};
var onNewState = function onNewState(key, oldValue, newValue, state) {
  if (newValue === oldValue) return;
  window.DD_LOGS && DD_LOGS.logger.debug("onNewState: [".concat(key, "] ").concat(oldValue, " => ").concat(newValue, "\n").concat(JSON.stringify(state)));
  if (key === 'error' && state.error) {
    window.DD_LOGS && DD_LOGS.logger.warn("onNewState.error: ".concat(state.error), {
      error: state.error
    });
  }
  if (key === 'streamId') {
    if (state.streamId) window.DD_LOGS && DD_LOGS.setGlobalContextProperty('streamId', state.streamId);else window.DD_LOGS && DD_LOGS.removeGlobalContextProperty('streamId');
  }
  UIElements.startContainer.style.display = !state.isStreamJoined ? 'block' : 'none';
  UIElements.streamWaitContainer.style.display = state.isStreamJoined && !state.isStreamRunning ? 'block' : 'none';
  UIElements.streamingHeader.style.display = state.isStreamRunning ? 'block' : 'none';
  UIElements.videoContainer.style.display = state.isStreamRunning ? 'block' : 'none';
  UIElements.joinButtonLoader.style.display = !state.isServerAvailable || state.isServerAvailable && state.isTokenAvailable || state.isJoiningStream ? 'block' : 'none';
  UIElements.streamJoinButton.style.display = state.isSocketConnected && !state.isJoiningStream ? 'table-cell' : 'none';
  UIElements.streamErrorCell.style.display = state.error ? 'block' : 'none';
  if (state.error) {
    if (state.error == 'ERROR:TURNSTILE:200100') {
      UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Incorrect device clock time. Please adjust and reload the page.';
      UIElements.streamJoinCell.style.display = 'none';
      UIElements.streamJoinButton.style.display = 'none';
      UIElements.joinButtonLoader.style.display = 'none';
    } else if (state.error == 'ERROR:WRONG_STREAM_ID') {
      UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Wrong stream id';
    } else if (state.error == 'ERROR:NO_STREAM_HOST_FOUND') {
      UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Stream not found';
    } else if (state.error == 'ERROR:WRONG_STREAM_PASSWORD') {
      UIElements.streamErrorCell.innerText = locales.getTranslationByKey(state.error) || 'Wrong stream password';
    } else {
      UIElements.streamErrorCell.innerText = (locales.getTranslationByKey('ERROR:UNSPECIFIED') || 'Something went wrong. Reload this page and try again.') + "\n[".concat(state.error, "]\n\n");
      UIElements.streamJoinCell.style.display = 'none';
      UIElements.streamJoinButton.style.display = 'none';
      UIElements.joinButtonLoader.style.display = 'none';
    }
  }
  if (key === 'isStreamJoined' && state.isStreamJoined) {
    UIElements.streamWaitStreamId.innerText = (locales.getTranslationByKey(UIElements.streamWaitStreamId.getAttribute('data-i18n-key')) || 'Stream Id: {streamId}').replace('{streamId}', state.streamId);
    UIElements.streamingContainerText.innerText = (locales.getTranslationByKey(UIElements.streamingContainerText.getAttribute('data-i18n-key')) || 'Stream Id: {streamId}').replace('{streamId}', state.streamId);
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
          UIElements.videoElement.srcObject.getTracks().forEach(function (track) {
            return track.stop();
          });
        }
        UIElements.videoElement.srcObject = null;
      }
      clearTimeout(hideTimeout);
      window.removeEventListener('mousemove', streamingContainerOnMouseMove);
      window.removeEventListener('touchstart', streamingContainerOnMouseMove);
      window.removeEventListener('mouseout', streamingContainerOnMouseOut);
    }
  }
};
var onNewTrack = function onNewTrack(track) {
  window.DD_LOGS && DD_LOGS.logger.debug("onNewTrack: ".concat(track.id), {
    track_id: track.id
  });
  if (!UIElements.videoElement.srcObject) {
    UIElements.videoElement.srcObject = new MediaStream();
  }
  UIElements.videoElement.srcObject.addTrack(track);
};
var webRTC = new WebRTC(clientId, window.streamState, window.getTurnstileTokenAsync, onNewTrack);
document.getElementById('streamLeaveButton').addEventListener('click', function (e) {
  e.preventDefault();
  webRTC.leaveStream(true);
});
document.getElementById('streamWaitLeaveButton').addEventListener('click', function (e) {
  e.preventDefault();
  webRTC.leaveStream(true);
});
UIElements.streamJoinButton.addEventListener('click', function (e) {
  e.preventDefault();
  webRTC.joinStream(UIElements.streamIdInput.value, UIElements.passwordInput.value);
});
window.onloadTurnstileCallback = function () {
  webRTC.waitForServerOnlineAndConnect();
};
window.addEventListener('beforeunload', function () {
  return webRTC.leaveStream(false);
});
function generateRandomString(length) {
  var result = '';
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
;
function CRC32(r) {
  for (var a, o = [], c = 0; c < 256; c++) {
    a = c;
    for (var f = 0; f < 8; f++) a = 1 & a ? 3988292384 ^ a >>> 1 : a >>> 1;
    o[c] = a;
  }
  for (var n = -1, t = 0; t < r.length; t++) n = n >>> 8 ^ o[255 & (n ^ r.charCodeAt(t))];
  return (-1 ^ n) >>> 0;
}
;
/******/ })()
;