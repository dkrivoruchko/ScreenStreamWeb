import logger from './logger.js';
import { readFileSync } from 'fs';
import express from 'express';
import { Server } from 'socket.io';

import { nonceHandler } from './modules/nonceHandler.js';
import socketAuth from './modules/socketAuth.js';
import socketCheck from './modules/socketCheck.js';
import socketHostHandler from './modules/routing/hostRouter.js';
import socketHandlerClient from './modules/routing/clientRouter.js';
import { clearClientRelayState, installStaleClientAckHandlers } from './modules/stream.js';
import { PROTOCOL_VERSION } from './modules/signalingV2/common.js';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const PORT = process.env.PORT || 5000;

const isPROD = SERVER_ORIGIN === 'screenstream.io';

const index = readFileSync('src/client/index.html')
  .toString()
  .replace('$DD_SERVICE$', `WebClient${isPROD ? '-PROD' : '-DEV'}`)
  .replace('$DD_HANDLER$', isPROD ? '["http"]' : '["http", "console"]')
  .replace('$DD_LOG_LEVEL$', process.env.DD_BROWSER_LOG_LEVEL || (isPROD ? 'info' : 'debug'))
  .replaceAll('$PACKAGE_VERSION$', `'${process.env.npm_package_version}'`)
  .replace('$TURNSTYLE_SITE_KEY$', process.env.TURNSTYLE_SITE_KEY);

const nocache = (_, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

const revalidate = (_, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

const expressApp = express()
  .set('x-powered-by', false)
  .set('trust proxy', true)
  .set('etag', false)
  .use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://www.datadoghq-browser-agent.com https://challenges.cloudflare.com https://static.cloudflareinsights.com",
        "script-src-elem 'self' 'unsafe-inline' https://cdn.socket.io https://www.datadoghq-browser-agent.com https://challenges.cloudflare.com https://static.cloudflareinsights.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: android-webview-video-poster https://challenges.cloudflare.com https://static.cloudflareinsights.com",
        "connect-src 'self' wss: https://cdn.socket.io https://browser-intake-datadoghq.com https://logs.browser-intake-datadoghq.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
        "frame-src 'self' https://challenges.cloudflare.com",
        "base-uri 'self'",
        "object-src 'none'",
        "block-all-mixed-content",
        "upgrade-insecure-requests"
      ].join('; ')
    );
    next();
  })
  .use((req, res, next) => {
    const allowedOrigins = [
      'https://www.datadoghq-browser-agent.com',
      'https://logs.browser-intake-datadoghq.com',
      'https://cdn.socket.io',
      'https://challenges.cloudflare.com',
    ];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  })
  .use(express.static('src/client/static', {
    index: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }))
  .get('/app/ping', nocache, (req, res) => { res.sendStatus(204); })
  .get('/app/nonce', nocache, nonceHandler)
  .get('/', revalidate, (req, res) => {
    if (req.hostname !== SERVER_ORIGIN) {
      return res.redirect(301, `https://${SERVER_ORIGIN}`);
    }
    res.send(index);
  })
  .use((req, res) => { res.sendStatus(404); });

const expressServer = expressApp.listen(PORT, () => {
  logger.info({ event_name: 'server_started', port: PORT, message: `Listening on ${PORT}` });
  console.warn(`Listening on ${PORT}`);
});

const io = new Server(expressServer, {
  path: '/app/socket',
  transports: ['websocket'],
  cleanupEmptyChildNamespaces: true,
});

process.on('SIGTERM', () => {
  const forceClose = setTimeout(() => {
    logger.error('Force closing server after timeout');
    process.exit(1);
  }, 10000);

  io.disconnectSockets(true);
  expressServer.close(() => {
    clearTimeout(forceClose);
    console.warn('HTTP server closed');
    process.exit(0);
  });
});

io.engine.on('connection_error', (err) => {
  logger.error({ socket_event: '[connection_error]', message: err.message });
});

io.use(socketAuth);

