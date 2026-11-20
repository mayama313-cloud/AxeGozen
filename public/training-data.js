// 学習器と画面から独立した、視点別の収集・区間選択・書き出し。
(function(root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const SCHEMA = 'axe-gozen-demonstration/1';
  class Recorder {
    constructor(onFinish = () => {}) {
      this.enabled = false; this.current = null; this.actors = {}; this.onFinish = onFinish; this.capped = false;
    }
    consume(entry) {
      if (entry.kind === 'init') { this.actors[entry.actor] = copy({ source: entry.source, init: entry.data }); return; }
      if (entry.kind === 'reset') { this.finish('restart'); this.capped = false; return; }
      if (!this.enabled || this.capped) return;
      if (!this.current) {
        this.current = { schema: SCHEMA, model: 'ミニオン v1', id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          createdAt: new Date().toISOString(), actors: copy(this.actors), entries: [], ranges: [], duration: 0, winner: null, status: 'recording' };
      }
      // 長時間の収集によるメモリ増加を止める。試合自体は続行できる。
      if (entry.time > 1200) { this.finish('limit'); this.capped = true; return; }
      const item = copy(entry); item.seq = this.current.entries.length;
      this.current.entries.push(item); this.current.duration = Math.max(this.current.duration, entry.time);
      if (entry.kind === 'frame' && entry.phase === 'finished') {
        this.current.winner = entry.winner; this.finish('finished'); this.capped = true;
      }
    }
    finish(reason = 'stopped') {
      const record = this.current; this.current = null;
      if (!record || !record.entries.some(e => e.kind === 'frame')) return null;
      record.status = reason; this.onFinish(record); return record;
    }
    newSession() { this.finish(); this.actors = {}; this.capped = false; }
  }
  function addRange(record, actor, start, end, label = '') {
    if (!record.actors[actor] || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > record.duration + 1e-6) throw Error('開始・終了時刻を試合の範囲内で指定してください。');
    const range = { actor, start, end, label: String(label).slice(0, 200) };
    record.ranges.push(range); return range;
  }
  function dataset(record, includeAlgorithm = false) {
    const output = [];
    for (const [actor, info] of Object.entries(record.actors)) {
      if (info.source !== 'human' && !includeAlgorithm) continue;
      const ranges = record.ranges.filter(r => r.actor === actor);
      if (!ranges.length) continue;
      const frames = record.entries.filter(e => e.kind === 'frame' && e.views[actor]);
      const included = frames.map((frame, i) => i > 0 && ranges.some(r => frames[i - 1].time >= r.start - 1e-6 && frame.time <= r.end + 1e-6));
      // フレーム間に入力がない時間も残し、操作の持続と「何もしない」を学べるようにする。
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i], previous = frames[i - 1];
        if (!previous) continue;
        const start = previous?.time ?? 0;
        if (!included[i]) continue;
        const interval = record.entries.slice((previous?.seq ?? -1) + 1, frame.seq);
        output.push({ schema: 'axe-gozen-imitation/1', model: record.model, episodeId: record.id, actor, source: info.source,
          rulesVersion: info.init.rulesVersion, tick: frame.tick, start, end: frame.time, dt: frame.time - start,
          observation: previous?.views[actor] || interval.find(e => e.kind === 'action' && e.actor === actor)?.observation || frame.views[actor],
          actions: interval.filter(e => e.kind === 'action' && e.actor === actor).map(e => ({ seq: e.seq, event: e.event, data: e.data, origin: e.origin, tick: e.tick, time: e.time, observation: e.observation })),
          events: interval.filter(e => e.kind === 'event' && e.actor === actor).map(e => ({ seq: e.seq, event: e.event, data: e.data, time: e.time })),
          nextObservation: frame.views[actor], sequenceStart: !included[i - 1], sequenceEnd: !included[i + 1],
          terminal: frame.phase === 'finished', truncated: !included[i + 1] && frame.phase !== 'finished', winner: record.winner });
      }
    }
    return output;
  }
  function validate(record) {
    if (record?.schema !== SCHEMA || typeof record.id !== 'string' || !record.id || typeof record.createdAt !== 'string' || !record.actors || !Object.keys(record.actors).length || !Array.isArray(record.entries) || !Array.isArray(record.ranges) || !Number.isFinite(record.duration) || record.duration < 0) throw Error('対応していない記録ファイルです。');
    if (!record.entries.some(e => e.kind === 'frame')) throw Error('再生できるフレームがありません。');
    for (const [id, info] of Object.entries(record.actors)) if (!info.init?.map?.spawns || info.init.id !== id || !['human', 'algorithm', 'model'].includes(info.source)) throw Error('視点情報が壊れています。');
    let time = 0;
    for (let i = 0; i < record.entries.length; i++) {
      const e = record.entries[i];
      if (e.seq !== i || !Number.isFinite(e.time) || e.time < time || !['frame', 'action', 'event'].includes(e.kind)) throw Error('時系列データが壊れています。');
      if (e.kind === 'frame' && (!e.views || Object.keys(record.actors).some(id => !Array.isArray(e.views[id]?.players)))) throw Error('観測データが壊れています。');
      if (e.kind !== 'frame' && !record.actors[e.actor]) throw Error('視点情報が壊れています。');
      time = e.time;
    }
    if (time > record.duration + 1e-6) throw Error('記録時間が壊れています。');
    for (const r of record.ranges) if (!record.actors[r.actor] || !Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start || r.end > record.duration + 1e-6) throw Error('採用区間が壊れています。');
    return record;
  }
  function storage() {
    let opened;
    const open = () => opened ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('axe-gozen-demonstrations', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('matches', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const run = async (method, value) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('matches', method === 'getAll' || method === 'get' ? 'readonly' : 'readwrite');
        const request = tx.objectStore('matches')[method](value);
        tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('保存が中断されました。'));
      });
    };
    return { put: record => run('put', record), get: id => run('get', id), list: () => run('getAll'), remove: id => run('delete', id) };
  }
  const api = { Recorder, addRange, dataset, validate, storage, SCHEMA };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MinionData = api;
})(globalThis);
