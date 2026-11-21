(() => {
  'use strict';
  const $ = id => document.getElementById(id), session = window.gameSession;
  const mode = () => document.querySelector('input[name="mode"]:checked').value;
  let builder, room = null, uploading = false;
  function refresh() {
    const enabled = $('useTeamSetup').checked;
    const automated = ['series', 'competition'].includes(mode());
    $('teamSetupDetails').hidden = automated; $('teamSetupBody').hidden = !enabled;
    $('teamOnlineTools').hidden = !enabled || mode() !== 'online';
    $('startMatch').disabled = enabled && !automated && builder && !builder.ready();
  }
  builder = new TeamBuilder([$('teamMembers0'), $('teamMembers1')], { prefix: 'team', changed: refresh });
  window.teamSetup = { getConfig: () => $('useTeamSetup').checked ? builder.getTeams() : null };
  for (let t = 0; t < 2; t++) $(`teamSize${t}`).addEventListener('change', () => builder.resize(t, Number($(`teamSize${t}`).value)));
  $('useTeamSetup').addEventListener('change', refresh);
  document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => { builder.setMode(mode() === 'online' ? 'online' : 'local'); refresh(); }));
  $('joinTeamRoom').addEventListener('click', () => session.joinTeamRoom($('joinTeamCode').value, Number($('joinTeamSide').value)));
  const make = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const option = (value, text) => { const el = make('option', text); el.value = value; return el; };
  const command = (event, data) => { $('teamRoomError').textContent = ''; session.roomCommand(event, data); };
  function paintRoom(state) {
    room = state; $('teamRoomCodeText').textContent = state.code; $('teamRoomError').textContent = '';
    const members = state.teams.flat(), humans = members.filter(m => m.kind === 'human'), pending = members.some(m => m.kind === 'model' && !m.model.ready);
    $('teamRoomStatus').textContent = `${state.teams[0].length} 対 ${state.teams[1].length}｜人間 ${humans.filter(m => m.occupied).length}/${humans.length}人参加・${humans.filter(m => m.ready).length}人準備完了${pending ? '｜CPUモデル送信待ち' : ''}${state.host ? '｜あなたがホストです' : ''}`;
    for (let t = 0; t < 2; t++) {
      const root = $(`teamRoomMembers${t}`); root.replaceChildren();
      state.teams[t].forEach((m, i) => {
        const row = make('section'); row.className = 'team-member';
        row.appendChild(make('h4', `${i + 1}人目 ${m.self ? '（自分）' : ''}：${m.label}`));
        row.appendChild(make('p', m.kind === 'human' ? m.occupied ? `${m.characterName} / ${m.ready ? '準備完了' : '準備中'}` : '人間プレイヤーの空席'
          : `${m.kind === 'model' ? m.model.ready ? m.model.name : 'モデル未設定' : 'CPU：アルゴリズム'} / ${m.characterName}`));
        if (state.host && !m.occupied) {
          const kind = make('select'); for (const k of ['human', 'algorithm', 'model']) kind.appendChild(option(k, { human: '人間用の席', algorithm: 'CPU：アルゴリズム', model: 'CPU：学習モデル' }[k]));
          kind.value = m.kind; kind.setAttribute('aria-label', `${t ? 'B' : 'A'}${i + 1} 操作主体`);
          kind.addEventListener('change', () => command('setTeamSeat', { team: t, member: i, kind: kind.value, character: m.character })); row.appendChild(kind);
          if (m.kind !== 'human') {
            const chars = make('select');
            for (const c of ArenaWorld.CHARACTERS) if (m.kind !== 'model' || !m.model.ready || m.model.characters.includes(c.id)) chars.appendChild(option(c.id, c.name));
            chars.value = m.character; chars.setAttribute('aria-label', `${t ? 'B' : 'A'}${i + 1} キャラクター`);
            chars.addEventListener('change', () => command('setTeamSeat', { team: t, member: i, kind: m.kind, character: chars.value })); row.appendChild(chars);
          }
          if (m.kind === 'model') {
            const file = make('input'); file.type = 'file'; file.accept = '.json,application/json';
            file.setAttribute('aria-label', `${t ? 'B' : 'A'}${i + 1} モデル`);
            file.addEventListener('change', async () => {
              try {
                if (!file.files[0]) return;
                file.disabled = true; const model = MinionPolicy.validate(JSON.parse(await file.files[0].text()));
                command('setTeamModel', { team: t, member: i, model, fileName: file.files[0].name, character: m.character });
              } catch (error) { $('teamRoomError').textContent = error.message; file.disabled = false; }
            }); row.appendChild(file);
          }
          if (state.teams[t].length > 1) {
            const remove = make('button', 'この席を削除'); remove.addEventListener('click', () => command('setTeamSeat', { team: t, member: i, remove: true })); row.appendChild(remove);
          }
        }
        root.appendChild(row);
      });
      const actions = $(`teamRoomAdd${t}`); actions.replaceChildren();
      if (state.host) for (const kind of ['algorithm', 'human']) {
        const button = make('button', kind === 'human' ? '人間の席を追加' : 'CPUを追加'); button.disabled = state.teams[t].length >= 5;
        button.addEventListener('click', () => command('setTeamSeat', { team: t, member: state.teams[t].length, kind, character: 'alex' })); actions.appendChild(button);
      }
    }
    const self = state.self && state.teams[state.self.team][state.self.member];
    $('teamRoomReady').disabled = !self || pending || state.phase !== 'waiting';
    $('teamRoomReady').textContent = self?.ready ? '準備を解除' : '準備完了';
    for (const id of ['teamRoomCharacter', 'teamRoomSide', 'teamRoomMove']) $(id).disabled = !self || state.phase !== 'waiting';
    if (self) { $('teamRoomCharacter').value = self.character; $('teamRoomSide').value = String(state.self.team); }
    if (uploading) $('teamRoomPanel').querySelectorAll('input,select,button').forEach(el => { if (el.id !== 'leaveTeamRoom') el.disabled = true; });
  }
  for (const c of ArenaWorld.CHARACTERS) $('teamRoomCharacter').appendChild(option(c.id, c.name));
  $('teamRoomReady').addEventListener('click', () => {
    if (!room?.self) return;
    $('teamRoomReady').disabled = true;
    command('teamRoomReady', { character: $('teamRoomCharacter').value, ready: !room.teams[room.self.team][room.self.member].ready });
  });
  $('teamRoomCharacter').addEventListener('change', () => command('teamRoomReady', { character: $('teamRoomCharacter').value, ready: false }));
  $('teamRoomMove').addEventListener('click', () => command('teamRoomMove', { team: Number($('teamRoomSide').value) }));
  $('leaveTeamRoom').addEventListener('click', () => session.stop());
  session.on('teamRoom', paintRoom);
  session.on('teamRoomError', message => { $('teamRoomError').textContent = message; if (room?.self) $('teamRoomReady').disabled = false; });
  session.on('teamRoomStarted', () => { if (room) room.phase = 'playing'; $('teamRoomReady').disabled = true; });
  session.on('teamModelsUploading', active => { uploading = active; if (room) paintRoom(room); });
  session.on('lobby', () => { room = null; uploading = false; $('teamRoomCodeText').textContent = '—'; $('teamRoomReady').disabled = true; });
  refresh();
})();
