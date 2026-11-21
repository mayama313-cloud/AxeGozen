(function(root) {
  'use strict';
  const World = root.ArenaWorld || require('../game-world');
  const Policy = root.MinionPolicy || require('./minion-policy');
  function normalize(teams, { humans = true, pendingModels = false } = {}) {
    if (!Array.isArray(teams) || teams.length !== 2 || teams.some(t => !Array.isArray(t) || t.length < 1 || t.length > 5)) throw Error('各チームは1〜5人で編成してください。');
    return teams.map(team => team.map((member, index) => {
      if (!member || !['human', 'algorithm', 'model'].includes(member.kind) || (!humans && member.kind === 'human')) throw Error('メンバーの操作主体が不正です。');
      const character = member.character || 'alex';
      if (!World.characterFor(character)) throw Error('キャラクターが不正です。');
      if (member.kind === 'model') {
        if (!member.model && pendingModels) { /* Upload follows room creation. */ }
        else {
          Policy.validate(member.model);
          if (member.model.rulesVersion !== 'minion-v1-collection-1') throw Error('モデルのルール版が一致しません。');
          if (!member.model.characters.includes(character)) throw Error('モデルが選択キャラクターに対応していません。');
        }
      }
      return { kind: member.kind, character, label: String(member.label || `${member.kind === 'human' ? 'プレイヤー' : 'CPU'} ${index + 1}`).slice(0, 60),
        model: member.kind === 'model' ? member.model || null : null,
        fileName: member.kind === 'model' ? String(member.fileName || '').slice(0, 150) : null,
        sha256: member.kind === 'model' && typeof member.sha256 === 'string' ? member.sha256.slice(0, 64) : null };
    }));
  }
  function describe(member, index) {
    return { member: index, kind: member.kind, label: member.label, character: member.character,
      characterName: World.characterFor(member.character).name,
      model: member.kind === 'model' ? { name: member.model?.modelName || '学習モデル',
        format: member.model?.format || null, featureVersion: member.model?.featureVersion || null,
        objectiveVersion: member.model?.objectivePolicy?.version || null, characters: member.model?.characters || [],
        fileName: member.fileName, sha256: member.sha256, ready: !!member.model } : null };
  }
  function controller(member, team, actorId, seed) {
    return member.kind === 'model' ? Policy.controller({ ...member.model, init: { ...member.model.init,
      cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS } }, { slot: team, actorId, seed }) : null;
  }
  const api = { normalize, describe, controller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ArenaTeams = api;
})(globalThis);
