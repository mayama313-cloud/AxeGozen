const crypto = require('node:crypto');
const World = require('./game-world');
const Teams = require('./public/team-config');
const Policy = require('./public/minion-policy');

function createTeamRooms({ busy = () => false, onMatch = () => {} } = {}) {
  const rooms = new Map(), membership = new Map();
  const roomFor = socket => rooms.get(membership.get(socket.id));
  function snapshot(room, socket) {
    return { code: room.code, phase: room.phase, host: room.host === socket.id,
      self: room.members.get(socket.id) ? { team: room.members.get(socket.id).team, member: room.members.get(socket.id).member } : null,
      teams: room.teams.map((team, t) => team.map((m, i) => ({ ...Teams.describe(m, i), occupied: !!m.socketId,
        ready: m.kind !== 'human' ? m.kind !== 'model' || !!m.model : !!room.members.get(m.socketId)?.ready,
        self: m.socketId === socket.id }))) };
  }
  function broadcast(room) { for (const { socket } of room.members.values()) socket.emit('teamRoom', snapshot(room, socket)); }
  function unready(room) { for (const member of room.members.values()) member.ready = false; }
  function start(room) {
    if (room.phase !== 'waiting' || room.teams.some(team => team.some(m => m.kind === 'human' ? !m.socketId || !room.members.get(m.socketId)?.ready : m.kind === 'model' && !m.model))) return;
    room.phase = 'playing';
    const match = room.match = World.createMatch(false, false, { teamSizes: room.teams.map(t => t.length) });
    for (const member of room.members.values()) member.socket.emit('teamRoomStarted', { code: room.code });
    for (const { socket, team, member } of room.members.values()) match.connect(socket, { team, member, name: room.teams[team][member].label });
    room.teams.forEach((team, t) => team.forEach((m, i) => {
      if (m.kind === 'human') return;
      const id = `room-${room.code}-cpu-${t}-${i}`;
      match.addBot({ team: t, member: i, id, character: m.character, name: m.label, controller: Teams.controller(m, t, id, (17 + t * 997 + i * 7919) >>> 0) });
    }));
    for (const { socket, team, member } of room.members.values()) {
      const p = match.state.players[socket.id]; p.commands.selectCharacter({ id: room.teams[team][member].character }); p.commands.confirmCharacter();
    }
    onMatch(match); match.tick();
  }
  function attach(socket) {
    const handle = (event, fn) => socket.on(event, (data = {}, ack) => {
      try { const result = fn(data); if (typeof ack === 'function') ack({ ok: true, ...result }); }
      catch (error) { socket.emit('teamRoomError', error.message); if (typeof ack === 'function') ack({ ok: false, error: error.message }); }
    });
    const waiting = () => { const room = roomFor(socket); if (!room || room.phase !== 'waiting') throw Error('編成待ちの部屋に参加してください。'); return room; };
    const host = () => { const room = waiting(); if (room.host !== socket.id) throw Error('編成を変更できるのはホストだけです。'); return room; };
    handle('createTeamRoom', data => {
      if (membership.has(socket.id) || busy(socket.id)) throw Error('既に対戦に参加しています。');
      // Full model bodies are uploaded separately to keep each message bounded.
      const teams = Teams.normalize(data.teams, { pendingModels: true });
      if (teams[0][0].kind !== 'human') throw Error('Aチームの1人目はホストの人間プレイヤーにしてください。');
      let code; do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const room = { code, host: socket.id, phase: 'waiting', teams, members: new Map() };
      teams[0][0].socketId = socket.id; room.members.set(socket.id, { socket, team: 0, member: 0, ready: false });
      rooms.set(code, room); membership.set(socket.id, code); broadcast(room); return { code };
    });
    handle('joinTeamRoom', data => {
      if (membership.has(socket.id) || busy(socket.id)) throw Error('既に対戦に参加しています。');
      const room = rooms.get(String(data.code || '').trim().toUpperCase()), team = Number(data.team ?? 1);
      if (!room || room.phase !== 'waiting') throw Error('参加可能な部屋が見つかりません。');
      if (![0, 1].includes(team)) throw Error('参加チームが不正です。');
      const member = room.teams[team].findIndex(m => m.kind === 'human' && !m.socketId);
      if (member < 0) throw Error('このチームに人間用の空席がありません。');
      room.teams[team][member].socketId = socket.id;
      room.members.set(socket.id, { socket, team, member, ready: false }); membership.set(socket.id, room.code);
      unready(room); broadcast(room); return { code: room.code };
    });
    handle('teamRoomMove', data => {
      const room = waiting(), team = Number(data.team), current = room.members.get(socket.id);
      if (![0, 1].includes(team)) throw Error('参加チームが不正です。');
      if (team === current.team) return {};
      const member = room.teams[team].findIndex(m => m.kind === 'human' && !m.socketId);
      if (member < 0) throw Error('このチームに人間用の空席がありません。');
      room.teams[current.team][current.member].socketId = null; room.teams[team][member].socketId = socket.id;
      Object.assign(current, { team, member }); unready(room); broadcast(room); return {};
    });
    handle('teamRoomReady', data => {
      const room = waiting(), member = room.members.get(socket.id);
      if (!World.characterFor(data.character)) throw Error('キャラクターが不正です。');
      room.teams[member.team][member.member].character = data.character; member.ready = !!data.ready;
      broadcast(room); start(room); return {};
    });
    handle('setTeamSeat', data => {
      const room = host(), team = Number(data.team), index = Number(data.member);
      if (![0, 1].includes(team) || !Number.isInteger(index) || index < 0 || index > room.teams[team].length || index >= 5) throw Error('席番号が不正です。');
      const previous = room.teams[team][index];
      if (previous?.socketId) throw Error('参加中の人間の席は変更できません。');
      if (data.remove) {
        if (!previous || room.teams[team].length <= 1) throw Error('各チームには1人以上必要です。');
        room.teams[team].splice(index, 1);
        for (const member of room.members.values()) if (member.team === team && member.member > index) member.member--;
      } else {
        const value = { kind: data.kind, character: data.character || previous?.character || 'alex', label: data.label || previous?.label,
          model: data.kind === 'model' && previous?.kind === 'model' ? previous.model : null,
          fileName: previous?.fileName, sha256: previous?.sha256 };
        const normalized = Teams.normalize([[value], [{ kind: 'algorithm', character: 'alex' }]], { pendingModels: true })[0][0];
        room.teams[team][index] = normalized;
      }
      unready(room); broadcast(room); return {};
    });
    handle('setTeamModel', data => {
      const room = host(), team = Number(data.team), index = Number(data.member), member = room.teams[team]?.[index];
      if (!member || member.socketId || !Number.isInteger(index)) throw Error('CPUの席を指定してください。');
      const model = Policy.validate(data.model);
      const character = model.characters.includes(data.character || member.character) ? data.character || member.character : model.characters[0];
      const value = { ...member, kind: 'model', model, character, fileName: String(data.fileName || 'model.json'),
        sha256: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex') };
      room.teams[team][index] = Teams.normalize([[value], [{ kind: 'algorithm', character: 'alex' }]])[0][0];
      unready(room); broadcast(room); return {};
    });
    socket.on('disconnect', () => {
      const room = roomFor(socket); membership.delete(socket.id); if (!room) return;
      const member = room.members.get(socket.id); room.members.delete(socket.id);
      if (room.phase === 'waiting' && member) room.teams[member.team][member.member].socketId = null;
      if (!room.members.size) { rooms.delete(room.code); return; }
      if (room.host === socket.id) room.host = room.members.keys().next().value;
      if (room.phase === 'waiting') { unready(room); broadcast(room); }
    });
  }
  return { attach, has: id => membership.has(id) };
}
module.exports = { createTeamRooms };
