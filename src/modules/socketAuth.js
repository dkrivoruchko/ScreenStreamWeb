import logger from '../logger.js';
import https from 'https';
import { isValidNonce } from './nonceHandler.js';
import { GoogleToken } from 'gtoken';

const ANDROID_APP_PACKAGE = process.env.ANDROID_APP_PACKAGE;
const ANDROID_APP_CERT256 = process.env.ANDROID_APP_CERT256;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.split('\\n').join('\n');

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const TURNSTYLE_SECRET_KEY = process.env.TURNSTYLE_SECRET_KEY;

const HOST_TOKEN_TIMEOUT = 60 * 60 * 1000; // 60 minutes

const AUTH_TIMEOUT = 5000; // 5 seconds

// https://github.com/googleapis/node-gtoken
const gtoken = new GoogleToken({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  scope: ['https://www.googleapis.com/auth/playintegrity'],
  key: GOOGLE_SERVICE_ACCOUNT_KEY,
  eagerRefreshThresholdMillis: 5 * 60 * 1000 // 5 minutes
});

export default async function (socket, next) {
  const timeoutId = setTimeout(() => {
    next(new Error('Authentication timeout'));
  }, AUTH_TIMEOUT);
  let authRole = 'unknown';

  try {
    const hostToken = socket.handshake.auth.hostToken;
    const clientToken = socket.handshake.auth.clientToken;

    if (!hostToken && !clientToken) throw new Error('NO_TOKEN_FOUND');

    if (clientToken) {
      authRole = 'client';
      logger.debug({ socket: socket.id, message: 'Client Turnstile token received' });

      const data = JSON.stringify({ 'secret': TURNSTYLE_SECRET_KEY, 'response': clientToken });

      const options = {
        hostname: 'challenges.cloudflare.com',
        port: 443,
        path: '/turnstile/v0/siteverify',
        method: 'POST',
        timeout: 3000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
      };

      const outcome = await doRequest(options, data);

      if (outcome.success !== true) throw new Error(`TURNSTYLE_INVALID_TOKEN:${outcome['error-codes']}`);
      if (outcome.hostname !== SERVER_ORIGIN) throw new Error(`TURNSTYLE_INVALID_HOSTNAME:${outcome.hostname}`);
      if (!outcome.cdata || typeof outcome.cdata !== 'string' || outcome.cdata.length === 0) throw new Error(`TURNSTYLE_INVALID_CLIENT_ID:${outcome.cdata}`);

      socket.data.isHost = false;
      socket.data.isClient = true;
      socket.data.clientId = outcome.cdata;

      logger.info({ event_name: 'auth_outcome', socket: socket.id, role: authRole, result: 'ok', provider: 'turnstile', clientId: outcome.cdata, message: 'Client auth outcome' });
      clearTimeout(timeoutId);
      next();
      return;
    }

    if (hostToken) {
      authRole = 'host';
      const data = JSON.stringify({ integrity_token: hostToken });

      await gtoken.getToken();

      const options = {
        hostname: 'playintegrity.googleapis.com',
        port: 443,
        path: `/v1/${ANDROID_APP_PACKAGE}:decodeIntegrityToken`,
        method: 'POST',
        timeout: 5000,
        headers: { 'Authorization': `Bearer ${gtoken.accessToken}`, 'Content-Type': 'application/json', 'Content-Length': data.length }
      }

      const tokenPayload = await doRequest(options, data);
      const payload = tokenPayload.tokenPayloadExternal;

      if (!payload) throw new Error('EMPTY_PAYLOAD');

      // requestDetails
      if (!payload.requestDetails) throw new Error('EMPTY_REQUEST_DETAILS');

      if (payload.requestDetails.requestPackageName !== ANDROID_APP_PACKAGE) throw new Error(`REQUEST_DETAILS_WRONG_PACKAGE_NAME:${payload.appIntegrity.packageName}`);

      const requestHash = payload.requestDetails.requestHash;

      if (!isValidNonce(requestHash)) throw new Error('INVALID_NONCE');

      const timeout = Date.now() - payload.requestDetails.timestampMillis;
      if (timeout > HOST_TOKEN_TIMEOUT) throw new Error(`TOKEN_EXPIRED:${Math.trunc(timeout / 60000)}`);

      let authResult = 'ok';
      let authReason;
      let appRecognitionVerdict;
      let deviceRecognitionVerdict;
      try {
        // deviceIntegrity
        if (!payload.deviceIntegrity) throw new Error('EMPTY_DEVICE_INTEGRITY');
        deviceRecognitionVerdict = payload.deviceIntegrity.deviceRecognitionVerdict;

        if (!payload.deviceIntegrity.deviceRecognitionVerdict) throw new Error('FAIL_DEVICE_INTEGRITY');

        if (!payload.deviceIntegrity.deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY')) throw new Error('FAIL_DEVICE_INTEGRITY');

        // appIntegrity
        if (!payload.appIntegrity) throw new Error('EMPTY_APP_INTEGRITY');
        appRecognitionVerdict = payload.appIntegrity.appRecognitionVerdict;

        if (ANDROID_APP_PACKAGE.endsWith('.dev')) { // Dev build
          if (payload.appIntegrity.appRecognitionVerdict !== 'UNRECOGNIZED_VERSION') throw new Error('WRONG_APP_VERDICT');
        } else {
          if (payload.appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') throw new Error('WRONG_APP_VERDICT');
        }

        if (payload.appIntegrity.packageName !== ANDROID_APP_PACKAGE) throw new Error('APP_INTEGRITY_WRONG_PACKAGE_NAME');

        if (!payload.appIntegrity.certificateSha256Digest) throw new Error('APP_INTEGRITY_WRONG_DIGEST');

        if (!payload.appIntegrity.certificateSha256Digest.includes(ANDROID_APP_CERT256)) throw new Error('APP_INTEGRITY_WRONG_DIGEST');
        // Don't check for now tokenPayload.appIntegrity.versionCode

        // accountDetails 
        // Don't check for now
      } catch (error) {
        authResult = 'degraded';
        authReason = `ERROR:TOKEN_VERIFICATION_FAILED:${error.message}`;
      }

      socket.data.isHost = true;
      socket.data.isClient = false;
      logger[authResult === 'ok' ? 'info' : 'warn']({ event_name: 'auth_outcome', socket: socket.id, role: authRole, result: authResult, reason: authReason, provider: 'play_integrity', request_age_ms: timeout, appRecognitionVerdict, deviceRecognitionVerdict, message: 'Host auth outcome' });
      clearTimeout(timeoutId);
      next();
    }

  } catch (cause) {
    logger.warn({ event_name: 'auth_outcome', socket: socket.id, role: authRole, result: 'error', reason: 'ERROR:TOKEN_VERIFICATION_FAILED', message: cause.message });
    clearTimeout(timeoutId);
    next(new Error(`ERROR:TOKEN_VERIFICATION_FAILED:${cause.message}`));
  }

  async function doRequest(options, data) {
    return new Promise((resolve, reject) => {
      const request = https.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode > 299)
          return reject(new Error(`${res.statusCode}`));

        const body = [];

        res.on('data', chunk => body.push(chunk));

        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(body).toString()));
          } catch (cause) {
            reject(cause);
          }
        });
      });

      request.on('error', err => reject(err));
      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`TIME_OUT:[${options.hostname}]`));
      });

      request.write(data);
      request.end();
    });
  }
}
