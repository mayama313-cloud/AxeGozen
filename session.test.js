const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('offline uses the browser game engine without creating a network connection and cleans up on lobby return', () => {
  let interval = null, ioCalls = 0;
  const context = vm.createContext({ window: {}, setInterval(fn) { interval = fn; return 1; }, clearInterval() { interval = null; }, io() { ioCalls++; throw Error('Offline must not connect'); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'game-world.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/session.js'), 'utf8'), context);
  const session = context.window.gameSession;
  let state, inits = 0;
  session.on('init', () => inits++); session.on('state', s => { state = s; });
  session.start('offline'); assert.equal(state.phase, 'selecting');
  session.emit('selectCharacter', { id: 'alex' }); session.emit('confirmCharacter'); interval();
  assert.equal(state.phase, 'playing'); assert.equal(session.connected, true); assert.equal(ioCalls, 0);
  session.stop(); assert.equal(interval, null); assert.equal(session.connected, false);
  session.start('offline'); assert.equal(state.phase, 'selecting'); assert.equal(inits, 2);
  session.stop();
});