function matchesRelayHost(hostSocket, relayContext, protocolVersion) {
  if (
    hostSocket?.connected !== true ||
    hostSocket.id !== relayContext?.hostSocketId ||
    hostSocket.data?.streamId !== relayContext?.streamId ||
    hostSocket.data?.protocolVersion !== protocolVersion ||
    relayContext?.protocolVersion !== protocolVersion
  ) return false;

  return protocolVersion !== PROTOCOL_VERSION || hostSocket.data?.hostCreateAttemptId === relayContext?.hostCreateAttemptId;
}

async function cleanupClientOnDisconnecting(io, socket, reason) {
  const protocolVersion = socket.data?.protocolVersion;
  if (socket.data?.isClient !== true || (protocolVersion !== 1 && protocolVersion !== PROTOCOL_VERSION)) return;

  const relayContext = socket.data?.relayHostContext;
  const streamId = relayContext?.streamId;
  const clientId = socket.data?.clientId;
  const joinAttemptId = socket.data?.joinAttemptId;
  const isV2 = protocolVersion === PROTOCOL_VERSION;

  if (!streamId || !clientId || (isV2 && !joinAttemptId)) return;

  try {
    const socketsInStream = await io.in(streamId).fetchSockets();
    const hasReplacementClient = socketsInStream.some(item => item.id !== socket.id && item.connected && item.data?.isClient === true && item.data?.clientId === clientId && (isV2 ? item.data?.protocolVersion === PROTOCOL_VERSION : true));

    if (hasReplacementClient) {
      logger.debug({ socket_event: '[disconnecting]', socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: protocolVersion, classification: 'stale_client_generation_ignored', reason, message: 'Client socket has a replacement. Skipping disconnect cleanup.' });
      return;
    }

    const hostSocket = socketsInStream.find(item => item.data?.isHost === true);
    if (!matchesRelayHost(hostSocket, relayContext, protocolVersion)) {
      logger.debug({ socket_event: '[disconnecting]', socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: protocolVersion, reason, message: 'No current host relay. Skipping disconnect cleanup.' });
      return;
    }

    const liveHostSocket = io.sockets.sockets.get(hostSocket.id);
    const hostData = liveHostSocket?.data ?? hostSocket.data;
    if (hostData?.currentClientSocketIds?.[clientId] === socket.id) {
      delete hostData.currentClientSocketIds[clientId];
    }

    const leavePayload = isV2 ? { clientId, joinAttemptId } : { clientId };
    hostSocket.timeout(5000).emit('STREAM:LEAVE', leavePayload, (err, response) => {
      if (err) {
        logger.debug({ socket_event: '[disconnecting]', socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: protocolVersion, reason: 'TIMEOUT_OR_NO_RESPONSE', disconnect_reason: reason, message: 'Host timeout for disconnect cleanup STREAM:LEAVE. Ignoring.' });
        return;
      }

      if (response?.status !== 'OK') {
        logger.warn({ socket_event: '[disconnecting]', socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: protocolVersion, reason: response?.status, disconnect_reason: reason, message: `Host error for disconnect cleanup STREAM:LEAVE => ${response?.status}` });
      }
    });

    socket.leave(streamId);
    clearClientRelayState(socket);
    installStaleClientAckHandlers(socket);
  } catch (cause) {
    logger.warn({ socket_event: '[disconnecting]', socket: socket.id, streamId, clientId, joinAttemptId, protocol_version: protocolVersion, reason: cause?.message, disconnect_reason: reason, message: 'Failed to cleanup client disconnect.' });
  }
}

io.on('connection', (socket) => {
  socket.on('disconnecting', async (reason) => {
    await cleanupClientOnDisconnecting(io, socket, reason);
  });

  socket.on('disconnect', async (reason, description) => {
    socket.removeAllListeners();
  });

  socket.data.errorCounter = 0;
  socketCheck(socket);
  socketHostHandler(io, socket);
  socketHandlerClient(io, socket);
});
