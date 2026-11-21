(() => {
  'use strict';
  const $ = id => document.getElementById(id), session = window.gameSession;
  const loaded = [{ model: null, token: 0, loading: false }, { model: null, token: 0, loading: false }];
  let summary = null, results = [], starting = false, failure = null;
  const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const textAll = (selector, value) => document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
  const active = () => starting || ['running', 'paused'].includes(summary?.status);
  function controls() {
    $('seriesSettings').disabled = active();
    $('seriesStart').disabled = active() || loaded.some((entry, i) => $(`seriesKind${i}`).value === 'model' && (!entry.model || entry.loading));
    for (const button of document.querySelectorAll('[data-series-action]')) {
      const action = button.dataset.seriesAction;
      if (['pause', 'draw', 'stop'].includes(action)) button.disabled = !summary || !['running', 'paused'].includes(summary.status);
      if (action === 'pause') button.textContent = summary?.status === 'paused' ? '再開' : '一時停止';
      if (action === 'download') button.disabled = !summary;
    }
  }
  function fillCharacters(i) {
    const select = $(`seriesCharacter${i}`), previous = select.value;
    const model = $(`seriesKind${i}`).value === 'model' ? loaded[i].model : null;
    select.replaceChildren();
    for (const character of ArenaWorld.CHARACTERS) if (!model || model.characters.includes(character.id)) {
      const option = document.createElement('option'); option.value = character.id; option.textContent = character.name; select.appendChild(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }
  function label(model) {
    const revision = model.objectivePolicy ? '目的選択 v7' : { 'minion-defense-alarm/6': '防衛 v6', 'minion-defense-adapter/5': '防衛 v5',
      'minion-tactical/4': '強化学習 v4', 'minion-tactical/3': 'ファーム v3', 'minion-tactical/2': '強化学習 v2' }[model.featureVersion] || (model.reinforcementLearning ? '強化学習' : '模倣学習');
    return `${model.modelName || '学習モデル'} / ${revision}`;
  }
  function automaticName(i) {
    const entry = loaded[i], input = $(`seriesLabel${i}`), code = i === 0 ? 'A' : 'B';
    if (input.value !== code && input.value !== entry.autoLabel) return;
    const next = $(`seriesKind${i}`).value === 'algorithm' ? 'アルゴリズム' : entry.model ? label(entry.model) : code;
    input.value = next; entry.autoLabel = next;
  }
  function syncView(source) {
    if (source === 'live') { $('seriesSpeed').value = $('seriesSpeedLive').value; $('seriesWatch').value = $('seriesWatchLive').value; }
    $('seriesSpeedLive').value = $('seriesSpeed').value; $('seriesWatchLive').value = $('seriesWatch').value;
    if (session.mode === 'series' && session.connected) session.seriesView({ render: $('seriesRender').checked,
      speed: Number($('seriesSpeed').value), watch: Number($('seriesWatch').value) });
  }
  function tableRow(values) {
    const row = document.createElement('tr');
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value); row.appendChild(cell); }
    return row;
  }
  function paint(historyChanged = false) {
    controls();
    if (!summary) return;
    const names = summary.entries.map(e => e.label), codes = ['A', 'B'];
    let status = `先に${summary.firstTo}勝でシリーズ勝利。決着 ${summary.decided}試合・引き分け ${summary.draws}試合。`;
    if (summary.status === 'complete') status = `${codes[summary.champion]}：${names[summary.champion]} が${summary.firstTo}本先取しました。`;
    if (summary.status === 'paused') status = '一時停止中。' + status;
    if (summary.status === 'stopped') status = '中止しました。未決着の試合は勝敗に含めません。';
    if (failure) status = failure;
    textAll('[data-series-status]', status);
    textAll('[data-series-score]', `A ${summary.wins[0]} − ${summary.wins[1]} B`);
    const c = summary.current;
    textAll('[data-series-clock]', `第${c.number}試合　${time(c.seconds)}｜初期陣営：A=${c.entryBySlot.indexOf(0) === 0 ? '左下' : '右上'} / B=${c.entryBySlot.indexOf(1) === 0 ? '左下' : '右上'}`);
    $('seriesStandings').replaceChildren(...summary.entries.map((e, i) => tableRow([
      `${codes[i]}：${e.label}`, `${e.kind === 'algorithm' ? 'アルゴリズム' : e.model.name} / ${e.characterName}`,
      summary.wins[i], summary.winRates[i] === null ? '—' : `${(summary.winRates[i] * 100).toFixed(1)}%`,
      `${c.stats[i].towers}/5`, c.stats[i].energy
    ])));
    if (historyChanged) {
      const recent = results.slice(-100).reverse();
      $('seriesResults').replaceChildren(...recent.map(r => tableRow([r.number,
        r.winner === null ? r.reason === 'time-limit' ? '引き分け（時間上限）' : '引き分け（手動）' : `${codes[r.winner]}：${names[r.winner]} の勝利`,
        time(r.seconds), `左下 ${codes[r.entryBySlot[0]]} / 右上 ${codes[r.entryBySlot[1]]}`,
        `${r.stats[0].towers} / ${r.stats[1].towers}`, `${r.stats[0].energy} / ${r.stats[1].energy}`])));
      $('seriesResultsNote').textContent = results.length ? `終了した${results.length}試合${results.length > 100 ? 'のうち直近100試合を表示。JSONには全試合を保存します。' : 'を表示。'}` : 'まだ終了した試合はありません。';
    }
    for (const id of ['seriesWatch', 'seriesWatchLive']) for (let i = 0; i < 2; i++) $(id).options[i].textContent = `${codes[i]}：${names[i]}`;
  }
  function download() {
    if (!summary) return;
    const report = { ...summary, rulesVersion: 'minion-v1-collection-1', game: { cfg: ArenaWorld.CFG, map: ArenaWorld.MAP, characters: ArenaWorld.CHARACTERS },
      winRateDefinition: 'wins / decided games; draws and unfinished games excluded', results,
      unfinished: summary.status === 'complete' ? null : summary.current,
      execution: { render: $('seriesRender').checked, speed: Number($('seriesSpeed').value) } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `axegozen-series-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  for (let i = 0; i < 2; i++) {
    fillCharacters(i);
    $(`seriesKind${i}`).addEventListener('change', () => {
      $(`seriesFileGroup${i}`).hidden = $(`seriesKind${i}`).value !== 'model';
      automaticName(i); fillCharacters(i); controls();
    });
    $(`seriesFile${i}`).addEventListener('change', async () => {
      const entry = loaded[i], token = ++entry.token, file = $(`seriesFile${i}`).files[0];
      entry.model = null; entry.loading = !!file; controls();
      if (!file) { $(`seriesModel${i}`).textContent = ''; fillCharacters(i); return; }
      $(`seriesModel${i}`).textContent = 'モデルを読み込み中…';
      try {
        const bytes = await file.arrayBuffer(), source = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
        if (/^\s*version https:\/\/git-lfs/.test(source)) throw Error('Git LFSの参照ファイルです。実体のmodel.jsonを読み込んでください。');
        const model = MinionPolicy.validate(JSON.parse(source));
        if (model.rulesVersion !== 'minion-v1-collection-1') throw Error('ゲームのルール版とモデルが一致しません。');
        const digest = globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
        if (entry.token !== token) return;
        entry.model = model; entry.fileName = file.name; entry.sha256 = digest;
        $(`seriesModel${i}`).textContent = `${label(model)}｜対応：${model.characters.map(id => ArenaWorld.characterFor(id).name).join('、')}`;
        automaticName(i);
        fillCharacters(i);
      } catch (error) { if (entry.token === token) $(`seriesModel${i}`).textContent = error.message; }
      finally { if (entry.token === token) { entry.loading = false; controls(); } }
    });
  }
  $('seriesStart').addEventListener('click', () => {
    try {
      const config = { firstTo: Number($('seriesFirstTo').value), seed: Number($('seriesSeed').value),
        timeLimitSeconds: Number($('seriesTimeLimit').value) * 60, alternateSides: $('seriesAlternate').checked,
        render: $('seriesRender').checked, speed: Number($('seriesSpeed').value), watch: Number($('seriesWatch').value),
        entries: loaded.map((entry, i) => {
          const kind = $(`seriesKind${i}`).value;
          return { kind, label: $(`seriesLabel${i}`).value || (i === 0 ? 'A' : 'B'), character: $(`seriesCharacter${i}`).value,
            model: kind === 'model' ? entry.model : null, fileName: kind === 'model' ? entry.fileName : null, sha256: kind === 'model' ? entry.sha256 : null };
        }) };
      ArenaSeries.validate(config);
      summary = null; results = []; failure = null; starting = true;
      $('seriesStandings').replaceChildren(); $('seriesResults').replaceChildren();
      $('seriesResultsNote').textContent = 'まだ終了した試合はありません。';
      textAll('[data-series-score]', '0 − 0'); textAll('[data-series-clock]', '');
      textAll('[data-series-status]', '対戦を準備しています…'); controls();
      session.startSeries(config);
    } catch (error) { starting = false; textAll('[data-series-status]', error.message); controls(); }
  });
  for (const id of ['seriesRender', 'seriesSpeed', 'seriesWatch']) $(id).addEventListener('change', () => syncView('panel'));
  for (const id of ['seriesSpeedLive', 'seriesWatchLive']) $(id).addEventListener('change', () => syncView('live'));
  for (const button of document.querySelectorAll('[data-series-action]')) button.addEventListener('click', () => {
    const action = button.dataset.seriesAction;
    if (action === 'download') { download(); return; }
    if (action === 'background') { $('seriesRender').checked = false; syncView('panel'); return; }
    session.seriesCommand(action === 'pause' && summary?.status === 'paused' ? 'resume' : action);
  });
  $('seriesBack').addEventListener('click', () => session.stop());
  session.on('seriesProgress', data => {
    starting = false; summary = data.summary; results.push(...data.results); paint(data.results.length > 0);
  });
  session.on('seriesError', message => {
    starting = false; failure = message;
    if (summary) summary = { ...summary, status: 'error' };
    textAll('[data-series-status]', message); controls();
  });
  session.on('seriesView', ({ render }) => {
    $('seriesMonitor').hidden = !render; document.body.classList.toggle('series-spectating', render);
    $('seriesRender').checked = render;
    $('reviewRecording').hidden = true;
  });
  session.on('seriesSetup', data => {
    starting = !!data?.starting; $('seriesMonitor').hidden = true; document.body.classList.remove('series-spectating');
    if (summary) paint(); else controls();
    if (starting) requestAnimationFrame(() => $('seriesStart').scrollIntoView({ block: 'start' }));
  });
  session.on('lobby', () => {
    starting = false; $('seriesMonitor').hidden = true; document.body.classList.remove('series-spectating');
    if (summary && ['running', 'paused'].includes(summary.status)) summary = { ...summary, status: 'stopped' };
    controls();
  });
  controls();
})();
