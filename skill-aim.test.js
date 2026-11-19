const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillAim } = require('./public/skill-aim');

function setup(character = 'alex') {
  const player = { character, dead: false, stun: 0, air: 0, qCd: 0, eCd: 0, cCd: 0 };
  const events = [], state = { playing: true, point: { x: 4, z: 0 }, valid: true };
  const aim = createSkillAim({ self: () => player, playing: () => state.playing, point: () => state.point,
    validLeap: () => state.valid, mode: () => state.mode || 'hold', emit: (event, data) => events.push({ event, data }) });
  return { aim, player, events, state };
}

test('holding Q does not cast or consume cooldown, and releasing uses the latest direction', () => {
  for (const character of ['alex', 'mira', 'bastion']) {
    const { aim, player, events, state } = setup(character);
    assert.equal(aim.begin('q'), true); assert.equal(aim.current.kind, 'cone');
    assert.equal(events.length, 0); assert.equal(player.qCd, 0);
    state.point = { x: -4, z: 3 }; aim.release('q');
    assert.deepEqual(events, [{ event: 'q', data: { x: -4, z: 3 } }]); assert.equal(aim.current, null);
  }
});

test('click confirmation casts only once even if its key is still held and later released', () => {
  const { aim, events } = setup('mira');
  aim.begin('c'); assert.equal(aim.current.kind, 'projectile');
  aim.confirm({ x: 8, z: 3 }); aim.release('c'); aim.confirm();
  assert.deepEqual(events, [{ event: 'c', data: { x: 8, z: 3 } }]);
});

test('Alex leap arms before release confirmation, without requiring a round trip from the server', () => {
  const { aim, events } = setup(); aim.begin('e'); aim.release('e');
  assert.deepEqual(events.map(e => e.event), ['dash', 'leap']);
});

test('invalid leap clicks retain the preview; invalid release cancels without a cast', () => {
  const { aim, state, events } = setup(); aim.begin('e'); state.valid = false;
  assert.equal(aim.confirm(), false); assert.equal(aim.current.kind, 'leap');
  aim.release('e'); assert.equal(aim.current, null);
  assert.deepEqual(events.map(e => e.event), ['dash', 'cancelLeap']);
});

test('cancel and switching skills discard the old aim, including the old key release', () => {
  const { aim, events } = setup(); aim.begin('e'); aim.begin('q'); aim.release('e');
  assert.equal(aim.current.key, 'q'); aim.cancel(); aim.release('q');
  assert.deepEqual(events.map(e => e.event), ['dash', 'cancelLeap']);
});

test('death, stun, flight, scene changes and cooldowns prevent unintended casts on release', () => {
  for (const condition of ['dead', 'stun', 'air', 'scene', 'cooldown']) {
    const { aim, player, state, events } = setup(); aim.begin('q');
    if (condition === 'dead') player.dead = true;
    if (condition === 'stun') player.stun = 1;
    if (condition === 'air') player.air = 1;
    if (condition === 'scene') state.playing = false;
    if (condition === 'cooldown') player.qCd = 3;
    aim.update(); aim.release('q'); assert.equal(events.length, 0); assert.equal(aim.current, null);
  }
});

test('summon C selects a direction while self buffs do not enter targeting mode', () => {
  for (const character of ['alex', 'bastion']) {
    const { aim, events } = setup(character); aim.begin('c'); assert.equal(aim.current.kind, 'summon');
    aim.release('c'); assert.equal(events[0].event, 'c');
  }
  for (const character of ['mira', 'bastion']) {
    const { aim, events } = setup(character); assert.equal(aim.begin('e'), false);
    assert.equal(aim.current, null); assert.equal(events.length, 0);
  }
});

test('Lucia Q selects a projectile direction, E selects a warp point, and C remains instant', () => {
  const { aim, player, events } = setup('lucia');
  aim.begin('q'); assert.equal(aim.current.kind, 'projectile'); aim.release('q');
  aim.begin('e'); assert.equal(aim.current.kind, 'warp'); assert.equal(events.length, 1);
  aim.release('e'); assert.deepEqual(events.map(e => e.event), ['q', 'dash']);
  assert.equal(aim.begin('c'), false);
  aim.begin('q'); player.warping = 1; aim.update(); aim.release('q'); assert.equal(events.length, 2);
});

test('toggle aim ignores release, confirms by click, cancels on repeated key and releases armed leaps', () => {
  const { aim, events, state } = setup(); state.mode = 'toggle';
  aim.begin('q'); aim.release('q'); assert.equal(aim.current.key,'q'); assert.equal(events.length,0);
  aim.begin('q'); assert.equal(aim.current,null); assert.equal(events.length,0);
  aim.begin('q'); aim.confirm(); aim.release('q'); assert.equal(events.length,1);
  aim.begin('e'); aim.release('e'); assert.equal(aim.current.kind,'leap');
  aim.begin('e'); assert.equal(aim.current,null); assert.equal(events.at(-1).event,'cancelLeap');
});

test('Darius aims all three attacks and cannot aim while charging, holding, held or thrown', () => {
  const { aim, player, events } = setup('darius');
  aim.begin('e'); assert.equal(aim.current.kind, 'charge'); aim.release('e');
  assert.equal(events[0].event, 'dash');
  for (const key of ['q','c']) { aim.begin(key); assert.equal(aim.current.kind,'cone'); aim.release(key); }
  assert.deepEqual(events.map(e => e.event), ['dash','q','c']);
  for (const flag of ['charging','grabbing','grabbed','flying']) {
    player[flag] = true; assert.equal(aim.begin('q'),false); player[flag] = false;
  }
});
