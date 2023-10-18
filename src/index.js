import logger from './logger.js';
import { readFileSync } from 'fs';
import express from 'express';
import { Server } from 'socket.io';
import { instrument } from '@socket.io/admin-ui';

import { nonceHandler } from './modules/nonceHandler.js';
import socketAuth from './modules/socketAuth.js';
import socketCheck from './modules/socketCheck.js';
import socketHostHandler from './modules/socketHandlerHost.js';
import socketHandlerClient from './modules/socketHandlerClient.js';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN;
const PORT = process.env.PORT || 5000;

const isPROD = SERVER_ORIGIN === 'screenstream.io';

const index = readFileSync('src/client/index.html').toString()
  .replace('$DD_SERVICE$', `WebClient${isPROD ? "-PROD" : "-DEV"}`)
  .replace('$DD_HANDLER$', isPROD ? '["http"]' : '["http", "console"]')
  .replace('$PACKAGE_VERSION$', `'${process.env.npm_package_version}'`)
  .replace('$TURNSTYLE_SITE_KEY$', process.env.TURNSTYLE_SITE_KEY);


const nocache = (_, res, next) => {
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
  next();
};

const revalidate = (_, res, next) => {
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  next();
};

const expressApp = express()
  .set('x-powered-by', false)
  .set('trust proxy', true)
  .set('etag', false)
  .use(express.static('src/client/static', { index: false }))
  .use((req, res, next) => {
    res.append('Access-Control-Allow-Origin', ['https://www.datadoghq-browser-agent.com', 'https://logs.browser-intake-datadoghq.com', 'https://cdn.socket.io', 'https://challenges.cloudflare.com']);
    next();
  })
  .get('/app/ping', nocache, (req, res) => { res.sendStatus(204) })
  .get('/app/nonce', nocache, nonceHandler)
  .get('/', revalidate, (req, res) => { if (req.hostname !== SERVER_ORIGIN) res.redirect(301, `https://${SERVER_ORIGIN}`); else res.send(index); })
  .get('*', (req, res) => res.sendStatus(404));

const expressServer = expressApp.listen(PORT, () => {
  logger.warn(`Listening on ${PORT}`);
  console.warn(`Listening on ${PORT}`);
});

const io = new Server(expressServer, {
  path: "/app/socket",
  transports: ['websocket'],
  cleanupEmptyChildNamespaces: true,
  cors: { origin: ['https://admin.socket.io'], credentials: true }
});

process.on('SIGTERM', () => {
  logger.warn('SIGTERM signal received: Closing HTTP server');
  console.warn('SIGTERM signal received: Closing HTTP server');
  io.disconnectSockets(true);
  expressServer.close(() => {
    logger.warn('HTTP server closed');
    console.warn('HTTP server closed');
  });
});

io.engine.on('connection_error', (err) => { logger.error(JSON.stringify({ socket_event: "[connection_error]", message: err.message })); });

io.use(socketAuth);

io.on('connection', (socket) => {
  logger.debug(JSON.stringify({ socket_event: "[connection]", socket: socket.id, message: `New connection: isHost=${socket.data.isHost}, isClient=${socket.data.isClient}` }));

  socket.on('disconnect', async (reason, description) => {
    logger.debug(JSON.stringify({ socket_event: "[disconnect]", socket: socket.id, message: reason + "/" + description }));
    socket.data = undefined;
  });

  socket.data.errorCounter = 0;
  socketCheck(io, socket);
  socketHostHandler(io, socket);
  socketHandlerClient(io, socket);
});

instrument(io, {
  readonly: false,
  mode: "development", //TODO Move to "production"
  auth: { type: 'basic', username: 'admin', password: process.env.ADMIN_UI_PASSWORD }
});