const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createMatch, TICK } = require('./game-world');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const online = createMatch();
const practices = new Map();
io.on('connection', socket => {
  const solo = socket.handshake.query.mode === 'solo';
  const match = solo ? createMatch(true) : online;
  if (!match.connect(socket)) return;
  if (solo) practices.set(socket.id, match);
  socket.on('disconnect', () => practices.delete(socket.id));
});

setInterval(() => {
  online.tick();
  for (const match of practices.values()) match.tick();
}, 1000 / TICK);

server.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
