// オフラインとオンラインで、描画・入力に同じイベント形式を提供する。
(() => {
  const handlers = new Map();
  let network = null, local = null, timer = null, running = false;
  const dispatch = (event, data) => { for (const fn of handlers.get(event) || []) fn(data); };
  const session = {
    mode: 'offline',
    get connected() { return !!local || !!network?.connected; },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, data) {
      if (local) local.receive(event, data);
      else if (network) network.emit(event, data);
    },
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null; local = null;
      if (network) { network.removeAllListeners(); network.disconnect(); network = null; }
      dispatch('lobby');
    },
    start(mode) {
      session.stop(); running = true; session.mode = mode;
      dispatch('starting', { mode });
      if (mode === 'offline') {
        const listeners = new Map(), match = ArenaWorld.createMatch(true);
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
  };
  window.gameSession = session;
})();
