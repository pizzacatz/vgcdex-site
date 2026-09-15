/* VGC Dex — prototype search engine + UI (throwaway; the real engine is packages/search-core).
   Implements a working subset of docs/QUERY_SYNTAX.md against the champions-logic JSON. */
(() => {
'use strict';

// ---------- helpers ----------
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = s => norm(s).replace(/ /g, '');
const KIND_RANK = { species: 400, move: 300, ability: 200, item: 100 };
const KINDS = ['species', 'move', 'ability', 'item'];
const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- index ----------
let IDX = null; let IDX_ITEM_CATS = [];
function buildIndex(d) {
  const types = d.types;
  const chart = d.type_chart; // chart[attacking][defending]
  const effOf = ts => { const e = {}; for (const a of types) { let m = 1; for (const t of ts) m *= chart[a][t]; e[a] = m; } return e; };
  const speciesBySlug = {};
  const ents = [];
  for (const s of d.species) {
    const row = { kind: 'species', slug: s.slug, name: s.name, raw: s, is_mega: false, types: s.types,
      abilities: s.abilities.map(a => a.name), abilitySlugs: s.abilities.map(a => a.slug), learnset: s.learnset || [],
      ps: s.presented_stats, bs: s.base_stats, bst: STATS.reduce((n, k) => n + s.base_stats[k], 0),
      dex: s.national_dex, kg: s.weight_kg, sprite: s.sprites && s.sprites.menu, eff: effOf(s.types) };
    speciesBySlug[s.slug] = row; ents.push(row);
  }
  for (const m of d.mega_evolutions) {
    const base = speciesBySlug[m.base_slug];
    ents.push({ kind: 'species', slug: m.slug, name: m.name, raw: m, is_mega: true, base_slug: m.base_slug, stone: m.mega_stone,
      types: m.types, abilities: [m.ability.name], abilitySlugs: [m.ability.slug], learnset: base ? base.learnset : [],
      ps: m.presented_stats, bs: m.base_stats, bst: STATS.reduce((n, k) => n + m.base_stats[k], 0),
      dex: base ? base.dex : null, kg: m.weight_kg, sprite: m.sprites && m.sprites.menu, eff: effOf(m.types) });
  }
  const moveBySlug = {};
  for (const m of d.moves) { const r = { kind: 'move', slug: m.slug, name: m.name, raw: m, type: m.type, cat: m.category, bp: m.power || 0,
    acc: m.accuracy === true || m.accuracy == null ? null : m.accuracy, pp: m.pp, prio: m.priority, target: m.target, flags: m.flags || [],
    classes: m.classifications || [], variable: !!m.variable_power, text: (m.short_desc || '') + ' ' + (m.long_desc || '') }; moveBySlug[m.slug] = r; ents.push(r); }
  for (const a of d.abilities) ents.push({ kind: 'ability', slug: a.slug, name: a.name, raw: a, text: (a.short_desc || '') + ' ' + (a.long_desc || '') });
  for (const i of d.items) ents.push({ kind: 'item', slug: i.slug, name: i.name, raw: i, cats: i.categories || [], sprite: i.sprites && i.sprites.item,
    text: (i.description || '') + ' ' + (i.short_desc || '') + ' ' + (i.long_desc || '') });
  // inverse learnset + name aliases
  const learnedBy = {};
  for (const e of ents) if (e.kind === 'species') for (const mv of e.learnset) (learnedBy[mv] ||= []).push(e);
  for (const e of ents) {
    e.norm = norm(e.name); e.compact = compact(e.name);
    e.aliases = [e.norm, compact(e.slug), norm(e.raw.showdown_id || '')].filter(Boolean);
    if (e.is_mega) { const b = e.name.replace(/-Mega(-[XYZ])?$/, (_, v) => ''); const v = (e.name.match(/-Mega-([XYZ])$/) || [])[1];
      e.aliases.push(norm('mega ' + b + (v ? ' ' + v : ''))); }
    if (e.kind === 'move' || e.kind === 'ability') e.textNorm = e.text.toLowerCase();
    if (e.kind === 'item') e.textNorm = e.text.toLowerCase();
  }
  // item categories for the cat: enum
  const itemCats = new Set(d.item_categories.map(compact));
  return { ents, types, learnedBy, moveBySlug, speciesBySlug, itemCats, meta: { regulation: d.regulation, data_revision: d.data_revision, data_version: d.data_version } };
}

// ---------- field registry ----------
// type: enum | text | num | flag ; kinds: which entity kinds the field applies to
const F = {};
function def(names, kinds, type, get, extra) { const f = Object.assign({ name: names[0], kinds, type, get }, extra || {}); for (const n of names) F[n] = f; }
def(['t', 'type'], ['species', 'move'], 'enum', e => e.kind === 'species' ? e.types : [e.type], { values: 'types' });
def(['a', 'ability'], ['species'], 'text', e => e.abilities);
def(['m', 'move', 'learns'], ['species'], 'text', (e, idx) => e.learnset.map(s => idx.moveBySlug[s] ? idx.moveBySlug[s].name : s));
for (const k of STATS) { def([k, k === 'spe' ? 'speed' : k === 'atk' ? 'attack' : k === 'def' ? 'defense' : k], ['species'], 'num', e => e.ps[k]); def(['b' + k], ['species'], 'num', e => e.bs[k]); }
def(['bst'], ['species'], 'num', e => e.bst);
def(['dex', 'nat'], ['species'], 'num', e => e.dex);
def(['kg', 'weight'], ['species'], 'num', e => e.kg);
def(['weak'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] >= 2 });
def(['resists', 'resist'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] > 0 && e.eff[v] <= 0.5 });
def(['immune'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] === 0 });
def(['stone', 'megastone'], ['species'], 'text', e => e.stone ? [e.stone] : []);
def(['base'], ['species'], 'text', e => e.base_slug ? [e.base_slug] : []);
def(['abilities'], ['species'], 'num', e => e.abilities.length);
def(['cat', 'c', 'category'], ['move', 'item'], 'enum', e => e.kind === 'move' ? [e.cat] : e.cats.map(norm), { values: 'cat' });
def(['bp', 'pow', 'power'], ['move'], 'num', e => e.bp);
def(['acc', 'accuracy'], ['move'], 'num', e => e.acc == null ? Infinity : e.acc);
def(['pp'], ['move'], 'num', e => e.pp);
def(['prio', 'priority'], ['move'], 'num', e => e.prio);
def(['target'], ['move'], 'enum', e => [e.target.toLowerCase(), ...(e.target === 'allAdjacentFoes' || e.target === 'allAdjacent' ? ['spread'] : []), ...(e.target === 'normal' || e.target === 'any' ? ['single'] : [])], { values: 'free' });
def(['flag', 'f'], ['move'], 'enum', e => e.flags, { values: 'free' });
def(['class', 'cl', 'classification'], ['move'], 'text', e => e.classes);
def(['lb', 'learnedby', 'usedby'], ['move'], 'text', (e, idx) => (idx.learnedBy[e.slug] || []).map(s => s.name));
def(['for'], ['item'], 'text', (e, idx) => Object.values(idx.speciesBySlug).filter(s => false).map(s => s.name), { forStone: true });
def(['o', 'desc', 'text'], ['move', 'ability', 'item'], 'text', e => [e.text]);
def(['name', 'n'], KINDS, 'text', e => [e.name]);
def(['kind'], KINDS, 'kindsel');
def(['is'], KINDS, 'is');
def(['order', 'sort'], KINDS, 'directive'); def(['dir', 'direction'], KINDS, 'directive');
const IS_VALUES = { species: 'kind', move: 'kind', ability: 'kind', item: 'kind', mega: 1, spread: 1, variable: 1, consumable: 1, held: 1 };

