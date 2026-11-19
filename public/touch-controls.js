// Pointer Eventsを使い、移動と照準を別の指で操作する。
function createTouchControls({ canvas, stick, knob, skills, attackButton, cancelButton, canPlay, aim, move, targetAt, setTarget, defaultTarget, instant, activate, command, attack, recall }) {
  const media = matchMedia('(pointer: coarse), (any-pointer: coarse), (max-width: 900px)');
  let moving = null, aiming = null, field = null;
  const active = () => document.documentElement.classList.contains('touch-ui');
  const layout = () => { document.documentElement.classList.toggle('touch-ui', media.matches); reset(); };
  const stopMove = () => {
    const id = moving; moving = null;
    if (id !== null && stick.hasPointerCapture(id)) stick.releasePointerCapture(id);
    knob.style.transform = 'translate(-50%, -50%)'; move(0, 0);
  };
  function reset() {
    stopMove();
    const old = aiming, oldField = field; aiming = null; field = null;
    if (old?.button.hasPointerCapture(old.id)) old.button.releasePointerCapture(old.id);
    if (oldField !== null && canvas.hasPointerCapture(oldField)) canvas.releasePointerCapture(oldField);
  }
  function steer(ev) {
    const box = stick.getBoundingClientRect(), limit = box.width * 0.32;
    let x = ev.clientX - box.left - box.width / 2, y = ev.clientY - box.top - box.height / 2;
    const length = Math.hypot(x, y);
    if (length > limit) { x *= limit / length; y *= limit / length; }
    knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    move(length < limit * 0.15 ? 0 : x / limit, length < limit * 0.15 ? 0 : y / limit);
  }
  stick.addEventListener('pointerdown', ev => {
    if (!canPlay() || moving !== null) return;
    ev.preventDefault(); moving = ev.pointerId; stick.setPointerCapture(moving); steer(ev);
  });
  stick.addEventListener('pointermove', ev => { if (moving === ev.pointerId) { ev.preventDefault(); steer(ev); } });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(event, ev => { if (moving === ev.pointerId) stopMove(); });
  for (const [key, button] of Object.entries(skills)) {
    button.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      if (!canPlay() || button.disabled || aiming) return;
      if (key === 'b') { aim.cancel(); recall(); return; }
      if (aim.current?.key === key) { aim.cancel(); update(); return; }
      if (instant(key)) { aim.cancel(); activate(key); update(); return; }
      if (!aim.begin(key)) return;
      setTarget(defaultTarget(key));
      aiming = { id: ev.pointerId, button, key, x: ev.clientX, y: ev.clientY, dragged: false };
      button.setPointerCapture(ev.pointerId); update();
    });
    button.addEventListener('pointermove', ev => {
      if (aiming?.id !== ev.pointerId || aiming.button !== button) return;
      ev.preventDefault();
      if (Math.hypot(ev.clientX-aiming.x, ev.clientY-aiming.y) > 12) aiming.dragged = true;
      if (aiming.dragged) setTarget(targetAt(ev));
    });
    button.addEventListener('pointerup', ev => {
      if (aiming?.id !== ev.pointerId || aiming.button !== button) return;
      ev.preventDefault(); const gesture = aiming; aiming = null;
      if (button.hasPointerCapture(ev.pointerId)) button.releasePointerCapture(ev.pointerId);
      if (gesture.dragged) {
        if (document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#touchCancel')) aim.cancel();
        else if (canPlay()) { const target = targetAt(ev); setTarget(target); aim.confirm(target, true); }
      }
      update();
    });
    for (const event of ['pointercancel', 'lostpointercapture']) button.addEventListener(event, ev => {
      if (aiming?.id === ev.pointerId && aiming.button === button) { aiming = null; aim.cancel(); update(); }
    });
  }
  canvas.addEventListener('pointerdown', ev => {
    if (!['touch', 'pen'].includes(ev.pointerType) || !canPlay() || field !== null || aiming) return;
    ev.preventDefault(); document.documentElement.classList.add('touch-ui');
    field = ev.pointerId; canvas.setPointerCapture(ev.pointerId);
    if (aim.current) setTarget(targetAt(ev));
  });
  canvas.addEventListener('pointermove', ev => {
    if (field === ev.pointerId && aim.current) { ev.preventDefault(); setTarget(targetAt(ev)); }
  });
  canvas.addEventListener('pointerup', ev => {
    if (field !== ev.pointerId) return;
    ev.preventDefault(); field = null;
    if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (!canPlay()) return;
    if (aim.current) { const target = targetAt(ev); setTarget(target); aim.confirm(target); }
    else command(ev);
    update();
  });
  for (const event of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(event, ev => {
    if (field === ev.pointerId) { field = null; aim.cancel(); update(); }
  });
  attackButton.addEventListener('pointerdown', ev => { ev.preventDefault(); if (canPlay()) { aim.cancel(); attack(); update(); } });
  cancelButton.addEventListener('pointerdown', ev => { ev.preventDefault(); aim.cancel(); update(); });
  document.addEventListener('contextmenu', ev => { if (ev.target.closest('[data-touch-control], #skills')) ev.preventDefault(); });
  function update() {
    cancelButton.hidden = !aim.current;
    for (const [key, button] of Object.entries(skills)) button.classList.toggle('targeting', aim.current?.key === key);
    if (!canPlay() && (moving !== null || aiming || field !== null)) reset();
  }
  media.addEventListener('change', layout);
  addEventListener('resize', () => { reset(); aim.cancel(); update(); });
  addEventListener('blur', () => { reset(); aim.cancel(); update(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { reset(); aim.cancel(); update(); } });
  layout();
  return { reset, update, get active() { return active(); } };
}
