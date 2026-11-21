const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { TICK } = require('./game-world');
const { createMatchmaker } = require('./matchmaking');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 * 1024 });
app.use(express.static('public'));
app.get('/game-world.js', (req, res) => res.sendFile(path.join(__dirname, 'game-world.js')));

const matchmaker = createMatchmaker();
io.on('connection', socket => matchmaker.attach(socket));
setInterval(() => matchmaker.tick(), 1000 / TICK);

server.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