// ---------- tokenizer / parser ----------
class QueryError extends Error { constructor(kind, msg, span) { super(msg); this.kind = kind; this.span = span; } }
const OPS = ['!=', '<=', '>=', ':', '=', '<', '>'];
function tokenize(src) {
  const toks = []; let i = 0; const n = src.length;
  const isWs = c => /\s/.test(c);
  while (i < n) {
    const c = src[i];
    if (isWs(c)) { i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c, s: i, e: i + 1 }); i++; continue; }
    if (c === '-' && i + 1 < n && !isWs(src[i + 1]) && src[i + 1] !== ')') { toks.push({ t: 'not', s: i, e: i + 1 }); i++; continue; }
    const start = i;
    if (c === '"') { const j = src.indexOf('"', i + 1); if (j < 0) throw new QueryError('syntax', 'Unclosed quote', [i, n]); toks.push({ t: 'word', v: src.slice(i + 1, j), quoted: true, s: i, e: j + 1 }); i = j + 1; continue; }
    // field?
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
    if (m) {
      const fname = m[0]; let j = i + fname.length;
      const op = OPS.find(o => src.startsWith(o, j));
      if (op) {
        j += op.length; let val, isRegex = false, quoted = false;
        if (src[j] === '"') { const k = src.indexOf('"', j + 1); if (k < 0) throw new QueryError('syntax', 'Unclosed quote', [j, n]); val = src.slice(j + 1, k); quoted = true; j = k + 1; }
        else if (src[j] === '/') { let k = j + 1; while (k < n && !(src[k] === '/' && src[k - 1] !== '\\')) k++; if (k >= n) throw new QueryError('syntax', 'Unclosed regex: missing closing /', [j, n]); val = src.slice(j + 1, k); isRegex = true; j = k + 1; }
        else { let k = j; while (k < n && !isWs(src[k]) && src[k] !== ')' && src[k] !== '(') k++; val = src.slice(j, k); j = k; }
        if (val === '') throw new QueryError('syntax', `Field "${fname}" has no value`, [start, j]);
        toks.push({ t: 'term', field: fname.toLowerCase(), op, val, isRegex, quoted, s: start, e: j }); i = j; continue;
      }
    }
    let k = i; while (k < n && !isWs(src[k]) && src[k] !== ')' && src[k] !== '(') k++;
    const w = src.slice(i, k);
    if (w.toLowerCase() === 'or') toks.push({ t: 'or', s: i, e: k }); else toks.push({ t: 'word', v: w, s: i, e: k });
    i = k;
  }
  return toks;
}
// AST: {type:'and',items}|{type:'or',items}|{type:'not',node}|{type:'term',...}|{type:'word',v}
function parse(src) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  function expr() { const items = [andExpr()]; while (peek() && peek().t === 'or') { next(); items.push(andExpr()); } return items.length === 1 ? items[0] : { type: 'or', items }; }
  function andExpr() { const items = []; while (peek() && peek().t !== 'or' && peek().t !== ')') items.push(unary()); if (!items.length) throw new QueryError('syntax', 'Expected a term', peek() ? [peek().s, peek().e] : [src.length, src.length]); return items.length === 1 ? items[0] : { type: 'and', items }; }
  function unary() { if (peek().t === 'not') { const tk = next(); if (!peek() || peek().t === ')' || peek().t === 'or') throw new QueryError('syntax', 'Nothing after "-"', [tk.s, tk.e]); return { type: 'not', node: unary() }; } return primary(); }
  function primary() { const tk = next();
    if (tk.t === '(') { const e = expr(); if (!peek() || peek().t !== ')') throw new QueryError('syntax', 'Missing closing ")"', [tk.s, tk.e]); next(); return e; }
    if (tk.t === ')') throw new QueryError('syntax', 'Unexpected ")"', [tk.s, tk.e]);
    if (tk.t === 'word') return { type: 'word', v: tk.v, span: [tk.s, tk.e] };
    if (tk.t === 'term') return { type: 'term', ...tk, span: [tk.s, tk.e] };
    throw new QueryError('syntax', 'Unexpected token', [tk.s, tk.e]); }
  if (!toks.length) return null;
  const ast = expr();
  if (p < toks.length) throw new QueryError('syntax', toks[p].t === ')' ? 'Unexpected ")"' : 'Unexpected input', [toks[p].s, toks[p].e]);
  return ast;
}

