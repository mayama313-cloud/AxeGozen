'use strict';
importScripts('/game-world.js', 'minion-objectives.js', 'minion-perception.js', 'minion-policy.js', 'team-config.js', 'match-series.js', 'competition.js');
let series = null, render = false, speed = 1, watch = 0, watchMember = 0, timer = null, last = 0, debt = 0, lastUpdate = 0, lastFrame = 0, sent = 0, token = null;
function publish(force = false) {
  if (!series) return;
  const now = performance.now();
  if (force || now - lastUpdate >= 100) {
    postMessage({ type: 'progress', summary: series.summary(), results: series.results.slice(sent) });
    sent = series.results.length; lastUpdate = now;
  }
  if (render && (force || now - lastFrame >= 50)) {
    const frame = series.frame(watch, watchMember);
    postMessage({ type: 'frame', init: token === frame.token ? null : frame.init, state: frame.state, events: frame.events });
    token = frame.token; lastFrame = now;
  }
}
function schedule() { if (timer === null && series?.status === 'running') timer = setTimeout(pump, render ? 16 : 0); }
function pump() {
  timer = null;
  if (!series || series.status !== 'running') return;
  try {
    const now = performance.now(), start = now;
    let budget = 240;
    if (render) { debt = Math.min(300, debt + (now - last) * speed * ArenaWorld.TICK / 1000); budget = Math.floor(debt); }
    last = now;
    for (let i = 0; i < budget && series.status === 'running' && performance.now() - start < 12; i++) {
      series.advance(); if (render) debt--;
    }
    publish(series.status !== 'running'); schedule();
  } catch (error) { series.stop(); publish(true); postMessage({ type: 'error', message: error.message }); }
}
onmessage = event => {
  try {
    const data = event.data;
    if (data.type === 'start') {
      if (series) throw Error('対戦は既に開始されています。');
      render = !!data.config.render; speed = Number(data.config.speed || 1); watch = data.config.watch || 0;
      watchMember = data.config.watchMember || 0;
      if (![1, 4, 16, 64].includes(speed) || ![0, 1].includes(watch)) throw Error('描画設定が不正です。');
      series = data.config.format === 'swiss' ? new ArenaCompetition.Competition(data.config) : new ArenaSeries.Series(data.config); last = performance.now(); publish(true); schedule(); return;
    }
    if (!series) return;
    if (data.type === 'pause') { series.pause(); debt = 0; }
    if (data.type === 'resume') { series.resume(); last = performance.now(); debt = 0; schedule(); }
    if (data.type === 'stop') series.stop();
    if (data.type === 'draw') series.draw();
    if (data.type === 'view') {
      if (![1, 4, 16, 64].includes(data.speed) || ![0, 1].includes(data.watch)) throw Error('描画設定が不正です。');
      render = !!data.render; speed = data.speed; watch = data.watch; token = null; last = performance.now(); debt = 0;
      watchMember = data.watchMember || 0;
      series.captureEvents = render; series.visualEvents = [];
    }
    publish(true); schedule();
  } catch (error) { postMessage({ type: 'error', message: error.message }); }
};
