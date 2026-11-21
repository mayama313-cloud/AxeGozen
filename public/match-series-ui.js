(() => {
  'use strict';
  const $ = id => document.getElementById(id), session = window.gameSession;
  let builder, watchSignature = '';
  let summary = null, results = [], starting = false, failure = null;
  const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const textAll = (selector, value) => document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
  const active = () => starting || ['running', 'paused'].includes(summary?.status);
  function controls() {
    $('seriesSettings').disabled = active();
    builder?.setDisabled(active());
    window.competitionSetup?.setDisabled(active());
    $('seriesStart').disabled = active() || (window.competitionSetup?.format === 'swiss' ? !competitionSetup.ready() : builder && !builder.ready());
    for (const button of document.querySelectorAll('[data-series-action]')) {
      const action = button.dataset.seriesAction;
      if (['pause', 'draw', 'stop'].includes(action)) button.disabled = !summary || !['running', 'paused'].includes(summary.status);
      if (action === 'pause') button.textContent = summary?.status === 'paused' ? '再開' : '一時停止';
      if (action === 'download') button.disabled = !summary;
    }
  }
  function watching() {
    const parts = $('seriesWatch').value.split(':').map(Number);
    return { watch: parts[0], watchMember: parts[1] || 0 };
  }
  function watchOptions(entries) {
    const signature = JSON.stringify(entries.map(e => ({ label: e.label, members: e.members })));
    if (signature === watchSignature) return; watchSignature = signature;
    const previousWatch = $('seriesWatch').value;
    for (const id of ['seriesWatch', 'seriesWatchLive']) {
      const select = $(id), previous = select.value; select.replaceChildren();
      entries.forEach((entry, t) => entry.members.forEach((m, i) => {
        const option = document.createElement('option'); option.value = i ? `${t}:${i}` : String(t);
        option.textContent = `${t ? 'B' : 'A'} ${i + 1}：${m.characterName || ArenaWorld.characterFor(m.character)?.name || 'CPU'}`; select.appendChild(option);
      }));
      if ([...select.options].some(o => o.value === previous)) select.value = previous;
    }
    if ($('seriesWatch').value !== previousWatch) syncView('panel');
  }
  function syncView(source) {
    if (source === 'live') { $('seriesSpeed').value = $('seriesSpeedLive').value; $('seriesWatch').value = $('seriesWatchLive').value; }
    $('seriesSpeedLive').value = $('seriesSpeed').value; $('seriesWatchLive').value = $('seriesWatch').value;
    if (session.mode === 'series' && session.connected) session.seriesView({ render: $('seriesRender').checked,
      speed: Number($('seriesSpeed').value), ...watching() });
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
    if (summary.status === 'complete' && !summary.competition) status = `${codes[summary.champion]}：${names[summary.champion]} が${summary.firstTo}本先取しました。`;
    if (summary.competition) {
      const c = summary.competition;
      status = summary.status === 'complete' ? `スイスステージ終了。1位：${c.standings[0].label}（${c.standings[0].points}点）` : `スイス 第${c.round} / ${c.totalRounds}ラウンド｜${names.join(' vs ')}｜${summary.firstTo}本先取`;
    }
    if (summary.status === 'paused') status = '一時停止中。' + status;
    if (summary.status === 'stopped') status = '中止しました。未決着の試合は勝敗に含めません。';
    if (failure) status = failure;
    textAll('[data-series-status]', status);
    window.competitionSetup?.paint(summary);
    textAll('[data-series-score]', `A ${summary.wins[0]} − ${summary.wins[1]} B`);
    const c = summary.current;
    textAll('[data-series-clock]', `第${c.number}試合　${time(c.seconds)}｜初期陣営：A=${c.entryBySlot.indexOf(0) === 0 ? '左下' : '右上'} / B=${c.entryBySlot.indexOf(1) === 0 ? '左下' : '右上'}`);
    $('seriesStandings').replaceChildren(...summary.entries.map((e, i) => tableRow([
      `${codes[i]}：${e.label}`, e.members.map(m => `${m.kind === 'algorithm' ? 'アルゴリズム' : m.model.name} / ${m.characterName}`).join('・'),
      summary.wins[i], summary.winRates[i] === null ? '—' : `${(summary.winRates[i] * 100).toFixed(1)}%`,
      `${c.stats[i].towers}/5`, c.stats[i].energy
    ])));
    if (historyChanged) {
      const recent = results.slice(-100).reverse();
      $('seriesResults').replaceChildren(...recent.map(r => tableRow([r.competitionRound ? `R${r.competitionRound}・${r.number}` : r.number,
        (r.labels ? `${r.labels.join(' vs ')}：` : '') + (r.winner === null ? r.reason === 'time-limit' ? '引き分け（時間上限）' : '引き分け（手動）' : `${r.labels ? r.labels[r.winner] : `${codes[r.winner]}：${names[r.winner]}`} の勝利`),
        time(r.seconds), `左下 ${codes[r.entryBySlot[0]]} / 右上 ${codes[r.entryBySlot[1]]}`,
        `${r.stats[0].towers} / ${r.stats[1].towers}`, `${r.stats[0].energy} / ${r.stats[1].energy}`])));
      $('seriesResultsNote').textContent = results.length ? `終了した${results.length}試合${results.length > 100 ? 'のうち直近100試合を表示。JSONには全試合を保存します。' : 'を表示。'}` : 'まだ終了した試合はありません。';
    }
    watchOptions(summary.entries);
  }
  function download() {
    if (!summary) return;
    const report = { ...summary, rulesVersion: 'minion-v1-collection-1', game: { cfg: ArenaWorld.CFG, map: ArenaWorld.MAP, characters: ArenaWorld.CHARACTERS },
      winRateDefinition: 'wins / decided games; draws and unfinished games excluded', results,
      unfinished: summary.status === 'complete' ? null : summary.current,
      execution: { render: $('seriesRender').checked, speed: Number($('seriesSpeed').value) } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `axegozen-${summary.competition ? 'competition' : 'series'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  builder = new TeamBuilder([$('seriesTeamMembers0'), $('seriesTeamMembers1')], { mode: 'series', prefix: 'series', changed: controls });
  for (let t = 0; t < 2; t++) $(`seriesTeamSize${t}`).addEventListener('change', () => builder.resize(t, Number($(`seriesTeamSize${t}`).value)));
  $('seriesStart').addEventListener('click', () => {
    try {
      const swiss = window.competitionSetup?.format === 'swiss';
      const config = { firstTo: Number($('seriesFirstTo').value), seed: Number($('seriesSeed').value),
        timeLimitSeconds: Number($('seriesTimeLimit').value) * 60, alternateSides: $('seriesAlternate').checked,
        render: $('seriesRender').checked, speed: Number($('seriesSpeed').value), ...watching(),
        ...(swiss ? competitionSetup.config() : { teams: builder.getTeams(), teamLabels: [$('seriesLabel0').value || 'A', $('seriesLabel1').value || 'B'] }) };
      if (swiss) ArenaCompetition.validate(config); else ArenaSeries.validate(config);
      summary = null; results = []; failure = null; starting = true;
      $('seriesStandings').replaceChildren(); $('seriesResults').replaceChildren();
      $('competitionTables').hidden = true;
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
  $('competitionFormat').addEventListener('competitionchange', controls);
})();
