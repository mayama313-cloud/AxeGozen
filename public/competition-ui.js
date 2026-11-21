(() => {
  'use strict';
  const $ = id => document.getElementById(id), entrants = [];
  let locked = false, nextId = 0;
  const make = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const changed = () => $('competitionFormat').dispatchEvent(new Event('competitionchange'));
  function add() {
    if (locked || entrants.length >= 16) return;
    const card = make('section'); card.className = 'series-entry';
    const id = ++nextId;
    const heading = make('h3', `参加チーム ${id}`), label = make('input'); label.value = `チーム ${id}`; label.maxLength = 120;
    const nameLabel = make('label', 'チーム名'); nameLabel.appendChild(label);
    const size = make('select'); for (let i = 1; i <= 5; i++) { const o = make('option', String(i)); o.value = i; size.appendChild(o); }
    const sizeLabel = make('label', '人数'); sizeLabel.appendChild(size);
    const members = make('div'), remove = make('button', 'このチームを削除'); remove.type = 'button';
    card.append(heading, nameLabel, sizeLabel, members, remove); $('competitionParticipants').appendChild(card);
    const builder = new TeamBuilder([members, make('div')], { mode: 'series', prefix: `competition${id}_`, changed });
    const entry = { card, label, size, remove, builder }; entrants.push(entry);
    size.addEventListener('change', () => builder.resize(0, Number(size.value)));
    remove.addEventListener('click', () => { if (locked || entrants.length <= 2) return; entrants.splice(entrants.indexOf(entry), 1); card.remove(); refresh(); changed(); });
    refresh(); changed();
  }
  function refresh() {
    const swiss = $('competitionFormat').value === 'swiss';
    $('competitionSwissSetup').hidden = !swiss; $('competitionSeriesSetup').hidden = swiss;
    $('competitionAdd').disabled = locked || entrants.length >= 16;
    $('competitionRounds').max = Math.max(1, entrants.length - 1);
    if (Number($('competitionRounds').value) > entrants.length - 1) $('competitionRounds').value = Math.max(1, entrants.length - 1);
    entrants.forEach(e => { e.remove.disabled = locked || entrants.length <= 2; });
  }
  window.competitionSetup = {
    get format() { return $('competitionFormat').value; },
    ready: () => entrants.every(e => e.builder.ready()),
    config: () => ({ format: 'swiss', rounds: Number($('competitionRounds').value), participants: entrants.map(e => ({ label: e.label.value, team: e.builder.getTeam() })) }),
    setDisabled(value) { locked = value; entrants.forEach(e => e.builder.setDisabled(value)); refresh(); },
    paint(summary) {
      const c = summary.competition; $('competitionTables').hidden = !c; if (!c) return;
      const row = values => { const tr = make('tr'); values.forEach(v => tr.appendChild(make('td', String(v)))); return tr; };
      $('competitionStandings').replaceChildren(...c.standings.map(p => row([p.rank, p.label, p.points, `${p.wins} / ${p.draws} / ${p.losses}`, p.byes, p.buchholz, p.gameDifference])));
      const names = c.participants.map(p => p.label);
      $('competitionPairings').replaceChildren(...c.rounds.flatMap(r => r.pairings.map(p => row([r.number, names[p.teams[0]], p.bye ? '—' : names[p.teams[1]], p.bye ? '—' : p.wins.join(' − '),
        p.bye ? '不戦勝' : p.status === 'waiting' ? '待機' : p.status === 'running' ? summary.status === 'stopped' ? '中止・未決着' : '対戦中' : p.winner === null ? '引き分け' : `${names[p.winner]} 勝利` + (p.repeated ? '（再戦）' : '')]))));
    }
  };
  $('competitionFormat').addEventListener('change', () => { refresh(); changed(); });
  $('competitionAdd').addEventListener('click', add);
  for (let i = 0; i < 4; i++) add();
  $('competitionRounds').value = 3;
  window.gameSession.on('seriesSetup', data => { if (data?.format) { $('competitionFormat').value = data.format; refresh(); changed(); } });
})();
