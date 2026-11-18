// 照準中のスキルを1つだけ保持し、クリック後のキー解放による二重発動を防ぐ。
function createSkillAim({ self, playing, point, validLeap, emit, changed = () => {} }) {
  let current = null;
  const set = value => { current = value; changed(value); };
  const cancel = () => {
    if (current?.kind === 'leap') emit('cancelLeap');
    if (current) set(null);
  };
  const usable = player => playing() && player && !player.dead && !(player.stun > 0) && !(player.air > 0);
  function begin(key) {
    const player = self();
    if (!usable(player) || player[key + 'Cd'] > 0) return false;
    const kind = key === 'q' ? 'cone' : key === 'e' && player.character === 'alex' ? 'leap'
      : key === 'c' ? player.character === 'mira' ? 'projectile' : 'summon' : null;
    if (!kind) return false;
    cancel();
    set({ key, kind, character: player.character });
    if (kind === 'leap') emit('dash');
    return true;
  }
  function confirm(target = point(), released = false) {
    const player = self(), aim = current;
    if (!aim) return false;
    if (!usable(player) || player.character !== aim.character || player[aim.key + 'Cd'] > 0) { cancel(); return false; }
    if (!Number.isFinite(target?.x) || !Number.isFinite(target?.z) || (aim.kind === 'leap' && !validLeap(target, player))) {
      if (released) cancel();
      return false;
    }
    set(null);
    emit(aim.kind === 'leap' ? 'leap' : aim.key, target);
    return true;
  }
  function release(key) { if (current?.key === key) return confirm(point(), true); return false; }
  function update() {
    const player = self();
    if (current && (!usable(player) || player.character !== current.character || player[current.key + 'Cd'] > 0)) cancel();
  }
  return { get current() { return current; }, begin, confirm, release, cancel, update };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createSkillAim };
