import logger from './logger.js';
import { readFileSync } from 'fs';
import express from 'express';
import { Server } from 'socket.io';

import { nonceHandler } from './modules/nonceHandler.js';
import socketAuth from './modules/socketAuth.js';
import socketCheck from './modules/socketCheck.js';
import socketHostHandler from './modules/socketHandlerHost.js';
import socketHandlerClient from './modules/socketHandlerClient.js';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const PORT = process.env.PORT || 5000;

const isPROD = SERVER_ORIGIN === 'screenstream.io';

const index = readFileSync('src/client/index.html')
  .toString()
  .replace('$DD_SERVICE$', `WebClient${isPROD ? '-PROD' : '-DEV'}`)
  .replace('$DD_HANDLER$', isPROD ? '["http"]' : '["http", "console"]')
  .replace('$PACKAGE_VERSION$', `'${process.env.npm_package_version}'`)
  .replace('$TURNSTYLE_SITE_KEY$', process.env.TURNSTYLE_SITE_KEY);

const nocache = (_, res, next) => {
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  next();
};

const revalidate = (_, res, next) => {
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
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
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' wss: https://browser-intake-datadoghq.com https://logs.browser-intake-datadoghq.com",
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
  .use(express.static('src/client/static', { index: false }))
  .get('/app/ping', nocache, (req, res) => {
    res.sendStatus(204);
  })
  .get('/app/nonce', nocache, nonceHandler)
  .get('/', revalidate, (req, res) => {
    if (req.hostname !== SERVER_ORIGIN) {
      res.redirect(301, `https://${SERVER_ORIGIN}`);
    } else {
      res.send(index);
    }
  })
  .get('/*', (req, res) => res.sendStatus(404));

const expressServer = expressApp.listen(PORT, () => {
  logger.warn(`Listening on ${PORT}`);
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
  logger.error(JSON.stringify({ socket_event: '[connection_error]', message: err.message }));
});

io.use(socketAuth);

io.on('connection', (socket) => {
  logger.debug(JSON.stringify({ socket_event: '[connection]', socket: socket.id, message: `New connection: isHost=${socket.data.isHost}, isClient=${socket.data.isClient}` }));

  socket.on('disconnect', async (reason, description) => {
    logger.debug(JSON.stringify({ socket_event: '[disconnect]', socket: socket.id, message: reason + '/' + description }));
    socket.removeAllListeners();
    socket.data = undefined;
  });

  socket.data.errorCounter = 0;
  socketCheck(io, socket);
  socketHostHandler(io, socket);
  socketHandlerClient(io, socket);
});