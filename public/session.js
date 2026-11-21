// オフラインとオンラインで、描画・入力に同じイベント形式を提供する。
(() => {
  const handlers = new Map();
  let network = null, local = null, timer = null, running = false, replay = null;
  let seriesWorker = null, seriesRendering = false;
  const dispatch = (event, data) => { for (const fn of handlers.get(event) || []) fn(data); };
  const session = {
    mode: 'offline',
    get replaying() { return !!replay; },
    get readOnly() { return !!replay || session.mode === 'series'; },
    get rendering() { return session.mode !== 'series' || seriesRendering; },
    get connected() { return !!local || !!network?.connected || !!seriesWorker; },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, data) {
      if (replay || session.mode === 'series') return;
      if (local) local.receive(event, data);
      else if (network) network.emit(event, data);
    },
    stop() {
      running = false;
      replay = null;
      if (seriesWorker) seriesWorker.terminate();
      seriesWorker = null; seriesRendering = false;
      window.trainingRecorder?.finish('stopped');
      if (timer) clearInterval(timer);
      timer = null; local = null;
      if (network) { network.removeAllListeners(); network.disconnect(); network = null; }
      dispatch('lobby');
    },
    openSeries() { session.stop(); session.mode = 'series'; dispatch('seriesSetup'); },
    startSeries(config) {
      session.stop(); session.mode = 'series'; running = true; seriesRendering = !!config.render;
      if (typeof Worker !== 'function') { dispatch('seriesSetup'); dispatch('seriesError', 'このブラウザーではWeb Workerを利用できません。'); return; }
      let worker;
      try { worker = seriesWorker = new Worker('match-series-worker.js'); }
      catch (error) { running = false; seriesRendering = false; dispatch('seriesSetup'); dispatch('seriesError', error.message); return; }
      worker.onmessage = ({ data }) => {
        if (seriesWorker !== worker) return;
        if (data.type === 'progress') { dispatch('seriesProgress', data); dispatch('seriesView', { render: seriesRendering }); }
        if (data.type === 'frame') {
          if (data.init) dispatch('init', data.init);
          dispatch('state', data.state);
          for (const event of data.events || []) dispatch(event.event, event.data);
        }
        if (data.type === 'error') { seriesRendering = false; dispatch('seriesView', { render: false }); dispatch('seriesError', data.message); }
      };
      worker.onerror = event => {
        if (seriesWorker !== worker) return;
        worker.terminate(); seriesWorker = null; seriesRendering = false; running = false;
        dispatch('seriesView', { render: false }); dispatch('seriesError', event.message || '自動対戦を実行できませんでした。');
      };
      dispatch('seriesSetup', { starting: true }); worker.postMessage({ type: 'start', config });
    },
    seriesCommand(type) { seriesWorker?.postMessage({ type }); },
    seriesView({ render, speed, watch }) {
      seriesRendering = !!render;
      seriesWorker?.postMessage({ type: 'view', render: seriesRendering, speed, watch });
      dispatch('seriesView', { render: seriesRendering && !!seriesWorker });
    },
    start(mode, { model = null } = {}) {
      session.stop(); running = true; session.mode = mode;
      window.trainingRecorder?.newSession();
      dispatch('starting', { mode });
      if (mode === 'offline' || mode === 'cpu') {
        const listeners = new Map(), match = ArenaWorld.createMatch(mode === 'offline', mode === 'cpu', {
          trace: window.trainingRecorder?.enabled ? entry => window.trainingRecorder.consume(entry) : null,
          policy: mode === 'cpu' && model ? window.MinionPolicy.controller(model) : null,
        });
        local = {
          id: 'offline-player',
          on(event, fn) { listeners.set(event, fn); },
          emit: dispatch,
          receive(event, data) { listeners.get(event)?.(data); },
        };
        match.connect(local); match.tick();
        timer = setInterval(() => match.tick(), 1000 / ArenaWorld.TICK);
      } else {
        if (typeof io !== 'function') { dispatch('connect_error'); return; }
        network = io({ autoConnect: false, reconnection: false });
        network.onAny(dispatch);
        network.on('connect', () => { if (running) network.emit('joinQueue'); });
        network.on('connect_error', () => dispatch('connect_error'));
        network.on('disconnect', reason => dispatch('disconnect', reason));
        network.connect();
      }
    },
    playReplay(record, actor) {
      session.stop(); session.mode = 'replay';
      const frames = record.entries.filter(e => e.kind === 'frame' && e.views[actor]);
      if (!frames.length || !record.actors[actor]) throw Error('再生する視点がありません。');
      replay = { record, actor, frames, index: 0, paused: false };
      dispatch('starting', { mode: 'replay' });
      session.seekReplay(0);
      timer = setInterval(() => {
        if (!replay || replay.paused) return;
        if (replay.index >= frames.length - 1) { session.pauseReplay(true); return; }
        const previous = frames[replay.index++], frame = frames[replay.index];
        for (const e of record.entries.slice(previous.seq + 1, frame.seq)) {
          if (e.kind === 'event' && e.actor === actor && ['fx', 'hit', 'heal', 'kill'].includes(e.event)) dispatch(e.event, e.data);
        }
        dispatch('state', frame.views[actor]);
        dispatch('replayPosition', { time: frame.time, duration: record.duration, paused: replay.paused });
      }, 1000 / ArenaWorld.TICK);
    },
    pauseReplay(paused) {
      if (!replay) return;
      replay.paused = paused;
      dispatch('replayPosition', { time: replay.frames[replay.index].time, duration: replay.record.duration, paused });
    },
    seekReplay(time) {
      if (!replay) return;
      let index = replay.frames.findIndex(f => f.time >= time);
      if (index < 0) index = replay.frames.length - 1;
      replay.index = index;
      const init = replay.record.actors[replay.actor].init;
      dispatch('init', { ...init, characters: ArenaWorld.CHARACTERS });
      dispatch('state', replay.frames[index].views[replay.actor]);
      dispatch('replayPosition', { time: replay.frames[index].time, duration: replay.record.duration, paused: replay.paused });
    },
  };
  window.gameSession = session;
})();
