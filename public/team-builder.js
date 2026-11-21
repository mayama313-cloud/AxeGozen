(function(root) {
  'use strict';
  const create = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const option = (value, text) => { const el = create('option', text); el.value = value; return el; };
  class TeamBuilder {
    constructor(containers, { mode = 'local', prefix = 'team', changed = () => {} } = {}) {
      this.containers = containers; this.mode = mode; this.prefix = prefix; this.changed = changed;
      this.teams = [[], []]; this.disabled = false;
      this.resize(0, 1); this.resize(1, 1);
    }
    id(field, team, member) { return this.prefix === 'series' && member === 0 ? `series${field}${team}` : `${this.prefix}${field}${team}_${member}`; }
    kinds(team, index) {
      if (this.mode === 'series') return ['algorithm', 'model'];
      if (team === 0 && index === 0) return ['human'];
      return this.mode === 'online' ? ['human', 'algorithm', 'model'] : ['algorithm', 'model'];
    }
    resize(team, count) {
      if (!Number.isInteger(count) || count < 1 || count > 5 || this.disabled) return;
      while (this.teams[team].length < count) {
        const index = this.teams[team].length;
        this.teams[team].push({ kind: this.mode !== 'series' && index === 0 && (team === 0 || this.mode === 'online') ? 'human' : 'algorithm', character: 'alex', model: null, token: 0 });
      }
      this.teams[team].length = count; this.render(team); this.changed();
    }
    setMode(mode) {
      if (this.disabled || this.mode === mode) return;
      this.mode = mode;
      for (let team = 0; team < 2; team++) {
        this.teams[team].forEach((m, index) => { if (!this.kinds(team, index).includes(m.kind)) m.kind = this.kinds(team, index)[0]; });
        if (mode === 'online' && this.teams[1][0].kind === 'algorithm' && !this.teams[1][0].touched) this.teams[1][0].kind = 'human';
        this.render(team);
      }
      this.changed();
    }
    setDisabled(disabled) {
      this.disabled = disabled;
      this.containers.forEach(el => el.querySelectorAll('input,select,button').forEach(input => { input.disabled = disabled; }));
    }
    ready() { return this.teams.every(team => team.every(m => m.kind !== 'model' || (m.model && !m.loading))); }
    getTeams() {
      if (!this.ready()) throw Error('各モデルの読み込みを完了してください。');
      return ArenaTeams.normalize(this.teams.map(team => team.map(m => ({ ...m, label: m.label || (m.kind === 'model' ? m.model.modelName : m.kind === 'human' ? 'プレイヤー' : 'CPU') }))));
    }
    getTeam() { return this.getTeams()[0]; }
    render(team) {
      const container = this.containers[team]; container.replaceChildren();
      this.teams[team].forEach((m, index) => {
        const card = create('section'); card.className = 'team-member'; card.dataset.member = index;
        card.appendChild(create('h4', `${index + 1}人目${this.mode !== 'series' && team === 0 && index === 0 ? '（自分）' : ''}`));
        const field = (text, input) => { const label = create('label', text); label.appendChild(input); card.appendChild(label); return label; };
        const kind = create('select'); kind.id = this.id('Kind', team, index);
        for (const k of this.kinds(team, index)) kind.appendChild(option(k, { human: '人間プレイヤー', algorithm: 'CPU：アルゴリズム', model: 'CPU：学習モデル（JSON）' }[k]));
        kind.value = m.kind; field('操作主体', kind);
        const file = create('input'); file.type = 'file'; file.accept = '.json,application/json'; file.id = this.id('File', team, index);
        const fileGroup = field('モデルファイル', file); fileGroup.hidden = m.kind !== 'model';
        const status = create('p', m.loading ? '読み込み中…' : m.error || (m.model ? `読み込み済み：${m.model.modelName || '学習モデル'} / ${m.fileName}` : ''));
        status.className = 'series-note'; status.id = this.id('Model', team, index); card.appendChild(status);
        const characters = create('select'); characters.id = this.id('Character', team, index);
        const fill = () => {
          characters.replaceChildren();
          for (const c of ArenaWorld.CHARACTERS) if (m.kind !== 'model' || !m.model || m.model.characters.includes(c.id)) characters.appendChild(option(c.id, c.name));
          if (![...characters.options].some(o => o.value === m.character)) m.character = characters.options[0]?.value || 'alex';
          characters.value = m.character;
        };
        fill(); field('キャラクター', characters);
        kind.addEventListener('change', () => { m.kind = kind.value; m.touched = true; fileGroup.hidden = m.kind !== 'model'; fill(); this.changed(); });
        characters.addEventListener('change', () => { m.character = characters.value; this.changed(); });
        file.addEventListener('change', async () => {
          const selected = file.files[0], token = ++m.token; m.model = null; m.loading = !!selected; m.error = null;
          status.textContent = m.loading ? 'モデルを読み込み中…' : ''; this.changed(); if (!selected) return;
          try {
            const bytes = await selected.arrayBuffer(), source = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
            if (/^\s*version https:\/\/git-lfs/.test(source)) throw Error('Git LFSの参照です。実体のmodel.jsonを読み込んでください。');
            const model = MinionPolicy.validate(JSON.parse(source));
            if (model.rulesVersion !== 'minion-v1-collection-1') throw Error('モデルのルール版が一致しません。');
            const hash = root.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('') : null;
            if (m.token !== token) return;
            m.model = model; m.fileName = selected.name; m.sha256 = hash;
            status.textContent = `${model.modelName || '学習モデル'}｜対応：${model.characters.map(id => ArenaWorld.characterFor(id).name).join('、')}`;
            fill();
          } catch (error) { if (m.token === token) { m.error = error.message; status.textContent = error.message; } }
          finally { if (m.token === token) { m.loading = false; this.changed(); } }
        });
        container.appendChild(card);
      });
      this.setDisabled(this.disabled);
    }
  }
  root.TeamBuilder = TeamBuilder;
})(globalThis);
