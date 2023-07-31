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
const TURNSTYLE_SITE_KEY = process.env.TURNSTYLE_SITE_KEY;
const PORT = process.env.PORT || 5000;
const PROD_NODE_ENV = process.env.NODE_ENV == 'production';

const index = readFileSync('src/client/index.html').toString().replace('%TURNSTYLE_SITE_KEY%', TURNSTYLE_SITE_KEY);

const nocache = (_, res, next) => {
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Cache-Control", "max-age=0, must-revalidate, no-cache, no-store, private");
  next();
};

const expressApp = express()
  .set('x-powered-by', false)
  .set('trust proxy', true)
  .set('etag', false)
  .use(express.static('src/client/static', { index: false }))
  .get('/app/ping', nocache, (req, res) => { res.sendStatus(204) })
  .get('/app/nonce', nocache, nonceHandler)
  .get('/', (req, res) => { if (req.hostname !== SERVER_ORIGIN) res.redirect(301, `https://${SERVER_ORIGIN}`); else res.send(index); })
  .get('*', (req, res) => res.sendStatus(404));

const expressServer = expressApp.listen(PORT, () => console.warn(`Listening on ${PORT}, Production: ${PROD_NODE_ENV}`));

const io = new Server(expressServer, {
  path: "/app/socket",
  transports: ['websocket'],
  cleanupEmptyChildNamespaces: true,
  cors: { origin: ['https://admin.socket.io'], credentials: true }
});

process.on('SIGTERM', () => {
  console.warn('SIGTERM signal received: Closing HTTP server');
  io.disconnectSockets(true);
  expressServer.close(() => { console.warn('HTTP server closed') });
});

io.engine.on('connection_error', (err) => { console.error(JSON.stringify({ socket_event: "[connection_error]", message: err.message })); });

io.use(socketAuth);

io.on('connection', (socket) => {
  console.debug(JSON.stringify({ socket_event: "[connection]", socket: socket.id, message: `New connection: isHost=${socket.data.isHost}, isClient=${socket.data.isClient}` }));

  socket.on('disconnect', async (reason, description) => {
    console.debug(JSON.stringify({ socket_event: "[disconnect]", socket: socket.id, message: reason + " " + description }));
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