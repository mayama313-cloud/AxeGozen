(function(root) {
  'use strict';
  const Teams = root.ArenaTeams || require('./team-config');
  const SeriesApi = root.ArenaSeries || require('./match-series'), Series = SeriesApi.Series;
  function validate(config) {
    const n = config.participants?.length;
    if (!Number.isInteger(n) || n < 2 || n > 16) throw Error('参加チーム数は2〜16で指定してください。');
    if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds >= n) throw Error('ラウンド数は1〜参加チーム数−1で指定してください。');
    config.participants.forEach(p => Teams.normalize([p.team, p.team], { humans: false }));
    SeriesApi.validate({ seed: 17, timeLimitSeconds: 0, ...config, teams: config.participants.slice(0, 2).map(p => p.team) });
    return config;
  }
  // Pair high ranked teams first, minimizing score gaps while avoiding repeat opponents.
  function pair(ranked, previous, allowRepeats = false) {
    let budget = 50000;
    function search(left) {
      if (!left.length) return [];
      if (--budget < 0) return null;
      const a = left[0];
      const candidates = left.slice(1).filter(b => allowRepeats || !previous(a.id, b.id))
        .sort((a1, b1) => Number(previous(a.id, a1.id)) - Number(previous(a.id, b1.id)) || Math.abs(a.points - a1.points) - Math.abs(a.points - b1.points) || a1.rank - b1.rank);
      for (const b of candidates) {
        const rest = search(left.filter(p => p !== a && p !== b));
        if (rest) return [[a.id, b.id], ...rest];
      }
      return null;
    }
    return search(ranked);
  }
  class Competition {
    constructor(config) {
      this.config = validate({ seed: 17, timeLimitSeconds: 0, alternateSides: true, ...config });
      this.participants = config.participants.map((p, id) => ({ id, label: String(p.label || `チーム ${id + 1}`).slice(0, 120), team: Teams.normalize([p.team, p.team], { humans: false })[0] }));
      let seed = this.config.seed >>> 0;
      const order = this.participants.map(p => p.id);
      for (let i = order.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      this.seeds = order; this.results = []; this.rounds = []; this.status = 'running'; this.startedAt = new Date().toISOString(); this.endedAt = null;
      this.startRound();
    }
    standings() {
      const rows = this.participants.map(p => ({ id: p.id, label: p.label, points: 0, wins: 0, draws: 0, losses: 0, byes: 0, gameWins: 0, gameLosses: 0, opponents: [], buchholz: 0 }));
      for (const round of this.rounds) for (const p of round.pairings) {
        if (p.status !== 'complete') continue;
        if (p.bye) { const a = rows[p.teams[0]]; a.points++; a.byes++; continue; }
        const [a, b] = p.teams.map(id => rows[id]); a.opponents.push(b.id); b.opponents.push(a.id);
        a.gameWins += p.wins[0]; a.gameLosses += p.wins[1]; b.gameWins += p.wins[1]; b.gameLosses += p.wins[0];
        if (p.winner === null) { a.points += .5; b.points += .5; a.draws++; b.draws++; }
        else { const winner = rows[p.winner], loser = a === winner ? b : a; winner.points++; winner.wins++; loser.losses++; }
      }
      rows.forEach(r => { r.buchholz = r.opponents.reduce((sum, id) => sum + rows[id].points, 0); r.gameDifference = r.gameWins - r.gameLosses; });
      return rows.sort((a, b) => b.points - a.points || b.buchholz - a.buchholz || b.gameDifference - a.gameDifference || this.seeds.indexOf(a.id) - this.seeds.indexOf(b.id)).map((r, i) => ({ ...r, rank: i + 1 }));
    }
    startRound() {
      const ranked = this.standings(), previous = (a, b) => ranked.find(p => p.id === a).opponents.includes(b);
      let bye = null;
      if (ranked.length % 2) {
        const candidates = [...ranked].sort((a, b) => a.byes - b.byes || a.points - b.points || b.rank - a.rank);
        // Prefer a bye that permits pairing everybody else without a repeat.
        bye = candidates.find(p => p.byes === candidates[0].byes && pair(ranked.filter(r => r !== p), previous)) || candidates[0];
      }
      const remaining = ranked.filter(p => p !== bye);
      const pairs = pair(remaining, previous) || pair(remaining, previous, true);
      const round = { number: this.rounds.length + 1, pairings: pairs.map(teams => ({ teams, status: 'waiting', repeated: previous(...teams), bye: false, wins: [0, 0], winner: null, games: [] })) };
      if (bye) round.pairings.push({ teams: [bye.id], status: 'complete', bye: true, wins: [0, 0], winner: bye.id, games: [] });
      this.rounds.push(round); this.startPair();
    }
    startPair() {
      const round = this.rounds.at(-1), p = round.pairings.find(p => p.status === 'waiting');
      if (!p) {
        if (round.number < this.config.rounds) { this.startRound(); return; }
        this.status = 'complete'; this.endedAt = new Date().toISOString(); return;
      }
      p.status = 'running'; this.pairing = p;
      this.series = new Series({ ...this.config, seed: (this.config.seed + round.number * 104729 + round.pairings.indexOf(p) * 997) >>> 0,
        teams: p.teams.map(id => this.participants[id].team), teamLabels: p.teams.map(id => this.participants[id].label) });
      this.collected = 0;
    }
    collect() {
      const p = this.pairing;
      for (const game of this.series.results.slice(this.collected)) {
        const result = { ...game, competitionRound: this.rounds.length, teams: [...p.teams], labels: p.teams.map(id => this.participants[id].label) };
        p.games.push(result); this.results.push(result);
      }
      this.collected = this.series.results.length; p.wins = [...this.series.wins];
      const capped = p.games.length >= 2 * this.config.firstTo - 1;
      if (this.series.status === 'complete' || capped) {
        p.status = 'complete'; p.winner = p.wins[0] === p.wins[1] ? null : p.teams[p.wins[0] > p.wins[1] ? 0 : 1];
        if (this.series.status !== 'complete') this.series.stop();
        this.startPair();
      }
    }
    advance(ticks = 1) {
      if (this.status !== 'running') return this.status;
      this.series.advance(ticks); this.collect(); return this.status;
    }
    pause() { if (this.status === 'running') { this.status = 'paused'; this.series.pause(); } }
    resume() { if (this.status === 'paused') { this.status = 'running'; this.series.resume(); } }
    stop() { if (['running', 'paused'].includes(this.status)) { this.status = 'stopped'; this.endedAt = new Date().toISOString(); this.series.stop(); } }
    draw() {
      if (!['running', 'paused'].includes(this.status)) return;
      const paused = this.status === 'paused'; this.series.draw(); this.collect();
      if (paused && this.status !== 'complete') this.series.pause();
    }
    get captureEvents() { return this.series.captureEvents; }
    set captureEvents(value) { this.config.render = value; this.series.captureEvents = value; }
    get visualEvents() { return this.series.visualEvents; }
    set visualEvents(value) { this.series.visualEvents = value; }
    frame(entry, member) { const f = this.series.frame(entry, member); f.token = `${this.rounds.length}:${this.rounds.at(-1).pairings.indexOf(this.pairing)}:${f.token}`; return f; }
    summary() {
      return { ...this.series.summary(), version: 'axegozen-competition/1', seed: this.config.seed, status: this.status, startedAt: this.startedAt, endedAt: this.endedAt,
        competition: { version: 'axegozen-competition/1', format: 'swiss', round: this.rounds.length, totalRounds: this.config.rounds,
          participants: this.participants.map(p => ({ id: p.id, label: p.label, members: p.team.map(Teams.describe) })), standings: this.standings(),
          rounds: this.rounds.map(r => ({ number: r.number, pairings: r.pairings.map(({ games, ...p }) => ({ ...p, gameCount: games.length })) })),
          seedOrder: this.seeds, currentTeams: this.pairing.teams, pairingSeed: this.series.config.seed, games: this.results.length,
          champion: this.status === 'complete' ? this.standings()[0].id : null,
          ranking: 'points, Buchholz (sum of opponents points; bye excluded), game wins minus losses, seeded order',
          scoring: 'win/bye=1, draw=0.5, loss=0; max games per pairing=2*firstTo-1' } };
    }
    report() { return { ...this.summary(), results: this.results, firstTo: this.config.firstTo, rulesVersion: 'minion-v1-collection-1', ranking: 'points, Buchholz (sum of opponents points; bye excluded), game wins minus losses, seeded order', scoring: 'win/bye=1, draw=0.5, loss=0; max games per pairing=2*firstTo-1', unfinished: this.status === 'complete' ? null : this.series.report().unfinished }; }
  }
  const api = { Competition, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ArenaCompetition = api;
})(globalThis);
