const socket = io();
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let player = null;
let gameState = {
  players: {},
  projectiles: []
};
const keys = {};
let mousePos = { x: 0, y: 0 };

socket.on('init', (initialPlayer) => {
  player = initialPlayer;
});

socket.on('gameState', (state) => {
  gameState = state;
  updateUI();
});

socket.on('projectileFired', (projectile) => {
  gameState.projectiles.push(projectile);
});

socket.on('specialFired', (projectile) => {
  gameState.projectiles.push(projectile);
});

socket.on('playerHit', (data) => {
  if (gameState.players[data.targetId]) {
    gameState.players[data.targetId].hp -= data.damage;
  }
});

document.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ') {
    e.preventDefault();
    attack();
  } else if (e.key.toLowerCase() === 'e') {
    e.preventDefault();
    dash();
  } else if (e.key.toLowerCase() === 'q') {
    e.preventDefault();
    specialAttack();
  }
});

document.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mousePos.x = e.clientX - rect.left;
  mousePos.y = e.clientY - rect.top;
});

function updateUI() {
  if (!player) return;
  
  const playerHp = gameState.players[player.id]?.hp || player.hp;
  const playerHpPercent = Math.max(0, playerHp / 100) * 100;
  document.getElementById('playerHpFill').style.width = `${playerHpPercent}%`;
  
  Object.keys(gameState.players).forEach(id => {
    if (id !== player.id) {
      const enemyHp = gameState.players[id].hp;
      const enemyHpPercent = Math.max(0, enemyHp / 100) * 100;
      document.getElementById('enemyHpFill').style.width = `${enemyHpPercent}%`;
    }
  });
  
  const p = gameState.players[player.id] || player;
  if (p) {
    const spaceCd = Math.max(0, p.attackCooldown / 500) * 100;
    const eCd = Math.max(0, p.dashCooldown / 3000) * 100;
    const qCd = Math.max(0, p.specialCooldown / 5000) * 100;
    
    document.getElementById('spaceCooldown').style.height = `${spaceCd}%`;
    document.getElementById('eCooldown').style.height = `${eCd}%`;
    document.getElementById('qCooldown').style.height = `${qCd}%`;
  }
}

function attack() {
  if (!player) return;
  const direction = getDirectionToMouse();
  socket.emit('playerAttack', { direction });
}

function dash() {
  if (!player) return;
  const direction = getDirectionToMouse();
  socket.emit('playerDash', { direction });
}

function specialAttack() {
  if (!player) return;
  const direction = getDirectionToMouse();
  socket.emit('playerSpecial', { direction });
}

function getDirectionToMouse() {
  if (!player) return { x: 1, y: 0 };
  const dx = mousePos.x - player.x;
  const dy = mousePos.y - player.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  return { x: dx / length, y: dy / length };
}

function update() {
  if (!player) return;
  
  let dx = 0, dy = 0;
  if (keys['w']) dy -= 1;
  if (keys['s']) dy += 1;
  if (keys['a']) dx -= 1;
  if (keys['d']) dx += 1;
  
  if (dx !== 0 || dy !== 0) {
    const length = Math.sqrt(dx * dx + dy * dy);
    dx /= length;
    dy /= length;
    
    player.x += dx * player.speed;
    player.y += dy * player.speed;
    
    player.x = Math.max(20, Math.min(canvas.width - 20, player.x));
    player.y = Math.max(20, Math.min(canvas.height - 20, player.y));
    
    const facing = getDirectionToMouse();
    socket.emit('playerMove', { x: player.x, y: player.y, facing });
  }
  
  gameState.projectiles = gameState.projectiles.filter(p => {
    p.x += p.vx;
    p.y += p.vy;
    return p.x > 0 && p.x < canvas.width && p.y > 0 && p.y < canvas.height;
  });
}

function draw() {
  ctx.fillStyle = '#2d2d44';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.strokeStyle = '#3d3d5c';
  ctx.lineWidth = 1;
  for (let i = 0; i < canvas.width; i += 50) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, canvas.height);
    ctx.stroke();
  }
  for (let j = 0; j < canvas.height; j += 50) {
    ctx.beginPath();
    ctx.moveTo(0, j);
    ctx.lineTo(canvas.width, j);
    ctx.stroke();
  }
  
  Object.keys(gameState.players).forEach(id => {
    const p = gameState.players[id];
    if (!p) return;
    
    ctx.save();
    ctx.translate(p.x, p.y);
    
    if (id === player.id) {
      ctx.fillStyle = '#3498db';
    } else {
      ctx.fillStyle = '#e74c3c';
    }
    
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.facing.x * 10, p.facing.y * 10, 5, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
    
    ctx.fillStyle = '#fff';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(id === player.id ? 'You' : 'Enemy', p.x, p.y - 30);
  });
  
  gameState.projectiles.forEach(p => {
    ctx.save();
    ctx.translate(p.x, p.y);
    
    if (p.type === 'attack') {
      ctx.fillStyle = '#f1c40f';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === 'special') {
      ctx.fillStyle = '#9b59b6';
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
    }
    
    ctx.restore();
  });
}

function gameLoop() {
  update();
  draw();
  requestAnimationFrame(gameLoop);
}

gameLoop();