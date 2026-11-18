(() => {
  const defaults = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', q: 'KeyQ', e: 'KeyE', c: 'KeyC', b: 'KeyB' };
  let saved;
  try { saved = JSON.parse(localStorage.getItem('axe-gozen-controls')); } catch {}
  const bindings = { ...defaults };
  if (saved?.bindings && Object.keys(defaults).every(k => typeof saved.bindings[k] === 'string') && new Set(Object.values(saved.bindings)).size === 8) Object.assign(bindings, saved.bindings);
  let mode = saved?.mode === 'toggle' ? 'toggle' : 'hold';
  let pending = null;
  const label = code => code.replace(/^Key|^Digit/, '');
  const panel = document.createElement('details'); panel.id = 'controlsPanel';
  panel.innerHTML = '<summary>操作設定</summary><label>方向選択 <select id="aimMode"><option value="hold">ホールド</option><option value="toggle">切り替え</option></select></label><div id="keyBindings"></div><button id="resetControls" type="button">初期設定に戻す</button><p id="controlHint">変更するキーを押してから割り当てます。重複キーは交換します。</p>';
  document.body.append(panel);
  const select = document.getElementById('aimMode'); select.value = mode;
  const names = { w: '上へ移動', a: '左へ移動', s: '下へ移動', d: '右へ移動', q: 'Qスキル', e: 'Eスキル', c: 'Cスキル', b: 'リコール' };
  const render = () => {
    const root = document.getElementById('keyBindings'); root.replaceChildren();
    for (const action of Object.keys(defaults)) {
      const row = document.createElement('label'); row.textContent = names[action];
      const button = document.createElement('button'); button.type = 'button'; button.textContent = pending === action ? 'キー入力待ち…' : label(bindings[action]);
      button.onclick = () => { pending = action; render(); }; row.append(button); root.append(row);
    }
    for (const action of ['q', 'e', 'c', 'b']) {
      const skill = document.getElementById(action + 'Skill'); if (skill) skill.firstChild.textContent = label(bindings[action]);
    }
    document.getElementById('help').textContent = `${['w','a','s','d'].map(k => label(bindings[k])).join('/')}: 移動 / 右クリック: 移動・通常攻撃 / 方向選択: ${mode === 'hold' ? '長押し→離すか左クリックで発動' : '押して照準→左クリックで発動、同じキーでキャンセル'} / Esc・右クリック: キャンセル / ${label(bindings.b)}: リコール。エネルギー獲得で敵の領域が縮小。敵タワー5本破壊で勝利。`;
  };
  const save = () => { try { localStorage.setItem('axe-gozen-controls', JSON.stringify({ bindings, mode })); } catch {} render(); window.dispatchEvent(new Event('controlschange')); };
  select.onchange = () => { mode = select.value; pending = null; save(); };
  document.getElementById('resetControls').onclick = () => { Object.assign(bindings, defaults); mode = 'hold'; select.value = mode; pending = null; save(); };
  window.addEventListener('keydown', ev => {
    if (!pending) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (ev.code === 'Escape') { pending = null; render(); return; }
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || ['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight','Tab'].includes(ev.code)) return;
    const other = Object.keys(bindings).find(k => bindings[k] === ev.code);
    if (other) bindings[other] = bindings[pending];
    bindings[pending] = ev.code; pending = null; save();
  }, true);
  panel.addEventListener('toggle', () => { if (!panel.open) { pending = null; render(); } });
  window.gameControls = { action: code => Object.keys(bindings).find(k => bindings[k] === code), get mode() { return mode; } };
  render();
})();
