(() => {
  const el = id => document.getElementById(id), session = window.gameSession;
  let selfId = null, model = null, useModel = false;
  function screen(name) {
    el('lobby').hidden = name === 'game';
    el('hud').hidden = name !== 'game';
    for (const id of ['lobbyHome', 'matchmaking', 'characterSelect']) el(id).hidden = id !== name;
  }
  function renderCards(characters) {
    el('characterCards').replaceChildren();
    for (const character of characters) {
      const card = document.createElement('article');
      card.className = 'character-card'; card.dataset.id = character.id;
      card.style.setProperty('--accent', character.color);
      card.innerHTML = `<h3>${character.name}</h3><span class="role">${character.role}</span><dl>${['q', 'e', 'c'].map(key => `<dt>${key.toUpperCase()} / ${character.skills[key].name}</dt><dd>${character.skills[key].text}</dd>`).join('')}</dl><p>${character.passive}</p>`;
      const pick = document.createElement('button');
      pick.type = 'button'; pick.textContent = 'このキャラを選択'; pick.setAttribute('aria-pressed', 'false');
      pick.addEventListener('click', () => session.emit('selectCharacter', { id: character.id }));
      card.appendChild(pick); el('characterCards').appendChild(card);
    }
  }
  el('importMinionModel').addEventListener('change', async () => {
    const file = el('importMinionModel').files[0]; if (!file) return;
    try {
      const loaded = window.MinionPolicy.validate(JSON.parse(await file.text()));
      if (loaded.rulesVersion !== 'minion-v1-collection-1') throw Error('ゲームのルール版とモデルが一致しません。');
      model = loaded;
      el('cpuController').options[1].disabled = false;
      el('cpuController').options[1].textContent = loaded.modelName;
      el('cpuController').value = 'model';
      el('minionModelStatus').textContent = `${loaded.modelName} を読み込みました。対応キャラ：${loaded.characters.map(id => ArenaWorld.characterFor(id)?.name || id).join('、')}。CPU対戦で使用できます。`;
    } catch (error) { el('minionModelStatus').textContent = error.message; }
  });
  el('startMatch').addEventListener('click', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    useModel = mode === 'cpu' && el('cpuController').value === 'model' && !!model;
    session.start(mode, { model: useModel ? model : null });
    if (useModel) session.emit('selectCpuCharacter', { id: model.characters[0] });
  });
  for (const id of ['cancelMatch', 'leaveSelection', 'returnLobby']) el(id).addEventListener('click', () => session.stop());
  el('confirmCharacter').addEventListener('click', () => session.emit('confirmCharacter'));
  el('cpuCharacter').addEventListener('change', () => session.emit('selectCpuCharacter', { id: el('cpuCharacter').value }));
  session.on('lobby', () => { selfId = null; screen('lobbyHome'); });
  session.on('starting', ({ mode }) => {
    screen('matchmaking');
    el('matchingTitle').textContent = mode === 'online' ? '対戦相手を探しています…' : mode === 'cpu' ? 'CPU戦を準備しています…' : '練習試合を準備しています…';
    el('matchingMessage').textContent = mode === 'online' ? '参加した順にマッチングします。相手が見つかるまでお待ちください。' : 'キャラクターを選択して始めましょう。';
    el('restart').hidden = mode === 'online' || mode === 'replay';
  });
  session.on('init', data => {
    selfId = data.id; renderCards(data.characters);
    el('cpuCharacterPicker').hidden = !data.cpu;
    el('cpuCharacter').replaceChildren();
    for (const character of data.characters) {
      if (useModel && !model.characters.includes(character.id)) continue;
      const option = document.createElement('option');
      option.value = character.id; option.textContent = character.name;
      el('cpuCharacter').appendChild(option);
    }
  });
  session.on('state', state => {
    if (state.phase === 'playing' || state.phase === 'finished') { screen('game'); return; }
    if (state.phase !== 'selecting') return;
    screen('characterSelect');
    const me = state.players.find(p => p.id === selfId), opponent = state.players.find(p => p.id !== selfId);
    if (!me) return;
    if (state.cpu) {
      el('cpuCharacter').value = opponent?.character || 'alex';
      el('cpuCharacter').disabled = me.confirmed;
    }
    for (const card of el('characterCards').children) {
      const chosen = card.dataset.id === me.character;
      card.classList.toggle('selected', chosen);
      card.querySelector('button').disabled = me.confirmed;
      card.querySelector('button').setAttribute('aria-pressed', String(chosen));
    }
    el('confirmCharacter').disabled = !me.character || me.confirmed;
    el('confirmCharacter').textContent = me.confirmed ? '相手の準備を待っています…' : state.solo || state.cpu ? 'このキャラで試合開始' : '選択を確定・準備完了';
    el('selectionStatus').textContent = me.confirmed ? '準備完了。双方が確定すると試合が始まります。' : 'Q・E・Cとパッシブを確認して、出撃するキャラを選んでください。';
    el('opponentSelection').textContent = state.solo ? 'オフライン：1人用タワー攻略' : `${state.cpu ? useModel ? 'ミニオン v1' : 'CPU' : '相手'}：${ArenaWorld.characterFor(opponent?.character)?.name || '選択中'}${opponent?.confirmed ? '（準備完了）' : ''}`;
  });
  function failure(message) { screen('matchmaking'); el('matchingTitle').textContent = '試合を続けられません'; el('matchingMessage').textContent = message; }
  session.on('matchEnded', data => failure(data.reason));
  session.on('disconnect', () => failure('サーバーとの接続が切れました。ロビーからもう一度参加してください。'));
  session.on('connect_error', () => failure('サーバーに接続できません。オフラインはロビーから開始できます。'));
  screen('lobbyHome');
})();
