const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../judges/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const clone = value => JSON.parse(JSON.stringify(value));
const ok = body => ({ ok: true, status: 200, json: async () => body });
const ids = [6, 8, 35];

// Only the final-round controls need DOM behavior; other page sections are inert.
function element(id = '') {
  const groups = new Map();
  let markup = '';
  const el = {
    dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    querySelectorAll: selector => groups.get(selector) || [],
    querySelector: selector => (groups.get(selector) || [])[0] || null,
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      groups.clear();
      if (id !== 'finalArea') return;
      groups.set('[data-mode]', [...value.matchAll(/data-mode="([^"]+)"/g)].map(m => ({ dataset: { mode: m[1] } })));
      if (value.includes('data-save-rank')) groups.set('[data-save-rank]', [{}]);
      groups.set('.card', [...value.matchAll(/<article class="card" data-id="(\d+)">([\s\S]*?)<\/article>/g)].map(m => {
        const card = element();
        card.dataset.id = m[1];
        const controls = new Map();
        controls.set('[data-tier]', [...m[2].matchAll(/data-tier="([^"]*)"/g)].map(t => ({ dataset: { tier: t[1] } })));
        if (m[2].includes('data-up')) controls.set('[data-up]', [{}]);
        if (m[2].includes('data-dn')) controls.set('[data-dn]', [{}]);
        controls.set('[data-fn]', [{ value: '' }]);
        card.querySelectorAll = selector => controls.get(selector) || [];
        card.querySelector = selector => (controls.get(selector) || [])[0] || null;
        return card;
      }));
    }
  };
  return el;
}

function portal() {
  const elements = new Map();
  const storage = new Map();
  const timers = new Map();
  const saves = [];
  let timerId = 0;
  let rows = [];
  let save = async () => ok({ ok: true });
  const document = {
    body: element(), activeElement: null,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    querySelectorAll: () => []
  };
  const context = vm.createContext({
    document, window: { scrollTo() {} }, console: { error() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setInterval() {},
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      if (url.endsWith('/load')) return ok({ rows: clone(rows) });
      assert.match(url, /\/save$/);
      const row = JSON.parse(options.body);
      saves.push(row);
      return save(row);
    }
  });
  vm.runInContext(script + '\n;globalThis.app = { state, rowFor, push, pull, retryDirty, renderFinal, renderFinalResults, finalComplete, saveFinal, dirty, writes, setJudge(n) { _me = n; } };', context);
  const app = context.app;
  app.setJudge('Kevin');
  app.state.finalists = [...ids];
  return {
    app, saves, storage,
    final: document.getElementById('finalArea'),
    setRows(value) { rows = value; },
    onSave(fn) { save = fn; },
    async settle() { while (app.writes.size) await Promise.all([...app.writes.values()]); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    card(id) { return document.getElementById('finalArea').querySelectorAll('.card').find(c => +c.dataset.id === id); },
    mode(mode) { document.getElementById('finalArea').querySelectorAll('[data-mode]').find(b => b.dataset.mode === mode).onclick(); }
  };
}

test('legacy rows load as rankings and round-trip existing order and notes', async () => {
  for (const stringEncoded of [false, true]) {
    const p = portal();
    const order = [35, 6, 8], notes = { 6: 'Existing feedback' };
    p.setRows([{ round: 'final', judge: 'Kevin', sub: 0,
      order: stringEncoded ? JSON.stringify(order) : order,
      fin_note: stringEncoded ? JSON.stringify(notes) : notes }]);
    await p.app.pull();
    assert.deepEqual(clone(p.app.state.fin.Kevin), { judge: 'Kevin', mode: 'rank', order, tiers: {}, notes });
    assert.equal(p.app.finalComplete(p.app.state.fin.Kevin, ids), true);
    await p.app.push(p.app.rowFor('final|Kevin|0'));
    assert.deepEqual(p.saves.at(-1), { round: 'final', judge: 'Kevin', sub: 0, mode: 'rank', order, tiers: {}, fin_note: notes });
  }
});

test('tier rows reload, serialize, and retry with all choices and notes intact', async () => {
  const p = portal();
  const tiers = { 6: 'S', 8: 'S', 35: 'B' }, notes = { 35: 'Promising idea' };
  p.setRows([{ round: 'final', judge: 'Kevin', mode: 'tiers', order: '[35,6,8]', tiers: JSON.stringify(tiers), fin_note: JSON.stringify(notes) }]);
  await p.app.pull();
  assert.equal(p.app.state.fin.Kevin.mode, 'tiers');
  assert.deepEqual(clone(p.app.state.fin.Kevin.tiers), tiers);
  let attempt = 0;
  p.onSave(async () => { if (++attempt === 1) throw new Error('offline'); return ok({ ok: true }); });
  await p.app.push(p.app.rowFor('final|Kevin|0'));
  assert.equal(p.app.dirty.has('final|Kevin|0'), true);
  await p.app.retryDirty();
  assert.equal(p.app.dirty.size, 0);
  assert.equal(p.saves.length, 2);
  assert.deepEqual(p.saves[1], { round: 'final', judge: 'Kevin', sub: 0, mode: 'tiers', order: [35, 6, 8], tiers, fin_note: notes });
});

test('switching methods preserves both ballots; tier ties and clearing work', async () => {
  const p = portal();
  p.app.state.fin.Kevin = { judge: 'Kevin', mode: 'rank', order: [35, 6, 8], notes: { 8: 'Keep this note' } };
  p.app.renderFinal();
  p.mode('tiers');
  for (const id of [6, 8]) p.card(id).querySelectorAll('[data-tier]').find(b => b.dataset.tier === 'S').onclick();
  p.card(35).querySelectorAll('[data-tier]').find(b => b.dataset.tier === 'A').onclick();
  assert.match(p.final.innerHTML, /3 of 3 finalists assigned/);
  p.mode('rank');
  assert.deepEqual(p.final.querySelectorAll('.card').map(c => +c.dataset.id), [35, 6, 8]);
  p.mode('tiers');
  assert.deepEqual(clone(p.app.state.fin.Kevin.tiers), { 6: 'S', 8: 'S', 35: 'A' });
  p.card(8).querySelectorAll('[data-tier]').find(b => b.dataset.tier === '').onclick();
  assert.match(p.final.innerHTML, /2 of 3 finalists assigned/);
  assert.deepEqual(clone(p.app.state.fin.Kevin.order), [35, 6, 8]);
  assert.deepEqual(clone(p.app.state.fin.Kevin.notes), { 8: 'Keep this note' });
  await p.settle();
  assert.deepEqual(p.saves.at(-1).tiers, { 6: 'S', 35: 'A' });
});

test('rapid saves are serialized and keep the newest tier selection', async () => {
  const p = portal();
  let releaseFirst;
  p.onSave(() => p.saves.length === 1 ? new Promise(resolve => { releaseFirst = resolve; }) : Promise.resolve(ok({ ok: true })));
  p.app.saveFinal('Kevin', { mode: 'tiers', tiers: { 6: 'S' } });
  p.app.saveFinal('Kevin', { tiers: { 6: 'A', 8: 'B' } });
  assert.equal(p.saves.length, 1, 'second write must wait for the first');
  assert.equal(p.app.dirty.has('final|Kevin|0'), true);
  releaseFirst(ok({ ok: true }));
  await p.settle();
  assert.equal(p.saves.length, 2);
  assert.deepEqual(p.saves.at(-1).tiers, { 6: 'A', 8: 'B' });
  assert.equal(p.app.dirty.size, 0);
});

test('a delayed note save cannot revert a newer order or evaluation method', async () => {
  const p = portal();
  p.app.state.fin.Kevin = { judge: 'Kevin', mode: 'rank', order: [...ids], tiers: { 6: 'S' } };
  p.app.renderFinal();
  p.card(6).querySelector('[data-fn]').oninput({ target: { value: 'Typed just before switching' } });
  assert.equal(JSON.parse(p.storage.get('sitroom-judging-v2')).fin.Kevin.notes[6], 'Typed just before switching');
  p.card(6).querySelector('[data-dn]').onclick();
  p.mode('tiers');
  p.runTimers();
  await p.settle();
  assert.equal(p.app.state.fin.Kevin.mode, 'tiers');
  assert.deepEqual(clone(p.app.state.fin.Kevin.order), [8, 6, 35]);
  assert.equal(p.saves.at(-1).fin_note[6], 'Typed just before switching');
  assert.equal(p.saves.at(-1).mode, 'tiers');
  assert.deepEqual(p.saves.at(-1).order, [8, 6, 35]);
});

test('pull does not overwrite an unsent note with the older remote ballot', async () => {
  const p = portal();
  p.app.state.fin.Kevin = { judge: 'Kevin', mode: 'tiers', tiers: { 6: 'A' } };
  p.app.renderFinal();
  p.card(6).querySelector('[data-fn]').oninput({ target: { value: 'Newest note' } });
  p.setRows([{ round: 'final', judge: 'Kevin', mode: 'rank', order: ids, fin_note: { 6: 'Stale note' } }]);
  await p.app.pull();
  await p.settle();
  assert.equal(p.app.state.fin.Kevin.mode, 'tiers');
  assert.equal(p.app.state.fin.Kevin.notes[6], 'Newest note');
  assert.equal(p.saves.at(-1).fin_note[6], 'Newest note');
});

test('mixed results count complete active ballots only and retain incomplete feedback', () => {
  const p = portal();
  p.app.state.fin = {
    Kevin: { judge: 'Kevin', order: [8, 6, 35], notes: { 6: 'Rank note' } },
    Florian: { judge: 'Florian', mode: 'tiers', order: [35, 6, 8], tiers: { 6: 'S', 8: 'S', 35: 'B' }, notes: { 6: 'Tier note' } },
    Neeraj: { judge: 'Neeraj', mode: 'tiers', tiers: { 6: 'A' }, notes: { 6: 'Incomplete note' } },
    John: { judge: 'John', order: [35] },
    Jordan: { judge: 'Jordan', order: [6, 8, 35] }
  };
  const result = p.app.renderFinalResults();
  assert.match(result, /2 of 4 reviews complete · 1 ranking · 1 tier review/);
  const rows = [...result.matchAll(/<tr><td><b>([\s\S]*?)<\/tr>/g)].map(m => m[0]);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Foxhole Forecast/);
  assert.match(rows[0], /<td class="n">3<\/td><td class="n">1<\/td>/);
  assert.match(rows[1], /StratEval/);
  assert.match(rows[1], /<td class="n">2<\/td><td class="n">0<\/td>/);
  assert.match(rows[1], /S: 1 · A: 0 · B: 0/);
  assert.match(rows[1], /Neeraj: A tier \(incomplete\)/);
  for (const note of ['Rank note', 'Tier note', 'Incomplete note']) assert.ok(rows[1].includes(note));
  assert.match(rows[2], /John: #1 \(incomplete\)/);
  assert.match(rows[2], /Neeraj: Unassigned \(incomplete\)/);
  assert.doesNotMatch(result, /Jordan:/);
});

test('judges see only their own final feedback in both methods while organizers retain all final feedback', async () => {
  for (const mode of ['rank', 'tiers']) {
    const p = portal();
    const roundOne = {
      works: 'Other judge round-one strengths', improve: 'Other judge round-one improvements',
      next: 'Other judge round-one next steps', note: 'Other judge private round-one note'
    };
    const ownFeedback = 'My existing feedback for the submitter';
    const otherFeedback = 'Other judge final feedback for the submitter';
    p.setRows([
      { round: 'r1', judge: 'Florian', sub: 6, cat: 1, ...roundOne },
      { round: 'final', judge: 'Kevin', mode, order: ids, tiers: { 6: 'S', 8: 'A', 35: 'B' }, fin_note: { 6: ownFeedback } },
      { round: 'final', judge: 'Florian', mode: 'rank', order: ids, fin_note: { 6: otherFeedback } }
    ]);
    await p.app.pull();
    p.app.renderFinal();
    assert.ok(p.final.innerHTML.includes(ownFeedback));
    for (const feedback of [...Object.values(roundOne), otherFeedback]) {
      assert.equal(p.final.innerHTML.includes(feedback), false, `${mode} must hide ${feedback}`);
    }
    assert.doesNotMatch(p.final.innerHTML, /Round one notes from the board|Florian · Top-5 potential/);

    const editedFeedback = 'My updated feedback for the submitter';
    p.card(6).querySelector('[data-fn]').oninput({ target: { value: editedFeedback } });
    p.runTimers();
    await p.settle();
    p.app.renderFinal();
    assert.ok(p.final.innerHTML.includes(editedFeedback));
    assert.equal(p.saves.at(-1).fin_note[6], editedFeedback);
    const results = p.app.renderFinalResults();
    assert.ok(results.includes(editedFeedback));
    assert.ok(results.includes(otherFeedback));
    assert.equal(p.app.state.r1.Florian__6.note, roundOne.note);
  }
});

test('adding a finalist makes old ballots incomplete and the new tier unassigned', () => {
  const p = portal();
  p.app.state.fin.Kevin = { judge: 'Kevin', mode: 'tiers', tiers: { 6: 'S', 8: 'A', 35: 'B' } };
  p.app.state.fin.Florian = { judge: 'Florian', order: [...ids] };
  assert.equal(p.app.finalComplete(p.app.state.fin.Kevin, ids), true);
  p.app.state.finalists.push(3);
  p.app.renderFinal();
  assert.match(p.final.innerHTML, /3 of 4 finalists assigned/);
  assert.equal(p.app.state.fin.Kevin.tiers[3], undefined);
  assert.equal(p.app.finalComplete(p.app.state.fin.Florian, p.app.state.finalists), false);
  assert.match(p.app.renderFinalResults(), /0 of 4 reviews complete · 0 rankings · 0 tier reviews/);
  p.app.state.finalists = [...ids];
  assert.equal(p.app.finalComplete(p.app.state.fin.Kevin, ids), true);
  assert.equal(p.app.finalComplete(p.app.state.fin.Florian, ids), true);
});

test('a displayed default ranking counts only after the judge records it', async () => {
  const p = portal();
  p.app.renderFinal();
  assert.match(p.final.innerHTML, /Current order has not been recorded for all finalists/);
  assert.match(p.app.renderFinalResults(), /0 of 4 reviews complete/);
  p.final.querySelector('[data-save-rank]').onclick();
  await p.settle();
  assert.deepEqual(p.saves.at(-1).order, ids);
  assert.match(p.final.innerHTML, /Ranking recorded for all finalists/);
  assert.match(p.app.renderFinalResults(), /1 of 4 reviews complete · 1 ranking · 0 tier reviews/);
});

test('removed finalists do not affect ranking points or displayed ranks', () => {
  const p = portal();
  p.app.state.finalists = [6, 35];
  p.app.state.fin.Kevin = { judge: 'Kevin', order: [8, 35, 6] };
  const result = p.app.renderFinalResults();
  const rows = [...result.matchAll(/<tr><td><b>([\s\S]*?)<\/tr>/g)].map(m => m[0]);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /AIDE/);
  assert.match(rows[0], /<td class="n">2<\/td><td class="n">1<\/td>/);
  assert.match(rows[0], /Kevin: #1/);
  assert.match(rows[1], /Kevin: #2/);
  assert.doesNotMatch(result, /Foxhole Forecast/);
});
