const { createMatch } = require('./game-world');
const { createTeamRooms } = require('./team-rooms');

function createMatchmaker() {
  const queue = [], members = new Set(), matches = new Set();
  const rooms = createTeamRooms({ busy: id => members.has(id), onMatch: match => matches.add(match) });
  function attach(socket) {
    rooms.attach(socket);
    socket.on('joinQueue', () => {
      if (members.has(socket.id) || rooms.has(socket.id)) return;
      members.add(socket.id);
      queue.push(socket);
      socket.emit('queued');
      if (queue.length >= 2) {
        const first = queue.shift(), second = queue.shift(), match = createMatch();
        matches.add(match);
        match.connect(first); match.connect(second);
        match.tick();
      }
    });
    socket.on('disconnect', () => {
      members.delete(socket.id);
      const i = queue.indexOf(socket);
      if (i >= 0) queue.splice(i, 1);
    });
  }
  function tick() {
    for (const match of matches) {
      if (match.empty()) matches.delete(match);
      else match.tick();
    }
  }
  return { attach, tick };
}

module.exports = { createMatchmaker };