// ---------- validation + scope ----------
const REGEX_BAD = [[/\(\?[=!<]/, 'lookahead/lookbehind'], [/\\[1-9]/, 'backreferences'], [/\(\?P?</, 'named groups'], [/\(\?[a-z]+[:)]/i, 'inline flags'], [/\\[pP]\{/, 'Unicode property escapes']];
function compileRegex(pat, span) { for (const [re, what] of REGEX_BAD) if (re.test(pat)) throw new QueryError('syntax', `Regex uses ${what}, which is outside the portable subset`, span); try { return new RegExp(pat, 'i'); } catch (e) { throw new QueryError('syntax', 'Invalid regex: ' + e.message.replace(/^Invalid regular expression: /, ''), span); } }
function validate(node, idx, directives) {
  // returns scope (Set of kinds) and annotates terms
  if (node.type === 'word') { if (!norm(node.v)) throw new QueryError('syntax', `"${node.v}" has no letters or digits to search for`, node.span); return new Set(KINDS); }
  if (node.type === 'not') return validate(node.node, idx, directives);
  if (node.type === 'and') { let sc = new Set(KINDS); const per = [];
    for (const it of node.items) { const s = validate(it, idx, directives); if (it.type === 'term' && F[it.field] && F[it.field].type === 'directive') continue; per.push([it, s]); sc = new Set([...sc].filter(k => s.has(k))); }
    if (!sc.size) { const named = per.filter(([it, s]) => s.size < KINDS.length).map(([it, s]) => `"${it.field || it.v}" (${[...s].join('/')})`); throw new QueryError('semantic', `These terms can't apply to the same kind of result: ${named.join(', ')}`, node.items[0].span); }
    return sc; }
  if (node.type === 'or') { let sc = new Set(); for (const it of node.items) for (const k of validate(it, idx, directives)) sc.add(k); return sc; }
  // term
  const f = F[node.field];
  if (!f) throw new QueryError('syntax', `Unknown field "${node.field}"`, node.span);
  const v = node.val; const vn = norm(v);
  if (f.type === 'directive') { if (node.isRegex || node.op !== ':') throw new QueryError('syntax', `${f.name}: takes a plain value`, node.span); directives[f.name] = vn; return new Set(KINDS); }
  if (node.isRegex && f.type !== 'text') throw new QueryError('syntax', `Regex is only allowed on text fields, not "${node.field}"`, node.span);
  if (f.type === 'num') { if (node.op === ':') node.op = '='; const num = Number(v); if (!Number.isFinite(num)) throw new QueryError('syntax', `"${node.field}" needs a number, got "${v}"`, node.span); node.num = num; return new Set(f.kinds); }
  if (node.op !== ':' && node.op !== '=' && node.op !== '!=') throw new QueryError('syntax', `"${node.field}" doesn't support ${node.op}`, node.span);
  if (f.type === 'kindsel') { if (!KINDS.includes(vn)) throw new QueryError('syntax', `kind: must be one of ${KINDS.join(', ')}`, node.span); node.kindsel = vn; return new Set([vn]); }
  if (f.type === 'is') { if (!IS_VALUES[vn]) throw new QueryError('syntax', `is: must be one of ${Object.keys(IS_VALUES).join(', ')}`, node.span); node.isv = vn;
    if (IS_VALUES[vn] === 'kind') return new Set([vn]); if (vn === 'mega') return new Set(['species']); if (vn === 'spread' || vn === 'variable') return new Set(['move']); return new Set(['item']); }
  if (f.type === 'enum') {
    if (f.values === 'types') { if (!idx.types.includes(vn)) throw new QueryError('syntax', `Unknown type "${v}"`, node.span); node.vn = vn; return new Set(f.kinds); }
    if (f.values === 'cat') { const vc = vn.replace(/ /g, ''); const isMove = ['physical', 'special', 'status'].includes(vn); const isItem = idx.itemCats.has(vc); if (!isMove && !isItem) throw new QueryError('syntax', `Unknown category "${v}" (move: physical/special/status; item: ${IDX_ITEM_CATS.join(', ')})`, node.span); node.vn = vc; return new Set([isMove ? 'move' : 'item']); }
    node.vn = vn.replace(/ /g, ''); return new Set(f.kinds); }
  if (f.type === 'text') { if (node.isRegex) node.re = compileRegex(v, node.span); else { node.vn = vn; node.vc = compact(v); } return new Set(f.kinds); }
  return new Set(f.kinds);
}

// ---------- evaluation ----------
function textHit(node, vals) { if (node.re) return vals.some(x => node.re.test(x)); if (node.op === '=' ) return vals.some(x => norm(x) === node.vn || compact(x) === node.vc); if (node.op === '!=') return !vals.some(x => norm(x) === node.vn); return vals.some(x => norm(x).includes(node.vn) || compact(x).includes(node.vc)); }
function evalNode(node, e, idx) {
  switch (node.type) {
    case 'and': return node.items.every(it => evalNode(it, e, idx));
    case 'or': return node.items.some(it => evalNode(it, e, idx));
    case 'not': return !evalNode(node.node, e, idx);
    case 'word': { const w = norm(node.v), wc = compact(node.v); return e.aliases.some(a => a.includes(w)) || e.compact.includes(wc); }
    case 'term': {
      const f = F[node.field]; if (f.type === 'directive') return true;
      if (!f.kinds.includes(e.kind)) return false;
      if (f.type === 'kindsel') return e.kind === node.kindsel;
      if (f.type === 'is') { const v = node.isv; if (IS_VALUES[v] === 'kind') return e.kind === v; if (v === 'mega') return !!e.is_mega; if (v === 'spread') return e.target === 'allAdjacentFoes' || e.target === 'allAdjacent'; if (v === 'variable') return !!e.variable; if (v === 'consumable') return e.cats.map(norm).includes('consumable'); if (v === 'held') return e.cats.map(norm).includes('held'); return false; }
      if (f.type === 'num') { const x = f.get(e, idx); if (x == null) return false; const y = node.num; switch (node.op) { case '=': return x === y; case '!=': return x !== y; case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y; } return false; }
      if (f.type === 'enum') { if (f.test) { const r = f.test(e, node.vn); return node.op === '!=' ? !r : r; } const vals = f.get(e, idx).map(x => norm(x).replace(/ /g, '')); const r = vals.includes(node.vn); return node.op === '!=' ? !r : r; }
      if (f.type === 'text') { if (f.forStone) { const m = e.raw.short_desc || ''; const r = new RegExp('held by an? ' + node.vn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(m) || norm(e.name).includes(node.vn); return node.op === '!=' ? !r : r; } return textHit(node, f.get(e, idx)); }
      return false; }
  }
  return false;
}
function nameScore(ast, e) { // relevance for bare words: 3 exact, 2 prefix, 1 contains, 0 none
  const words = []; (function walk(n) { if (!n) return; if (n.type === 'word') words.push(n); else if (n.items) n.items.forEach(walk); else if (n.node) walk(n.node); })(ast);
  let best = 0; for (const w of words) { const v = norm(w.v), vc = compact(w.v); if (e.norm === v || e.compact === vc) best = Math.max(best, 3); else if (e.norm.startsWith(v) || e.compact.startsWith(vc)) best = Math.max(best, 2); else if (e.norm.includes(v) || e.compact.includes(vc)) best = Math.max(best, 1); }
  return best;
}
const ORDER_KEYS = { name: e => e.name, dex: e => e.dex ?? 9999, bst: e => e.bst, bp: e => e.bp, pp: e => e.pp, acc: e => e.acc ?? 101, prio: e => e.prio, kg: e => e.kg };
for (const k of STATS) { ORDER_KEYS[k] = e => e.ps ? e.ps[k] : undefined; ORDER_KEYS['b' + k] = e => e.bs ? e.bs[k] : undefined; }
function search(idx, q) {
  const ast = parse(q); if (!ast) return { scope: KINDS, results: [], ast: null };
  const directives = {}; const scope = validate(ast, idx, directives);
  const out = []; for (const e of idx.ents) if (scope.has(e.kind) && evalNode(ast, e, idx)) out.push(e);
  const order = directives.order; let dir = directives.dir;
  if (order) { const key = ORDER_KEYS[order]; if (!key) throw new QueryError('syntax', `order: must be one of ${Object.keys(ORDER_KEYS).join(', ')}`, [0, q.length]);
    const numeric = order !== 'name'; dir = dir || (numeric ? 'desc' : 'asc'); const sgn = dir === 'asc' ? 1 : -1;
    out.sort((a, b) => { const x = key(a), y = key(b); if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : x > y ? 1 : 0) * sgn || a.name.localeCompare(b.name); }); }
  else out.sort((a, b) => (KIND_RANK[b.kind] - KIND_RANK[a.kind]) || (nameScore(ast, b) - nameScore(ast, a)) || (b.kind === 'species' && a.kind === 'species' ? (a.is_mega - b.is_mega) : 0) || a.name.localeCompare(b.name));
  return { scope: [...scope], results: out, ast, order, dir };
}

// ---------- UI ----------
const $ = s => document.querySelector(s);
const qEl = $('#q'), statusEl = $('#status'), resEl = $('#results');
let openSlug = null;
function typeChip(t) { return `<span class="chip type-${t}">${t}</span>`; }
function link(q) { return `?q=${encodeURIComponent(q)}`; }
function row(e) {
  let thumb, sub = '', chips = '', stats = '', badge = '';
  if (e.kind === 'species') { thumb = e.sprite ? `<img src="${e.sprite}" alt="" loading="lazy">` : `<span class="letter">${e.name[0]}</span>`; chips = e.types.map(typeChip).join('') + e.abilities.map(a => `<span class="chip neutral">${esc(a)}</span>`).join('');
    stats = STATS.map(k => `${k.toUpperCase()} ${e.ps[k]}`).join(' · '); if (e.is_mega) badge = '<span class="badge">Mega</span>'; sub = `#${e.dex ?? '—'} · BST ${e.bst}`; }
  else if (e.kind === 'move') { thumb = `<span class="letter">M</span>`; chips = typeChip(e.type) + `<span class="chip cat-${e.cat}">${e.cat}</span>` + e.classes.map(c => `<span class="chip neutral">${esc(c)}</span>`).join(''); sub = esc(e.raw.short_desc || ''); stats = `BP ${e.bp || '—'} · Acc ${e.acc ?? '—'} · PP ${e.pp} · Prio ${e.prio}`; }
  else if (e.kind === 'ability') { thumb = `<span class="letter">A</span>`; sub = esc(e.raw.short_desc || ''); }
  else { thumb = e.sprite ? `<img src="${e.sprite}" alt="" loading="lazy">` : `<span class="letter">I</span>`; chips = e.cats.map(c => `<span class="chip neutral">${esc(c)}</span>`).join(''); sub = esc(e.raw.short_desc || e.raw.description || ''); }
  const open = openSlug === e.kind + ':' + e.slug;
  return `<div class="row${open ? ' open' : ''}" data-key="${e.kind}:${e.slug}"><div class="thumb">${thumb}</div><div><div class="name">${esc(e.name)}${badge}</div>${chips ? `<div class="chips">${chips}</div>` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="stats">${stats}</div></div>${open ? detail(e) : ''}`;
}
function detail(e) {
  const idx = IDX;
  if (e.kind === 'species') {
    const tbl = `<table><tr><th></th>${STATS.map(k => `<th>${k.toUpperCase()}</th>`).join('')}<th>Total</th></tr><tr><th>Presented</th>${STATS.map(k => `<td>${e.ps[k]}</td>`).join('')}<td>${STATS.reduce((n, k) => n + e.ps[k], 0)}</td></tr><tr><th>Base</th>${STATS.map(k => `<td>${e.bs[k]}</td>`).join('')}<td>${e.bst}</td></tr></table>`;
    const weak = idx.types.filter(t => e.eff[t] >= 2), res = idx.types.filter(t => e.eff[t] > 0 && e.eff[t] < 1), imm = idx.types.filter(t => e.eff[t] === 0);
    const moves = e.learnset.map(s => idx.moveBySlug[s]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(m => `<a href="${link('name=' + JSON.stringify(m.name))}">${esc(m.name)}</a>`).join('');
    const megas = idx.ents.filter(x => x.is_mega && x.base_slug === e.slug).map(x => `<a href="${link('name=' + JSON.stringify(x.name))}">${esc(x.name)}</a>`).join(' · ');
    return `<div class="detail">${tbl}<p><b>Abilities:</b> ${e.abilities.map(a => `<a href="${link('a:' + JSON.stringify(a))}">${esc(a)}</a>`).join(', ')}${e.stone ? ` · <b>Stone:</b> ${esc(e.stone)}` : ''}${e.base_slug ? ` · <b>Base:</b> <a href="${link('name=' + e.base_slug)}">${esc(idx.speciesBySlug[e.base_slug]?.name || e.base_slug)}</a>` : ''}${megas ? ` · <b>Megas:</b> ${megas}` : ''}</p>
      <p><b>Weak:</b> ${weak.map(t => typeChip(t) + (e.eff[t] === 4 ? '<small>×4</small>' : '')).join(' ') || '—'} &nbsp; <b>Resists:</b> ${res.map(t => typeChip(t) + (e.eff[t] === 0.25 ? '<small>×¼</small>' : '')).join(' ') || '—'} &nbsp; <b>Immune:</b> ${imm.map(typeChip).join(' ') || '—'} <small>(type chart only)</small></p>
      <p><b>Learnset (${e.learnset.length}):</b></p><div class="moves">${moves}</div>
      <p><small>Find species that learn a move: click it, then change <code>name=</code> to <code>m:</code>. Weight ${e.kg} kg.</small></p></div>`;
  }
  if (e.kind === 'move') { const lb = (idx.learnedBy[e.slug] || []).filter(s => !s.is_mega); return `<div class="detail"><p>${esc(e.raw.long_desc || e.raw.short_desc || '')}</p><p><b>Target:</b> ${esc(e.target)} · <b>Flags:</b> ${e.flags.map(f => `<a href="${link('flag:' + f)}">${f}</a>`).join(', ') || '—'}${e.variable ? ' · variable power' : ''}</p><p><b>Learned by (${lb.length}):</b> <a href="${link('m=' + JSON.stringify(e.name))}">show as species search</a></p><div class="moves">${lb.map(s => `<a href="${link('name=' + JSON.stringify(s.name))}">${esc(s.name)}</a>`).join('')}</div></div>`; }
  if (e.kind === 'ability') { const holders = idx.ents.filter(x => x.kind === 'species' && x.abilitySlugs.includes(e.slug)); return `<div class="detail"><p>${esc(e.raw.long_desc || '')}</p><p><b>Species with it (${holders.length}):</b> <a href="${link('a=' + JSON.stringify(e.name))}">show as species search</a></p><div class="moves">${holders.map(s => `<a href="${link('name=' + JSON.stringify(s.name))}">${esc(s.name)}</a>`).join('')}</div></div>`; }
  return `<div class="detail"><p>${esc(e.raw.long_desc || e.raw.description || '')}</p><p><b>Categories:</b> ${e.cats.map(c => `<a href="${link('cat:' + JSON.stringify(c))}">${esc(c)}</a>`).join(', ')}</p></div>`;
}
function render(q) {
  qEl.value = q; statusEl.className = ''; resEl.innerHTML = '';
  if (!q.trim()) { statusEl.textContent = 'Type a query — or click an example on the right.'; return; }
  let r;
  try { r = search(IDX, q); }
  catch (err) { if (!(err instanceof QueryError)) throw err; statusEl.className = 'err'; statusEl.textContent = (err.kind === 'syntax' ? 'Syntax error' : 'Scope error');
    const [s, e] = err.span || [0, 0]; const marked = esc(q.slice(0, s)) + '<mark>' + esc(q.slice(s, e) || ' ') + '</mark>' + esc(q.slice(e));
    resEl.innerHTML = `<div class="errbox"><b>${err.kind === 'syntax' ? 'Syntax error' : 'Semantic error'}:</b> ${esc(err.message)}<br><code>${marked}</code>${err.kind === 'semantic' ? '<br><small>Add <code>kind:species</code> or <code>kind:move</code>, or split into two searches.</small>' : ''}</div>`; return; }
  const scopeTxt = r.scope.length === 4 ? 'all kinds' : r.scope.join(' + ');
  statusEl.textContent = `${r.results.length} result${r.results.length === 1 ? '' : 's'} · scope: ${scopeTxt}${r.order ? ` · order: ${r.order} ${r.dir}` : ''}`;
  if (!r.results.length) { resEl.innerHTML = `<div class="zero"><b>No matches.</b> The query parsed fine and was searched across <b>${scopeTxt}</b>. Tips: bare words match names only (use <code>o:</code> for descriptions); stats are presented values (<code>bspe</code> for base); <code>m:</code> needs the move name, e.g. <code>m:"iron head"</code>.</div>`; return; }
  const groups = {}; for (const e of r.results) (groups[e.kind] ||= []).push(e);
  const kinds = r.order ? [null] : KINDS;
  let html = '';
  if (r.order) html = r.results.slice(0, 300).map(row).join('');
  else for (const k of KINDS) if (groups[k]) html += `<div class="group"><h2>${k === 'species' ? 'Pokémon' : k === 'move' ? 'Moves' : k === 'ability' ? 'Abilities' : 'Items'} · ${groups[k].length}</h2>${groups[k].slice(0, 200).map(row).join('')}${groups[k].length > 200 ? `<p class="sub">…${groups[k].length - 200} more (narrow the query)</p>` : ''}</div>`;
  resEl.innerHTML = html;
}
function go(q, push = true) { if (push) history.pushState(null, '', q ? link(q) : location.pathname); render(q); }
$('#form').addEventListener('submit', ev => { ev.preventDefault(); openSlug = null; go(qEl.value); });
resEl.addEventListener('click', ev => { const a = ev.target.closest('a'); if (a && a.getAttribute('href')?.startsWith('?q=')) { ev.preventDefault(); openSlug = null; go(decodeURIComponent(a.getAttribute('href').slice(3))); return; }
  const r = ev.target.closest('.row'); if (!r) return; const key = r.dataset.key; openSlug = openSlug === key ? null : key; render(qEl.value); });
document.addEventListener('click', ev => { const a = ev.target.closest('aside a.ex'); if (!a) return; ev.preventDefault(); openSlug = null; go(a.dataset.q); qEl.focus(); });
window.addEventListener('popstate', () => { openSlug = null; render(new URLSearchParams(location.search).get('q') || ''); });

const EXAMPLES = [
  ['t:steel spe>=100', 'fast Steel types (presented Speed)'], ['m:"iron head" m:"knock off"', 'learns both moves'], ['m:/^(u-turn|volt switch|flip turn)$/', 'any pivot move (regex)'],
  ['a:intimidate or a:prankster', 'either ability'], ['weak:fairy -resists:steel', 'Fairy-weak, no Steel resist'], ['immune:ground is:mega', 'Mega formes immune to Ground'],
  ['t:fire bp>=80 cat:special flag:protect', 'special Fire moves'], ['prio>0 -cat:status order:bp', 'damaging priority, by power'], ['o:/flinch/ kind:move', 'moves whose text says flinch'],
  ['o:/heals?|restores?/ kind:ability', 'healing abilities'], ['cat:berry o:/hp/', 'berries mentioning HP'], ['for:garchomp', 'Garchomp\'s Mega Stones'], ['lb:garchomp t:ground bp>=90', 'Ground moves Garchomp learns'],
  ['bst>=600 -is:mega order:spe', 'non-Mega 600 BST by Speed'], ['t:fire spe>100 bp>=80', 'scope error (on purpose)']];
function renderHelp() {
  $('#help').innerHTML = `<h3>Try</h3>${EXAMPLES.map(([q, why]) => `<a class="ex" href="${link(q)}" data-q="${esc(q)}">${esc(q)}<small>${esc(why)}</small></a>`).join('')}
  <h3>Syntax</h3><table>
  <tr><td>word</td><td>name match, all kinds</td></tr><tr><td>a b</td><td>AND</td></tr><tr><td>a or b</td><td>OR (lower precedence)</td></tr><tr><td>-a</td><td>NOT</td></tr><tr><td>( … )</td><td>group</td></tr><tr><td>"iron head"</td><td>quote spaces</td></tr><tr><td>o:/re/</td><td>regex (text fields)</td></tr>
  <tr><td>: = != &lt; &lt;= &gt; &gt;=</td><td>operators</td></tr></table>
  <h3>Pokémon</h3><table><tr><td>t: a: m:</td><td>type, ability, learns move</td></tr><tr><td>hp atk def spa spd spe</td><td>presented stats</td></tr><tr><td>bhp … bspe, bst</td><td>base stats, base total</td></tr><tr><td>weak: resists: immune:</td><td>type chart only</td></tr><tr><td>is:mega stone: base:</td><td>Mega formes</td></tr><tr><td>dex: kg: abilities:</td><td>number, weight, count</td></tr></table>
  <h3>Moves</h3><table><tr><td>t: cat: bp: acc: pp: prio:</td><td>type, physical/special/status, numbers</td></tr><tr><td>flag: target: class:</td><td>contact/sound/…, spread/single, Classification</td></tr><tr><td>lb:</td><td>learned by species</td></tr><tr><td>is:spread is:variable</td><td>flags</td></tr></table>
  <h3>Abilities · Items</h3><table><tr><td>o:</td><td>description text</td></tr><tr><td>cat:</td><td>item category (berry, mega stone, …)</td></tr><tr><td>for:</td><td>Mega Stone for a species</td></tr><tr><td>is:consumable is:held</td><td>item class</td></tr></table>
  <h3>Scope & sort</h3><table><tr><td>kind: is:</td><td>species / move / ability / item</td></tr><tr><td>order: dir:</td><td>spe, bp, name, dex, bst… asc/desc</td></tr></table>
  <p><small>Scope is the intersection of the kinds your fields apply to; if it's empty you get an error, not an empty list. Regulation history (<code>r:</code>, <code>new:</code>, <code>removed:</code>) is not in this prototype.</small></p>`;
}

window.VGCDEX = { search: q => search(IDX, q), parse, get idx() { return IDX; } };
fetch('data/m-c.json').then(r => r.json()).then(d => {
  IDX = buildIndex(d); IDX_ITEM_CATS = d.item_categories.slice();
  $('#reg').textContent = `Pokémon Champions · Regulation ${d.regulation.regulation}`;
  $('#foot').innerHTML = `Prototype · data: champions-logic ${esc(d.data_version)} · revision ${esc(d.data_revision)} · ${IDX.ents.length} entities · Pokémon and all related names are © Nintendo / Creatures / GAME FREAK; data via Pokémon Showdown (MIT) and Serebii; sprites via Bulbagarden Archives / Serebii. Fan project, not affiliated.`;
  renderHelp();
  render(new URLSearchParams(location.search).get('q') || '');
}).catch(err => { statusEl.className = 'err'; statusEl.textContent = 'Failed to load data: ' + err.message; });
})();
