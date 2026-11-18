const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};
const gameState = {
  players: {},
  projectiles: [],
  effects: []
};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  players[socket.id] = {
    id: socket.id,
    x: Math.random() * 400 + 100,
    y: Math.random() * 400 + 100,
    hp: 100,
    maxHp: 100,
    speed: 5,
    attackCooldown: 0,
    dashCooldown: 0,
    specialCooldown: 0,
    facing: { x: 1, y: 0 }
  };

  socket.emit('init', players[socket.id]);
  io.emit('gameState', gameState);

  socket.on('playerMove', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      players[socket.id].facing = data.facing;
      gameState.players[socket.id] = players[socket.id];
      io.emit('gameState', gameState);
    }
  });

  socket.on('playerAttack', (data) => {
    if (players[socket.id] && players[socket.id].attackCooldown <= 0) {
      players[socket.id].attackCooldown = 500;
      const projectile = {
        id: Date.now() + Math.random(),
        x: players[socket.id].x,
        y: players[socket.id].y,
        vx: data.direction.x * 10,
        vy: data.direction.y * 10,
        damage: 10,
        owner: socket.id,
        type: 'attack'
      };
      gameState.projectiles.push(projectile);
      io.emit('projectileFired', projectile);
    }
  });

  socket.on('playerDash', (data) => {
    if (players[socket.id] && players[socket.id].dashCooldown <= 0) {
      players[socket.id].dashCooldown = 3000;
      players[socket.id].x += data.direction.x * 100;
      players[socket.id].y += data.direction.y * 100;
      gameState.players[socket.id] = players[socket.id];
      io.emit('playerDashed', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y });
    }
  });

  socket.on('playerSpecial', (data) => {
    if (players[socket.id] && players[socket.id].specialCooldown <= 0) {
      players[socket.id].specialCooldown = 5000;
      const specialProjectile = {
        id: Date.now() + Math.random(),
        x: players[socket.id].x,
        y: players[socket.id].y,
        vx: data.direction.x * 6,
        vy: data.direction.y * 6,
        damage: 25,
        owner: socket.id,
        type: 'special',
        radius: 40
      };
      gameState.projectiles.push(specialProjectile);
      io.emit('specialFired', specialProjectile);
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete players[socket.id];
    delete gameState.players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const gameLoop = setInterval(() => {
  Object.keys(players).forEach(id => {
    if (players[id].attackCooldown > 0) players[id].attackCooldown -= 16;
    if (players[id].dashCooldown > 0) players[id].dashCooldown -= 16;
    if (players[id].specialCooldown > 0) players[id].specialCooldown -= 16;
  });

  gameState.projectiles = gameState.projectiles.filter(p => {
    p.x += p.vx;
    p.y += p.vy;

    if (p.x < 0 || p.x > 800 || p.y < 0 || p.y > 600) return false;

    Object.keys(players).forEach(id => {
      if (id !== p.owner) {
        const dx = players[id].x - p.x;
        const dy = players[id].y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 30) {
          players[id].hp -= p.damage;
          gameState.players[id] = players[id];
          io.emit('playerHit', { targetId: id, damage: p.damage });
        }
      }
    });

    return true;
  });

  io.emit('gameState', gameState);
}, 16);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});