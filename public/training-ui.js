(() => {
  'use strict';
  const $ = id => document.getElementById(id), session = window.gameSession, data = window.MinionData, store = data.storage();
  let selected = null, position = 0, paused = false, replayId = null;
  const unsaved = new Map();
  const pending = new Set();
  const message = text => { $('recordingsMessage').textContent = text; };
  const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${Math.floor(seconds * 10 + 1e-6) % 10}`;
  const recorder = window.trainingRecorder = new data.Recorder(record => {
    unsaved.set(record.id, record);
    const saving = store.put(record).then(() => {
      unsaved.delete(record.id); message('記録をこのブラウザーに保存しました。');
    }).catch(() => message('ブラウザーへの保存に失敗しました。記録一覧からJSONを保存してください。このページを閉じると未保存の記録は失われます。'));
    pending.add(saving); saving.finally(() => pending.delete(saving));
  });
  recorder.enabled = $('recordTraining').checked;
  $('recordTraining').addEventListener('change', () => { recorder.enabled = $('recordTraining').checked; });
  const download = (name, content, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const safe = fn => async () => { try { await fn(); } catch (error) { message(error.message || '処理に失敗しました。'); } };
  const actor = () => $('recordingActor').value;
  async function saveSelection() {
    unsaved.set(selected.id, selected);
    await store.put(selected); unsaved.delete(selected.id);
  }
  function renderRanges() {
    $('trainingRanges').replaceChildren();
    selected.ranges.forEach((range, index) => {
      const li = document.createElement('li');
      li.textContent = `${selected.actors[range.actor].source === 'human' ? '人間' : 'CPU'} · ${clock(range.start)}–${clock(range.end)} ${range.label}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '採用を取り消す';
      remove.addEventListener('click', safe(async () => { selected.ranges.splice(index, 1); renderRanges(); await saveSelection(); }));
      li.appendChild(remove); $('trainingRanges').appendChild(li);
    });
  }
  async function choose(id) {
    selected = unsaved.get(id) || await store.get(id);
    $('recordingDetails').hidden = !selected;
    if (!selected) return;
    data.validate(selected);
    $('recordingActor').replaceChildren();
    for (const [id, info] of Object.entries(selected.actors)) {
      const state = selected.entries.find(e => e.kind === 'frame')?.views[id];
      const character = state?.players.find(p => p.id === id)?.character;
      const option = document.createElement('option'); option.value = id;
      option.textContent = `${info.init.teamSizes ? `${info.init.slot ? 'B' : 'A'}チーム ${1 + (info.init.member || 0)}人目 / ` : ''}${info.source === 'human' ? '人間' : info.source === 'model' ? 'CPU（学習モデル）' : 'CPU（アルゴリズム）'} / ${ArenaWorld.characterFor(character)?.name || character}`;
      $('recordingActor').appendChild(option);
    }
    const result = selected.winner === null ? '未完了' : `陣営${selected.winner + 1}の勝利`;
    const status = { finished: '試合終了', stopped: '途中保存', restart: 'リスタート前', limit: '記録時間の上限' }[selected.status] || '保存済み';
    $('recordingInfo').textContent = `${new Date(selected.createdAt).toLocaleString('ja-JP')} · ${clock(selected.duration)} · ${result} · ${status}${unsaved.has(selected.id) ? ' · 未保存' : ''}`;
    $('rangeStart').value = 0; $('rangeEnd').value = String(selected.duration);
    $('rangeEnd').max = selected.duration; $('rangeStart').max = selected.duration;
    $('includeAlgorithm').checked = false; renderRanges();
  }
  async function refresh(prefer) {
    await Promise.all([...pending]);
    let records = [];
    try { records = await store.list(); } catch { message('ブラウザーの保存領域を利用できません。未保存の記録はJSONで保存してください。'); }
    const all = new Map(records.map(r => [r.id, r]));
    for (const [id, record] of unsaved) all.set(id, record);
    $('recordingList').replaceChildren();
    for (const record of [...all.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const option = document.createElement('option'); option.value = record.id;
      option.textContent = `${new Date(record.createdAt).toLocaleString('ja-JP')} · ${clock(record.duration)}${unsaved.has(record.id) ? ' · 未保存' : ''}`;
      $('recordingList').appendChild(option);
    }
    if (prefer && all.has(prefer)) $('recordingList').value = prefer;
    await choose($('recordingList').value);
  }
  async function openLibrary() {
    if (session.connected) session.stop();
    if (session.replaying) session.pauseReplay(true);
    $('recordingsDialog').showModal(); await refresh(replayId || selected?.id);
  }
  for (const id of ['openRecordings', 'reviewRecording', 'replayLibrary']) $(id).addEventListener('click', safe(openLibrary));
  $('closeRecordings').addEventListener('click', () => $('recordingsDialog').close());
  $('recordingList').addEventListener('change', safe(() => choose($('recordingList').value)));
  $('playRecording').addEventListener('click', safe(() => {
    if (!selected) return;
    session.playReplay(selected, actor()); replayId = selected.id; $('recordingsDialog').close();
  }));
  $('downloadRecording').addEventListener('click', () => { if (selected) download(`minion-v1-${selected.id}.json`, JSON.stringify(selected)); });
  $('deleteRecording').addEventListener('click', safe(async () => {
    if (!selected) return;
    await store.remove(selected.id); unsaved.delete(selected.id); selected = null; await refresh();
  }));
  $('addTrainingRange').addEventListener('click', safe(async () => {
    if (!selected) return;
    data.addRange(selected, actor(), Number($('rangeStart').value), Number($('rangeEnd').value), $('rangeLabel').value);
    renderRanges(); await saveSelection(); message('採用区間を保存しました。');
  }));
  $('useReplayTime').addEventListener('click', () => {
    if (selected?.id !== replayId) { message('先にこの試合を再生してください。'); return; }
    $('rangeStart').value = position.toFixed(3);
  });
  $('exportTraining').addEventListener('click', safe(() => {
    if (!selected) return;
    const samples = data.dataset(selected, $('includeAlgorithm').checked);
    if (!samples.length) { message('書き出すデータがありません。対象の視点で区間を採用してください。CPU区間はチェックが必要です。'); return; }
    const manifest = { kind: 'manifest', schema: 'axe-gozen-imitation/1', model: selected.model, episodeId: selected.id,
      createdAt: selected.createdAt, actors: selected.actors, ranges: selected.ranges, samples: samples.length,
      splitKey: selected.id, actionSemantics: 'requested inputs; derived CPU controls are labeled; no reward assigned' };
    download(`minion-v1-training-${selected.id}.jsonl`, [manifest, ...samples].map(v => JSON.stringify(v)).join('\n') + '\n', 'application/x-ndjson');
    message(`${samples.length}件を書き出しました。学習用と評価用は試合IDで分けてください。`);
  }));
  $('importRecording').addEventListener('change', safe(async () => {
    const file = $('importRecording').files[0]; if (!file) return;
    const record = data.validate(JSON.parse(await file.text()));
    unsaved.set(record.id, record);
    try { await store.put(record); unsaved.delete(record.id); } catch { message('保存領域を利用できないため、このページを開いている間だけ利用できます。'); }
    await refresh(record.id); $('importRecording').value = '';
  }));
  $('replayPause').addEventListener('click', () => session.pauseReplay(!paused));
  $('replayTime').addEventListener('input', () => session.seekReplay(Number($('replayTime').value)));
  $('replayExit').addEventListener('click', () => session.stop());
  session.on('replayPosition', state => {
    position = state.time; paused = state.paused; $('replayControls').hidden = false;
    $('replayTime').max = state.duration; $('replayTime').value = state.time;
    $('replayPause').textContent = paused ? '再生' : '一時停止'; $('replayClock').textContent = `${clock(state.time)} / ${clock(state.duration)}`;
  });
  session.on('lobby', () => { $('replayControls').hidden = true; replayId = null; });
  session.on('starting', ({ mode }) => { $('reviewRecording').hidden = mode === 'online' || mode === 'replay'; });
  setInterval(() => {
    const record = recorder.current;
    $('recordingStatus').hidden = !record && !unsaved.size && !pending.size;
    if (record) $('recordingStatus').textContent = `● 教師データ記録中 ${clock(record.duration)}`;
    else if (pending.size) $('recordingStatus').textContent = '教師データを保存しています…';
    else if (unsaved.size) $('recordingStatus').textContent = '未保存の記録があります。「記録・リプレイ」からJSONを保存してください。';
  }, 1000);
  window.addEventListener('beforeunload', event => {
    if (recorder.current || unsaved.size || pending.size) { event.preventDefault(); event.returnValue = ''; }
  });
})();
