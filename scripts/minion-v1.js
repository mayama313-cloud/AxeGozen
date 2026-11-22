const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const Policy = require('../public/minion-policy');
const { validate } = require('../public/training-data');
const { createMatch, TICK } = require('../game-world');
const { preflight, parseJSON, readJSON } = require('./minion-input');
const root = path.resolve(__dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const output = path.resolve(arg('output', path.join(root, process.argv[2] === 'league' ? 'datas/models/minion-v1-v12-league' : process.argv[2] === 'rl' ? 'datas/models/minion-v1-rl' : 'datas/models/minion-v1')));
const fingerprint = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function prepare() {
  fs.mkdirSync(output, { recursive: true });
  const teacherDir = path.resolve(arg('teachers', path.join(root, 'datas/teachers'))), replayDir = path.resolve(arg('replays', path.join(root, 'datas/replays')));
  const teachers = fs.readdirSync(teacherDir).filter(f => f.endsWith('.jsonl')).sort();
  if (!teachers.length) throw Error('教師データJSONLがありません。');
  const replays = fs.readdirSync(replayDir).filter(f => f.endsWith('.json')).sort();
  // 大きな原本を読む前に、LFSポインターや空ファイルを確認する。
  for (const file of teachers) preflight(path.join(teacherDir, file));
  for (const file of replays) preflight(path.join(replayDir, file));
  const rawIndex = new Map();
  for (const file of replays) {
    const full = path.join(replayDir, file), raw = validate(readJSON(full));
    if (rawIndex.has(raw.id)) throw Error('同じ試合IDの原本が複数あります。');
    rawIndex.set(raw.id, { full });
  }
  const rows = [], audit = { model: 'ミニオン v1', files: [], sourceCounts: {}, commands: {}, characters: [], limitations: ['action-match metrics do not establish playing strength', 'hashed observations are lossy', 'no reinforcement learning or reward training'] };
  const seen = new Set(), memory = {}, priorities = { steer: 1, move: 2, chase: 3, cancelLeap: 4, recall: 5, q: 6, c: 7, dash: 8, leap: 9 };
  let init, rulesVersion;
  for (const name of teachers) {
    const file = path.join(teacherDir, name), reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let manifest, raw, frames, previousFrames, records = 0, accepted = 0, pendingActions = [], selectedSince = 0, lastActor, lineNumber = 0;
    for await (const line of reader) {
      lineNumber++;
      if (!line.trim()) continue;
      const sample = parseJSON(line, file, lineNumber);
      if (!manifest) {
        manifest = sample;
        if (manifest.kind !== 'manifest' || manifest.schema !== 'axe-gozen-imitation/1' || !rawIndex.has(manifest.episodeId)) throw Error('対応する原本がありません: ' + name);
        raw = readJSON(rawIndex.get(manifest.episodeId).full);
        frames = raw.entries.filter(e => e.kind === 'frame');
        previousFrames = new Map();
        for (let i = 1; i < frames.length; i++) previousFrames.set(`${frames[i].tick}:${frames[i].time}`, i);
        continue;
      }
      records++;
      const actor = sample.actor, info = raw.actors[actor];
      const index = previousFrames.get(`${sample.tick}:${sample.end}`);
      if (sample.episodeId !== raw.id || !info || info.source !== sample.source || index === undefined || !isDeepStrictEqual(frames[index - 1].views[actor], sample.observation) || !isDeepStrictEqual(frames[index].views[actor], sample.nextObservation)) throw Error(`原本と観測が一致しません: ${name}:${records + 1}`);
      for (const item of [...sample.actions, ...sample.events]) {
        const original = raw.entries[item.seq];
        if (!original || original.actor !== actor || original.event !== item.event || !isDeepStrictEqual(original.data, item.data) || (original.kind === 'action' && !isDeepStrictEqual(original.observation, item.observation))) throw Error('原本と入力・演出が一致しません。');
      }
      audit.sourceCounts[sample.source] = (audit.sourceCounts[sample.source] || 0) + 1;
      if (sample.source !== 'human' && !process.argv.includes('--include-cpu')) continue;
      const key = `${raw.id}:${actor}:${sample.tick}:${sample.end}`;
      if (seen.has(key)) throw Error('重複した教師サンプルです: ' + key); seen.add(key);
      if (!init) { init = info.init; rulesVersion = sample.rulesVersion; }
      if (sample.rulesVersion !== rulesVersion) throw Error('ルール版が異なる教師データが混在しています。');
      if (lastActor !== actor || sample.sequenceStart) { memory[actor] = {}; pendingActions = []; selectedSince = 0; }
      lastActor = actor;
      const history = memory[actor] ||= {};
      Policy.updateMemory(history, sample.observation, actor);
      pendingActions = [...sample.actions];
      selectedSince++;
      if (selectedSince < 3 && !sample.sequenceEnd && !sample.actions.some(a => a.event !== 'steer')) { Policy.updateMemory(history, sample.nextObservation, actor, sample.events); continue; }
      selectedSince = 0;
      pendingActions.sort((a, b) => priorities[b.event] - priorities[a.event] || b.seq - a.seq);
      let action = pendingActions[0], observation = action?.observation || sample.observation;
      pendingActions = [];
      const me = observation.players.find(p => p.id === actor);
      if (!me || !Number.isFinite(me.x) || me.dead || me.stun > 0 || me.air > 0 || me.warping > 0 || me.charging || me.grabbing || me.grabbed || me.flying) continue;
      if (!action && me.inputs?.keys) action = { event: 'steer', data: me.inputs.keys };
      const target = Policy.label(action, observation, actor);
      // 収集されるのは入力要求。クールダウン等で実行不能な要求は模倣対象から除く。
      if (action && ((action.event === 'q' && me.qCd > 0) || (['dash', 'leap'].includes(action.event) && me.eCd > 0) || (action.event === 'c' && me.cCd > 0))) continue;
      if (['move', 'chase', 'q', 'leap'].includes(action?.event) && !target.hasPoint) continue;
      const event = Policy.EVENTS[target.type]; audit.commands[event] = (audit.commands[event] || 0) + 1;
      if (!audit.characters.includes(me.character)) audit.characters.push(me.character);
      rows.push({ x: Array.from(Policy.features(observation, actor, info.init, history)), y: target.type, xy: target.xy, point: target.hasPoint,
        episodeId: raw.id, actor, character: me.character, time: sample.start, source: sample.source }); accepted++;
      Policy.updateMemory(history, sample.nextObservation, actor, sample.events);
    }
    if (!manifest || records !== manifest.samples) throw Error('manifestのサンプル数が一致しません。');
    audit.files.push({ teacher: name, replay: path.basename(rawIndex.get(raw.id).full), episodeId: raw.id, duration: raw.duration,
      records, prepared: accepted, teacherSha256: fingerprint(file), replaySha256: fingerprint(rawIndex.get(raw.id).full) });
  }
  if (rows.length < 10) throw Error('学習可能なサンプルが不足しています。');
  const payload = { format: Policy.VERSION, inputSize: Policy.SIZE, events: Policy.EVENTS, rulesVersion, init, audit, rows };
  fs.writeFileSync(path.join(output, 'prepared.json'), JSON.stringify(payload));
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(audit, null, 2));
  console.log(JSON.stringify({ prepared: rows.length, commands: audit.commands, audit: path.join(output, 'audit.json') }));
  return payload;
}

