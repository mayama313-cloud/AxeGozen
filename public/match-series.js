(function(root) {
  'use strict';
  const World = root.ArenaWorld || require('../game-world');
  const Policy = root.MinionPolicy || require('./minion-policy');
  const Teams = root.ArenaTeams || require('./team-config');
  const VERSION = 'axegozen-match-series/1';
  function validate(config) {
    if (!Number.isInteger(config.firstTo) || config.firstTo < 1 || config.firstTo > 1000) throw Error('先取本数は1〜1000で指定してください。');
    if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 4294967295) throw Error('乱数シードは0〜4294967295の整数で指定してください。');
    if (!Number.isFinite(config.timeLimitSeconds) || config.timeLimitSeconds < 0 || config.timeLimitSeconds > 86400) throw Error('試合時間上限が不正です。0は無制限です。');
    if (config.teams) { Teams.normalize(config.teams, { humans: false }); return config; }
    if (!Array.isArray(config.entries) || config.entries.length !== 2) throw Error('両陣営を指定してください。');
    for (const entry of config.entries) {
      if (!['algorithm', 'model'].includes(entry.kind) || !World.characterFor(entry.character)) throw Error('操作主体またはキャラクターが不正です。');
      if (entry.kind === 'model') {
        Policy.validate(entry.model);
        if (entry.model.rulesVersion !== 'minion-v1-collection-1') throw Error('ゲームのルール版とモデルが一致しません。');
        if (!entry.model.characters.includes(entry.character)) throw Error('選択したモデルはこのキャラクターに対応していません。');
      }
    }
    return config;
  }
  function describe(entry, index) {
    const model = entry.kind === 'model' ? entry.model : null;
    return { entry: index, label: String(entry.label || (index === 0 ? 'A' : 'B')).slice(0, 120), kind: entry.kind,
      character: entry.character, characterName: World.characterFor(entry.character).name,
      model: model ? { name: model.modelName || '学習モデル', format: model.format, featureVersion: model.featureVersion || null,
        objectiveVersion: model.objectivePolicy?.version || null, fileName: entry.fileName || null, sha256: entry.sha256 || null } : null };
  }
  class Series {
    constructor(config) {
      this.config = validate({ seed: 17, timeLimitSeconds: 0, alternateSides: true, ...config });
      this.teams = Teams.normalize(this.config.teams || this.config.entries.map(e => [e]), { humans: false });
      this.entries = this.teams.map((team, index) => ({ ...(team.length === 1 ? describe(team[0], index) : { entry: index, label: index === 0 ? 'Aチーム' : 'Bチーム', kind: 'team', characterName: team.map(m => World.characterFor(m.character).name).join('・') }),
        label: this.config.teamLabels?.[index] || this.config.entries?.[index]?.label || (index === 0 ? 'Aチーム' : 'Bチーム'), members: team.map(Teams.describe) }));
      this.results = []; this.wins = [0, 0]; this.draws = 0; this.status = 'running'; this.champion = null;
      this.startedAt = new Date().toISOString(); this.endedAt = null;
      this.captureEvents = !!this.config.render; this.visualEvents = [];
      this.startRound();
    }
    startRound() {
      const number = this.results.length + 1;
      const entryBySlot = this.config.alternateSides && number % 2 === 0 ? [1, 0] : [0, 1];
      const seeds = [0, 1].map(i => (this.config.seed + Math.imul(number, 997) + Math.imul(i + 1, 104729)) >>> 0);
      this.current = { number, entryBySlot, seeds, ticks: 0, inits: [], memberInits: [[], []] };
      this.visualEvents = [];
      this.match = World.createMatch(false, false, { teamSizes: entryBySlot.map(entry => this.teams[entry].length) });
      for (let slot = 0; slot < 2; slot++) this.teams[entryBySlot[slot]].forEach((member, index) => {
        const id = `series-slot-${slot}${index ? '-' + index : ''}`;
        const controller = Teams.controller(member, slot, id, (seeds[entryBySlot[slot]] + index * 7919) >>> 0);
        const handlers = {};
        this.match.connect({ id, on(e, fn) { handlers[e] = fn; },
          emit: (e, data) => {
            if (e === 'init') { this.current.memberInits[slot][index] = data; if (!index) this.current.inits[slot] = data; }
            else if (!index && this.captureEvents && ['fx', 'hit', 'heal', 'kill'].includes(e)) {
              this.visualEvents.push({ slot, event: e, data });
              if (this.visualEvents.length > 512) this.visualEvents.shift();
            }
          }, disconnect() {} }, { team: slot, member: index, bot: true, controller, character: member.character, name: member.label });
      });
    }
    currentStats() {
      const totals = [0, 1].map(() => ({ hp: 0, maxHp: 0, kills: 0, energy: 0, members: [] }));
      for (const player of Object.values(this.match.state.players)) {
        const entry = this.current.entryBySlot[player.slot];
        const total = totals[entry]; total.slot = player.slot;
        for (const key of ['hp', 'kills', 'energy']) total[key] += player[key]; total.maxHp += player.cfg.maxHp;
        total.towers = Object.values(this.match.state.towers).filter(t => t.slot === player.slot && !t.dead).length;
        total.members.push({ member: player.member || 0, character: player.character, hp: player.hp, maxHp: player.cfg.maxHp, kills: player.kills, energy: player.energy });
      }
      return totals;
    }
    completeRound(winner, reason) {
      const seconds = this.current.ticks / World.TICK;
      this.results.push({ number: this.current.number, winner, reason, seconds, ticks: this.current.ticks,
        entryBySlot: [...this.current.entryBySlot], seeds: [...this.current.seeds], stats: this.currentStats() });
      if (winner === null) this.draws++; else this.wins[winner]++;
      if (winner !== null && this.wins[winner] >= this.config.firstTo) {
        this.champion = winner; this.status = 'complete'; this.endedAt = new Date().toISOString();
      } else this.startRound();
    }
    advance(ticks = 1) {
      if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1000000) throw Error('Invalid tick budget');
      const round = this.current.number;
      for (let i = 0; i < ticks && this.status === 'running'; i++) {
        this.match.tick(); this.current.ticks++;
        const state = this.match.observe('series-slot-0');
        if (state.phase === 'finished') this.completeRound(this.current.entryBySlot[state.winner], 'tower-destruction');
        else if (this.config.timeLimitSeconds > 0 && this.current.ticks >= Math.ceil(this.config.timeLimitSeconds * World.TICK)) this.completeRound(null, 'time-limit');
        if (this.current.number !== round) break;
      }
      return this.status;
    }
    pause() { if (this.status === 'running') this.status = 'paused'; }
    resume() { if (this.status === 'paused') this.status = 'running'; }
    stop() { if (['running', 'paused'].includes(this.status)) { this.status = 'stopped'; this.endedAt = new Date().toISOString(); } }
    draw() { if (['running', 'paused'].includes(this.status)) { const paused = this.status === 'paused'; this.completeRound(null, 'manual-draw'); if (paused) this.status = 'paused'; } }
    summary() {
      const decided = this.wins[0] + this.wins[1];
      return { version: VERSION, startedAt: this.startedAt, endedAt: this.endedAt, status: this.status, firstTo: this.config.firstTo,
        seed: this.config.seed, alternateSides: !!this.config.alternateSides, timeLimitSeconds: this.config.timeLimitSeconds,
        entries: this.entries, wins: [...this.wins], draws: this.draws, decided, games: this.results.length,
        winRates: this.wins.map(w => decided ? w / decided : null), champion: this.champion,
        current: { number: this.current.number, seconds: this.current.ticks / World.TICK, entryBySlot: [...this.current.entryBySlot], stats: this.currentStats() } };
    }
    frame(entry = 0, member = 0) {
      if (![0, 1].includes(entry)) throw Error('Invalid spectator entry');
      const slot = this.current.entryBySlot.indexOf(entry);
      if (!Number.isInteger(member) || member < 0 || member >= this.teams[entry].length) member = 0;
      const events = this.visualEvents.filter(e => e.slot === slot); this.visualEvents = [];
      return { token: `${this.current.number}:${entry}:${member}`, init: this.current.memberInits[slot][member], state: this.match.observe(`series-slot-${slot}${member ? '-' + member : ''}`), events };
    }
    report() {
      return { ...this.summary(), rulesVersion: 'minion-v1-collection-1', game: { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS },
        winRateDefinition: 'wins / decided games; draws and unfinished games excluded', results: this.results,
        unfinished: this.status === 'complete' ? null : this.summary().current };
    }
  }
  const api = { VERSION, Series, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ArenaSeries = api;
})(globalThis);
