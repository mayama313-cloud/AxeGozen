const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function element(id) {
  const handlers = {}, captured = new Set(), classes = new Set();
  const node = { id, style: {}, disabled: false, hidden: false,
    classList: { contains: c => classes.has(c), add: c => classes.add(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    fire(type, data = {}) { for (const fn of handlers[type] || []) fn({ pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 50, preventDefault() {}, ...data }); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture(id) { captured.delete(id); node.fire('lostpointercapture', { pointerId: id }); },
    closest: selector => selector === '#touchCancel' && id === 'touchCancel' ? node : null,
  };
  return node;
}
function setup() {
  const document = element('document'), root = element('root'), window = element('window');
  Object.assign(document, { documentElement: root, elementFromPoint: () => null });
  const sandbox = { document, matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener: window.addEventListener.bind(window) };
  vm.createContext(sandbox); vm.runInContext(readFileSync(require.resolve('./public/touch-controls.js'), 'utf8'), sandbox);
  const nodes = { canvas: element('canvas'), stick: element('stick'), knob: element('knob'), skills: { q: element('q'), b: element('b') }, attackButton: element('attack'), cancelButton: element('touchCancel') };
  const events = [], moves = [], state = { ready: true, target: null };
  const aim = { current: null, begin(key) { this.current = { key }; return true; }, cancel() { this.current = null; }, confirm(point) { events.push(['cast', point]); this.current = null; } };
  const controls = sandbox.createTouchControls({ ...nodes, canPlay: () => state.ready, aim, move: (x,z) => moves.push([x,z]),
    targetAt: ev => ({ x: ev.clientX, z: ev.clientY }), setTarget: p => { state.target = p; }, defaultTarget: () => ({ x: 4, z: 0 }),
    instant: () => false, activate() {}, command: () => events.push(['command']), attack: () => events.push(['attack']), recall: () => events.push(['recall']) });
  return { ...nodes, window, aim, controls, moves, events, state };
}

test('independent fingers can move and select or cancel a skill without releasing the stick', () => {
  const { stick, skills, cancelButton, moves, aim } = setup();
  stick.fire('pointerdown', { pointerId: 1, clientX: 82 });
  assert.ok(moves.at(-1)[0] > 0);
  skills.q.fire('pointerdown', { pointerId: 2 }); skills.q.fire('pointerup', { pointerId: 2 });
  assert.equal(aim.current.key, 'q');
  stick.fire('pointermove', { pointerId: 1, clientX: 18 }); assert.ok(moves.at(-1)[0] < 0);
  cancelButton.fire('pointerdown', { pointerId: 3 }); assert.equal(aim.current, null);
  stick.fire('pointermove', { pointerId: 1, clientX: 82 }); assert.ok(moves.at(-1)[0] > 0);
  stick.fire('pointerup', { pointerId: 1 }); assert.deepEqual(moves.at(-1), [0,0]);
});

test('drag release casts once, while tapping a skill waits for a battlefield touch', () => {
  const { skills, canvas, events, aim } = setup();
  skills.q.fire('pointerdown', { pointerId: 2 });
  skills.q.fire('pointermove', { pointerId: 2, clientX: 100, clientY: 10 });
  skills.q.fire('pointerup', { pointerId: 2, clientX: 100, clientY: 10 });
  assert.equal(events.length, 1); assert.equal(events[0][0], 'cast'); assert.equal(aim.current, null);
  skills.q.fire('pointerdown', { pointerId: 3 }); skills.q.fire('pointerup', { pointerId: 3 });
  assert.equal(events.length, 1);
  canvas.fire('pointerdown', { pointerId: 4 }); canvas.fire('pointerup', { pointerId: 4 });
  assert.equal(events.length, 2); assert.equal(events[1][0], 'cast');
  canvas.fire('pointerdown', { pointerId: 5 }); canvas.fire('pointerup', { pointerId: 5 });
  assert.equal(events[2][0], 'command');
});

test('interrupted touches and viewport changes stop motion and cancel aiming without casting', () => {
  const { stick, skills, aim, moves, events, window } = setup();
  stick.fire('pointerdown', { clientX: 82 }); stick.fire('pointercancel'); assert.deepEqual(moves.at(-1), [0,0]);
  skills.q.fire('pointerdown', { pointerId: 2 }); skills.q.fire('pointercancel', { pointerId: 2 }); assert.equal(aim.current, null);
  stick.fire('pointerdown', { pointerId: 3, clientX: 82 });
  skills.q.fire('pointerdown', { pointerId: 4 }); window.fire('resize');
  assert.equal(aim.current, null); assert.deepEqual(moves.at(-1), [0,0]); assert.equal(events.length, 0);
});