function smoke() {
  const model = Policy.validate(readJSON(path.join(output, 'model.json')));
  const report = { model: model.modelName, games: [], limitation: 'functional smoke test; no strength/generalization claim' };
  for (const character of model.characters) {
    const control = Policy.controller(model), handlers = {}, counts = {}, positions = [];
    let lastState, lastInput, decisions = 0;
    const policy = state => {
      decisions++;
      const commands = control(state); for (const c of commands) counts[c.event] = (counts[c.event] || 0) + 1;
      return commands;
    };
    policy.observe = control.observe; policy.observeState = control.observeState; policy.reset = control.reset;
    const match = createMatch(false, true, { policy, trace: e => { if (e.kind === 'action' && e.actor === 'cpu-player') lastInput = e; } });
    match.connect({ id: 'human', on(e, fn) { handlers[e] = fn; }, emit(e, state) { if (e === 'state') lastState = state; }, disconnect() {} });
    handlers.selectCpuCharacter({ id: character }); handlers.selectCharacter({ id: 'alex' }); handlers.confirmCharacter();
    for (let i = 0; i < TICK * 60; i++) {
      match.tick(); const bot = match.state.players['cpu-player'];
      if (![bot.x, bot.z, bot.hp].every(Number.isFinite) || Math.abs(bot.x) > 29.001 || Math.abs(bot.z) > 29.001) throw Error('推論後のゲーム状態が不正です。');
      if (i % TICK === 0) positions.push([bot.x, bot.z]);
    }
    if (!Object.keys(counts).length) throw Error('モデルが入力を一度も出しませんでした。');
    if (!positions.some(p => Math.hypot(p[0] - 24, p[1] + 24) > 0.1)) throw Error('モデル操作による移動が確認できません。');
    const bot = match.state.players['cpu-player'];
    report.games.push({ character, seconds: 60, decisions, commands: counts, final: { x: bot.x, z: bot.z, phase: lastState.phase }, lastInput: lastInput?.event });
  }
  const probe = readJSON(path.join(output, 'parity.json'));
  const actual = Policy.forward(model, probe.x);
  const error = Math.max(...actual.logits.map((n, i) => Math.abs(n - probe.logits[i])), ...actual.points.map((n, i) => Math.abs(n - probe.points[i])));
  if (error > 1e-4) throw Error('PythonとJavaScriptの推論が一致しません: ' + error);
  if (probe.directions && Math.max(...actual.directions.map((n, i) => Math.abs(n - probe.directions[i]))) > 1e-4) throw Error('移動方向の推論が一致しません。');
  if (probe.orders && Math.max(...actual.orders.map((n, i) => Math.abs(n - probe.orders[i]))) > 1e-4) throw Error('追跡操作の推論が一致しません。');
  report.pythonJavaScriptMaxError = error;
  fs.writeFileSync(path.join(output, 'smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

(async () => {
  const command = process.argv[2] || 'check';
  if (command === 'league') {
    const initial = path.resolve(arg('model', 'datas/models/minion-v1-v11-combat/model.json'));
    Policy.validate(readJSON(initial));
    const histories = process.argv.flatMap((v,i) => v === '--history' ? [path.resolve(process.argv[i+1])] : []);
    if (!histories.length) histories.push(path.resolve('datas/models/minion-v1-v10-bush-adapter/model.json'),path.resolve('datas/models/minion-v1-v8-offense/model.json'));
    histories.forEach(f => Policy.validate(readJSON(f)));
    const args = [path.join(__dirname,'train-minion-league.py'),'--model',initial,'--output',output,'--node',process.execPath];
    for (const file of histories) args.push('--history',file);
    for (const [name,fallback] of Object.entries({ updates:'128',steps:'128',envs:'8','max-seconds':'600','interval-ticks':'6','snapshot-every':'8','history-size':'6',seed:'20261204','eval-games':'8','eval-seconds':'900','latest-weight':'4','history-weight':'3','algorithm-weight':'3','learning-rate':'.0003','farm-start-fraction':'.25','push-start-fraction':'.25' })) args.push('--'+name,arg(name,fallback));
    const result=spawnSync(arg('python','python'),args,{stdio:'inherit'});
    if (result.error || result.status !== 0) throw result.error || Error('リーグ学習に失敗しました。');
    const model=Policy.validate(readJSON(path.join(output,'model.json'))),probe=readJSON(path.join(output,'league-parity.json')),D=require('../public/minion-decisions');
    const error=Math.abs(D.score(model.tacticalPolicy,probe.candidate,D.context(model.tacticalPolicy,probe.x))-probe.score);
    if (error > 1e-4) throw Error('リーグ方策のPython/JavaScript不一致: '+error);
    console.log(JSON.stringify({leagueParityError:error,report:path.join(output,'league-training.json')})); return;
  }
  if (['check', 'prepare', 'train'].includes(command)) await prepare();
  if (command === 'train') {
    const result = spawnSync(arg('python', 'python'), [path.join(__dirname, 'train-minion.py'), '--output', output, '--epochs', arg('epochs', '30')], { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error || Error('学習処理に失敗しました。');
  }
  if (command === 'rl') {
    const initial = path.resolve(arg('model', path.join(root, 'datas/models/minion-v1/model.json')));
    const initialModel = Policy.validate(readJSON(initial));
    if (initialModel.leagueTraining) throw Error('v12リーグモデルの追加学習には rl ではなく league コマンドを使ってください。');
    if (process.argv.includes('--combat-decisions')) {
      const args = [path.join(__dirname, 'train-minion-decisions.py'), '--model', initial, '--output', output, '--node', process.execPath];
      if (process.argv.includes('--scope-encounter')) args.push('--scope-encounter');
      if (arg('focus-character', null)) args.push('--focus-character', arg('focus-character', null));
      for (const [name, fallback] of Object.entries({ updates: '100', steps: '96', envs: '8', 'max-seconds': '25', 'eval-every': '20', 'eval-episodes': '64', 'eval-seconds': '25', seed: '20261127', 'decision-fraction': '.75', 'base-prior': '4.5' })) args.push('--' + name, arg(name, fallback));
      const trained = spawnSync(arg('python', 'python'), args, { stdio: 'inherit' });
      if (trained.error || trained.status !== 0) throw trained.error || Error('戦闘判断のPPO学習に失敗しました。');
      const model = Policy.validate(readJSON(path.join(output, 'model.json'))), parity = readJSON(path.join(output, 'decision-parity.json'));
      const error = Math.abs(require('../public/minion-decisions').score(model.tacticalPolicy, parity.x) - parity.score);
      if (error > 1e-5) throw Error('戦闘判断の推論不一致: ' + error);
      console.log(JSON.stringify({ decisionParityError: error })); smoke(); return;
    }
    const args = [path.join(__dirname, 'reinforce-minion.py'), '--model', initial, '--output', output, '--node', process.execPath];
    if (process.argv.includes('--train-base')) args.push('--train-base');
    if (process.argv.includes('--hybrid') && process.argv.includes('--pure-rl')) throw Error('--hybrid と --pure-rl は同時に指定できません。');
    if (!process.argv.includes('--hybrid')) args.push('--pure-rl');
    if (process.argv.includes('--bush-memory')) args.push('--bush-memory');
    if (process.argv.includes('--perception-adapter')) args.push('--perception-adapter');
    const reference = arg('reference-model', null);
    if (reference) { const full = path.resolve(reference); Policy.validate(readJSON(full)); args.push('--reference-model', full); }
    for (const [name, fallback] of Object.entries({ updates: '100', steps: '128', envs: '4', 'max-seconds': '120', 'retreat-fraction': '0.25', 'farm-fraction': '0.2', 'defense-fraction': '0.3', 'bush-fraction': '0', 'eval-episodes': '16', 'eval-seconds': '60', 'eval-every': '25', seed: '17' })) args.push('--' + name, arg(name, fallback));
    const result = spawnSync(arg('python', 'python'), args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error || Error('強化学習に失敗しました。');
  }
  if (command === 'train' || command === 'smoke' || command === 'rl') smoke();
  if (!['check', 'prepare', 'train', 'smoke', 'rl'].includes(command)) throw Error('command: check | prepare | train | smoke | rl');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
