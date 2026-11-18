// 音源ファイルを使わず、Web Audioでゲーム用の音楽・効果音を合成する。
(() => {
  const session = window.gameSession, storageKey = 'axe-gozen-audio';
  const defaults = { music: 0.22, effects: 0.55, muted: false };
  let settings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const key of ['music', 'effects']) if (Number.isFinite(saved?.[key])) settings[key] = Math.max(0, Math.min(1, saved[key]));
    if (typeof saved?.muted === 'boolean') settings.muted = saved.muted;
  } catch { /* 保存できない環境でも再生できる。 */ }
  let context, master, music, effects, noiseBuffer, timer = null;
  let theme = 'lobby', step = 0, nextBeat = 0, previous = null, myId = null, mySlot = 0;
  const voices = new Set(), lastSound = new Map();
  const el = id => document.getElementById(id);
  const midi = note => 440 * 2 ** ((note - 69) / 12);

  function updateControls() {
    el('musicVolume').value = Math.round(settings.music * 100);
    el('effectsVolume').value = Math.round(settings.effects * 100);
    el('musicValue').textContent = `${Math.round(settings.music * 100)}%`;
    el('effectsValue').textContent = `${Math.round(settings.effects * 100)}%`;
    el('audioMute').textContent = settings.muted ? 'ミュート解除' : 'ミュート';
    el('audioMute').setAttribute('aria-pressed', String(settings.muted));
    el('audioSummary').textContent = `音声設定 · ${settings.muted ? 'OFF' : 'ON'}`;
    el('audioStatus').textContent = settings.muted ? 'ミュート中' : context?.state === 'running' ? '再生中' : '画面をクリックすると再生';
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* 保存は任意。 */ }
  }
  function gains() {
    if (!context) return;
    const now = context.currentTime;
    for (const [node, value] of [[master, settings.muted ? 0 : 0.65], [music, settings.music], [effects, settings.effects]]) {
      node.gain.cancelScheduledValues(now); node.gain.setTargetAtTime(value, now, 0.02);
    }
  }
  function stopVoices(bus) {
    for (const voice of [...voices]) if (!bus || voice.bus === bus) {
      try { voice.source.stop(); } catch { /* すでに終了した音。 */ }
      voice.cleanup();
    }
  }
  function stopMusic() {
    if (timer !== null) clearInterval(timer);
    timer = null; stopVoices(music);
  }
  function register(source, envelope, bus, filter) {
    const voice = { source, bus, cleanup() {
      if (!voices.delete(voice)) return;
      source.disconnect(); envelope.disconnect(); if (filter) filter.disconnect();
    } };
    voices.add(voice); source.onended = voice.cleanup;
  }
  function tone(note, duration, volume, type = 'sine', delay = 0, bus = effects, endNote = note) {
    if (!context || context.state !== 'running' || settings.muted || document.hidden || voices.size >= 64) return;
    if ((bus === music ? settings.music : settings.effects) <= 0) return;
    const at = context.currentTime + Math.max(0, delay), source = context.createOscillator(), envelope = context.createGain();
    source.type = type;
    source.frequency.setValueAtTime(midi(note), at);
    source.frequency.exponentialRampToValueAtTime(midi(endNote), at + duration);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), at + Math.min(0.015, duration / 4));
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(envelope); envelope.connect(bus); register(source, envelope, bus);
    source.start(at); source.stop(at + duration + 0.02);
  }
  function noise(duration, volume, frequency = 1200, delay = 0, bus = effects) {
    if (!context || context.state !== 'running' || settings.muted || document.hidden || voices.size >= 64) return;
    if ((bus === music ? settings.music : settings.effects) <= 0) return;
    const at = context.currentTime + Math.max(0, delay), source = context.createBufferSource();
    const filter = context.createBiquadFilter(), envelope = context.createGain();
    source.buffer = noiseBuffer; filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = 0.7;
    envelope.gain.setValueAtTime(Math.max(0.0002, volume), at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter); filter.connect(envelope); envelope.connect(bus); register(source, envelope, bus, filter);
    source.start(at); source.stop(at + duration);
  }
  function phrase(notes, duration = 0.12, volume = 0.16, type = 'triangle') {
    notes.forEach((note, i) => tone(note, duration * 2, volume, type, i * duration));
  }
  function sound(kind, volume = 1, character = '') {
    if (!context || context.state !== 'running' || settings.muted || settings.effects <= 0 || document.hidden || volume <= 0) return;
    const now = context.currentTime, cooldown = ['atk', 'hit', 'boosted'].includes(kind) ? 0.065 : 0.1;
    if (now - (lastSound.get(kind) ?? -Infinity) < cooldown) return;
    lastSound.set(kind, now);
    const v = volume;
    switch (kind) {
      case 'ui': tone(76, 0.07, 0.07 * v); break;
      case 'start': phrase([57, 64, 69, 76], 0.1); break;
      case 'atk': tone(75, 0.09, 0.1 * v, 'triangle', 0, effects, 48); noise(0.07, 0.07 * v, 2300); break;
      case 'boosted': tone(52, 0.16, 0.15 * v, 'sawtooth', 0, effects, 35); noise(0.1, 0.11 * v, 900); break;
      case 'hit': tone(43, 0.09, 0.12 * v, 'triangle', 0, effects, 30); noise(0.055, 0.1 * v, 700); break;
      case 'q':
        noise(0.2, 0.15 * v, character === 'mira' ? 3600 : 1800);
        tone(character === 'mira' ? 88 : 74, 0.22, 0.14 * v, 'triangle', 0, effects, 50); break;
      case 'leap': tone(45, 0.3, 0.17 * v, 'triangle', 0, effects, 83); noise(0.18, 0.09 * v, 1600); break;
      case 'leapHit': tone(38, 0.3, 0.25 * v, 'sine', 0, effects, 23); noise(0.22, 0.23 * v, 500); break;
      case 'magic': tone(72, 0.23, 0.16 * v, 'sine', 0, effects, 100); tone(79, 0.18, 0.08 * v, 'triangle'); break;
      case 'magicHit': tone(96, 0.32, 0.17 * v, 'sine', 0, effects, 48); noise(0.15, 0.1 * v, 3200); break;
      case 'abyss': tone(57, 0.35, 0.15 * v, 'sawtooth', 0, effects, 39); tone(76, 0.2, 0.08 * v, 'sine'); break;
      case 'abyssHit': tone(45, 0.3, 0.18 * v, 'triangle', 0, effects, 26); noise(0.2, 0.12 * v, 700); break;
      case 'warp': tone(40, 0.6, 0.14 * v, 'sine', 0, effects, 88); break;
      case 'warpHit': tone(35, 0.4, 0.2 * v, 'sawtooth', 0, effects, 23); noise(0.25, 0.15 * v, 900); break;
      case 'stealth': tone(76, 0.5, 0.1 * v, 'sine', 0, effects, 40); break;
      case 'heal': phrase([76, 81], 0.07, 0.07 * v); break;
      case 'wind': tone(64, 0.4, 0.13 * v, 'sine', 0, effects, 88); noise(0.35, 0.13 * v, 2800); break;
      case 'shield': phrase([60, 67, 72], 0.065, 0.12 * v); break;
      case 'summon': phrase([57, 64, 69], 0.075, 0.12 * v, 'square'); break;
      case 'aim': tone(81, 0.08, 0.06 * v); break;
      case 'recall': phrase([64, 69, 76], 0.15, 0.1); break;
      case 'recallCancel': tone(62, 0.15, 0.08, 'sine', 0, effects, 50); break;
      case 'respawn': phrase([69, 76, 81], 0.1, 0.13); break;
      case 'death': phrase([57, 52, 45, 33], 0.14, 0.16); break;
      case 'kill': phrase([76, 83, 88], 0.085, 0.16 * v); break;
      case 'minionDown': tone(60, 0.12, 0.11 * v, 'triangle', 0, effects, 38); noise(0.06, 0.08 * v, 1600); break;
      case 'tower': tone(33, 0.65, 0.3 * v, 'sawtooth', 0, effects, 21); noise(0.4, 0.3 * v, 500); break;
      case 'victory': phrase([60, 64, 67, 72, 71, 72, 76, 79], 0.15, 0.2); break;
      case 'defeat': phrase([64, 60, 57, 52, 45], 0.23, 0.16); break;
    }
  }

  // 自作の短いループ。ロビーは柔らかいアルペジオ、試合中は低音と打楽器を加える。
  const melodies = {
    lobby: [69, null, 72, null, 76, 72, 71, null, 69, null, 65, null, 72, 69, 67, null, 67, null, 72, null, 76, 74, 72, null, 71, null, 67, null, 74, 71, 69, null],
    battle: [69, 69, 72, 76, 74, null, 72, 71, 69, 72, 77, 76, 72, null, 69, 67, 67, 72, 76, 79, 76, 74, 72, null, 71, 74, 79, 77, 74, 71, 67, 71],
  };
  function scheduleMusic() {
    if (!context || context.state !== 'running' || document.hidden || settings.muted || settings.music <= 0 || theme === 'silent') return;
    if (nextBeat < context.currentTime) nextBeat = context.currentTime + 0.02;
    const battle = theme === 'battle', beat = 60 / (battle ? 128 : 88) / 2;
    while (nextBeat < context.currentTime + 0.15) {
      const delay = nextBeat - context.currentTime, index = step % 32, chord = Math.floor(index / 8);
      const root = [45, 41, 48, 43][chord], note = melodies[theme][index];
      if (note !== null) tone(note, beat * 1.4, battle ? 0.12 : 0.1, battle ? 'triangle' : 'sine', delay, music);
      if (index % 8 === 0) {
        for (const offset of [12, chord === 0 ? 15 : 16, 19]) tone(root + offset, beat * 7.5, 0.045, 'sine', delay, music);
      }
      if (index % 4 === 0) tone(root, beat * 1.8, 0.16, 'triangle', delay, music);
      if (battle) {
        if (index % 4 === 0) tone(36, 0.16, 0.32, 'sine', delay, music, 20);
        if (index % 8 === 4) noise(0.12, 0.16, 1500, delay, music);
        if (index % 2 === 1) noise(0.035, 0.06, 6500, delay, music);
      }
      step++; nextBeat += beat;
    }
  }
  function startMusic() {
    if (timer !== null || !context || context.state !== 'running' || document.hidden || settings.muted || settings.music <= 0 || theme === 'silent') return;
    nextBeat = context.currentTime + 0.03;
    scheduleMusic(); timer = setInterval(scheduleMusic, 50);
  }
  function setTheme(value) {
    if (theme === value) return;
    stopMusic(); theme = value; step = 0; startMusic();
  }
  async function unlock() {
    try {
      if (!context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) { el('audioStatus').textContent = 'このブラウザは音声に非対応です'; return; }
        context = new AudioContext();
        master = context.createGain(); music = context.createGain(); effects = context.createGain();
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 8;
        master.gain.value = settings.muted ? 0 : 0.65; music.gain.value = settings.music; effects.gain.value = settings.effects;
        music.connect(master); effects.connect(master); master.connect(limiter); limiter.connect(context.destination);
        noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.5), context.sampleRate);
        const samples = noiseBuffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      }
      if (!document.hidden && context.state === 'suspended') await context.resume();
      gains(); startMusic(); updateControls();
    } catch { el('audioStatus').textContent = 'クリックして音声を再開'; }
  }
  function distanceVolume(source) {
    const me = previous?.players.find(p => p.id === myId);
    if (!me || !Number.isFinite(source?.x) || !Number.isFinite(source?.z)) return 0;
    return Math.max(0, 1 - Math.hypot(source.x - me.x, source.z - me.z) / 32);
  }
  function entity(id) {
    return previous && [...previous.players, ...previous.robots, ...previous.towers].find(e => e.id === id);
  }
  session.on('init', d => { myId = d.id; mySlot = d.slot; previous = null; });
  session.on('lobby', () => { previous = null; myId = null; setTheme('lobby'); });
  for (const event of ['matchEnded', 'disconnect', 'connect_error']) session.on(event, () => { previous = null; setTheme('lobby'); });
  session.on('fx', d => {
    const source = entity(d.id), volume = d.id === myId ? 1 : distanceVolume(d);
    if (d.kind === 'atk') sound(d.boosted ? 'boosted' : 'atk', volume * (previous?.robots.some(r => r.id === d.id) ? 0.45 : 0.75));
    else sound(d.kind, volume, source?.character);
  });
  session.on('hit', d => sound('hit', d.id === myId ? 0.9 : distanceVolume(entity(d.id)) * 0.45));
  session.on('heal', d => { if (d.id === myId) sound('heal'); });
  session.on('kill', d => {
    if (d.victim.kind === 'tower') sound('tower', 0.8);
    else if (d.victim.kind === 'player') sound(d.victim.id === myId ? 'death' : 'kill');
    else sound('minionDown', d.victim.slot === mySlot ? 0.3 : 0.65);
  });
  session.on('state', state => {
    const me = state.players.find(p => p.id === myId), oldMe = previous?.players.find(p => p.id === myId);
    if (state.phase === 'playing') {
      setTheme('battle');
      if (previous?.phase !== 'playing') sound('start');
      if (me && oldMe) {
        if (oldMe.dead && !me.dead) sound('respawn');
        else if (!me.dead) {
          if (me.recall > 0 && !(oldMe.recall > 0)) sound('recall');
          if (oldMe.recall > 0 && me.recall <= 0) sound(oldMe.recall < 0.15 && me.safe ? 'respawn' : 'recallCancel');
          if (me.aiming && !oldMe.aiming) sound('aim');
        }
      }
    } else if (state.phase === 'finished') {
      setTheme('silent');
      if (previous?.phase !== 'finished') sound(state.winner === mySlot ? 'victory' : 'defeat');
    } else setTheme('lobby');
    previous = state;
  });
  for (const [id, key] of [['musicVolume', 'music'], ['effectsVolume', 'effects']]) el(id).addEventListener('input', event => {
    settings[key] = Number(event.target.value) / 100; save(); gains(); updateControls();
    if (settings.music <= 0) stopMusic(); else startMusic();
  });
  el('audioMute').addEventListener('click', () => {
    settings.muted = !settings.muted; save(); gains();
    if (settings.muted) { stopMusic(); stopVoices(); } else { unlock(); startMusic(); }
    updateControls();
  });
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('keydown', event => { if (!event.repeat) unlock(); }, { capture: true });
  document.addEventListener('click', event => {
    if (event.target.closest('button, input[type="radio"]') && event.target.id !== 'audioMute') sound('ui');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopMusic(); stopVoices(); if (context) context.suspend().catch(() => {}); }
    else if (context) unlock();
  });
  updateControls();
})();
