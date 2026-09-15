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
      ps: s.presented_stats, total: STATS.reduce((n, k) => n + s.presented_stats[k], 0),
      dex: s.national_dex, kg: s.weight_kg, sprite: s.sprites && s.sprites.menu, art: s.sprites && s.sprites.front, eff: effOf(s.types) };
    speciesBySlug[s.slug] = row; ents.push(row);
  }
  for (const m of d.mega_evolutions) {
    const base = speciesBySlug[m.base_slug];
    ents.push({ kind: 'species', slug: m.slug, name: m.name, raw: m, is_mega: true, base_slug: m.base_slug, stone: m.mega_stone,
      types: m.types, abilities: [m.ability.name], abilitySlugs: [m.ability.slug], learnset: base ? base.learnset : [],
      ps: m.presented_stats, total: STATS.reduce((n, k) => n + m.presented_stats[k], 0),
      dex: base ? base.dex : null, kg: m.weight_kg, sprite: m.sprites && m.sprites.menu, art: m.sprites && m.sprites.front, eff: effOf(m.types) });
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
  const classes = [...new Set(d.moves.flatMap(m => m.classifications || []))].sort();
  return { ents, types, learnedBy, moveBySlug, speciesBySlug, itemCats, classes, meta: { regulation: d.regulation, data_revision: d.data_revision, data_version: d.data_version } };
}

// ---------- field registry ----------
// type: enum | text | num | flag ; kinds: which entity kinds the field applies to
const F = {};
function def(names, kinds, type, get, extra) { const f = Object.assign({ name: names[0], kinds, type, get }, extra || {}); for (const n of names) F[n] = f; }
def(['t', 'type'], ['species', 'move'], 'enum', e => e.kind === 'species' ? e.types : [e.type], { values: 'types' });
def(['a', 'ability'], ['species'], 'text', e => e.abilities);
def(['m', 'move', 'learns'], ['species'], 'text', (e, idx) => e.learnset.map(s => idx.moveBySlug[s] ? idx.moveBySlug[s].name : s));
for (const k of STATS) def([k, k === 'spe' ? 'speed' : k === 'atk' ? 'attack' : k === 'def' ? 'defense' : k], ['species'], 'num', e => e.ps[k]);
def(['total', 'stats'], ['species'], 'num', e => e.total);
def(['dex', 'nat'], ['species'], 'num', e => e.dex);
def(['kg', 'weight'], ['species'], 'num', e => e.kg);
def(['weak'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] >= 2 });
def(['xweak', 'extremelyweak'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] >= 4 });
def(['xresists', 'doublyresists'], ['species'], 'enum', null, { values: 'types', test: (e, v) => e.eff[v] > 0 && e.eff[v] <= 0.25 });
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
    if (!sc.size) { const named = per.filter(([it, s]) => s.size < KINDS.length).map(([it, s]) => `"${it.field || it.v}" (${[...s].join('/')})`); throw new QueryError('semantic', `These terms can't apply to the same kind of result: ${named.join(', ')}`, [node.items[0].span[0], node.items[node.items.length - 1].span[1]]); }
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
    if (f.values === 'types') {
      if (node.op === '=' && f.name === 't') { const list = v.toLowerCase().split(/[\/,+]/).map(x => x.trim()).filter(Boolean); for (const t of list) if (!idx.types.includes(t)) throw new QueryError('syntax', `Unknown type "${t}"`, node.span); if (!list.length || list.length > 2) throw new QueryError('syntax', 't= takes one or two types, e.g. t=steel/fairy', node.span); node.exact = list; return new Set(f.kinds); }
      if (!idx.types.includes(vn)) throw new QueryError('syntax', `Unknown type "${v}"`, node.span); node.vn = vn; return new Set(f.kinds); }
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
      if (f.type === 'enum' && node.exact) { const have = e.kind === 'species' ? e.types : [e.type]; return have.length === node.exact.length && node.exact.every(t => have.includes(t)); }
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
const ORDER_KEYS = { name: e => e.name, dex: e => e.dex ?? 9999, total: e => e.total, bp: e => e.bp, pp: e => e.pp, acc: e => e.acc ?? 101, prio: e => e.prio, kg: e => e.kg };
for (const k of STATS) ORDER_KEYS[k] = e => e.ps ? e.ps[k] : undefined;
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

// ---------- UI (Scryfall-style layout on GeorgiaPlayEvents tokens) ----------
const $ = s => document.querySelector(s);
const app = $('#app');
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const KIND_LABEL = { species: 'Pokémon', move: 'Moves', ability: 'Abilities', item: 'Items' };
const ICON = `<svg viewBox="0 0 1024 1024" aria-hidden="true"><clipPath id="r"><rect width="1024" height="1024" rx="180"/></clipPath><g clip-path="url(#r)"><rect width="1024" height="1024" fill="#1A110E"/><path d="M 0 0 L 1024 0 L 0 1024 Z" fill="#FFF8F6"/><line x1="0" y1="1024" x2="1024" y2="0" stroke="#FFDAD2" stroke-width="100"/></g><circle cx="512" cy="512" r="220" fill="#73332A" stroke="#FFDAD2" stroke-width="100"/></svg>`;
const typeChip = t => `<span class="chip type-${t}">${t}</span>`;
const catChip = c => `<span class="chip cat-${c}">${c}</span>`;
const qlink = q => `?q=${encodeURIComponent(q)}`;
const plink = e => `?${e.kind}=${encodeURIComponent(e.slug)}`;
const nameTerm = e => `name=${JSON.stringify(e.name)}`;
function state() { const p = new URLSearchParams(location.search); const o = { q: p.get('q') || '', view: p.get('view') || 'grid', guide: p.has('guide'), adv: p.has('adv') }; for (const k of KINDS) if (p.get(k)) o.detail = { kind: k, slug: p.get(k) }; return o; }
function nav(qs, replace) { history[replace ? 'replaceState' : 'pushState'](null, '', qs || location.pathname); render(); window.scrollTo(0, 0); }
function setParam(k, v) { const p = new URLSearchParams(location.search); if (v == null || v === '') p.delete(k); else p.set(k, v); return '?' + p.toString(); }

// ----- shell -----
function header(st) {
  const compact = true;
  return `<header class="top"><div class="wrap top-in">
    <a class="brand" href="./" data-nav><span class="icon">${ICON}</span><span class="word">VGC Dex</span></a>
    ${compact ? `<form class="topsearch" id="form"><input id="q" type="search" value="${esc(st.q)}" placeholder='Search Pokémon, moves, abilities, items…' spellcheck="false" autocomplete="off"><button type="submit" aria-label="Search">⌕</button></form>` : ''}
    <nav class="topnav"><a href="?guide=1" data-nav>Syntax</a><a href="#" id="random">Random</a><span class="reg">${esc(IDX.meta.regulation.regulation)}</span><button id="theme" title="Toggle theme" aria-label="Toggle theme">◐</button></nav>
  </div></header>`;
}
function footer() { const m = IDX.meta; return `<footer class="foot"><div class="wrap">
  <div class="foot-grid"><div><b>VGC Dex</b><br>A typed, shareable search engine for Pokémon Champions.<br><span class="proto">prototype</span></div>
  <div><b>Data</b><br>champions-logic ${esc(m.data_version)}<br>revision <code>${esc(m.data_revision)}</code><br>Regulation ${esc(m.regulation.regulation)} · ${esc(m.regulation.active_from)} → ${esc(m.regulation.active_to)}</div>
  <div><b>Credits</b><br>Dex data via Pokémon Showdown (MIT) and Serebii · sprites via Bulbagarden Archives and Serebii.<br>Pokémon and all related names are © Nintendo / Creatures Inc. / GAME FREAK. Fan project, not affiliated.</div></div>
</div></footer>`; }

// ----- home -----
const EXAMPLES = [
  ['t:steel spe>=100', 'Fast Steel types'], ['xweak:ice t:dragon', 'Dragons 4× weak to Ice'], ['m:"iron head" m:"knock off"', 'Learns both moves'], ['m:/^(u-turn|volt switch|flip turn)$/', 'Any pivot move (regex)'],
  ['a:intimidate or a:prankster', 'Either ability'], ['weak:fairy -resists:steel', 'Fairy-weak, no Steel resist'], ['immune:ground is:mega', 'Megas immune to Ground'],
  ['t:fire bp>=80 cat:special', 'Special Fire moves'], ['prio>0 -cat:status order:bp', 'Damaging priority, by power'], ['o:/flinch/ kind:move', 'Moves whose text says flinch'],
  ['o:/heals?|restores?/ kind:ability', 'Healing abilities'], ['cat:berry o:/hp/', 'Berries mentioning HP'], ['total>=775 -is:mega order:spe', '775+ total non-Megas by Speed']];
// ----- results -----
function statRow(e) { return `<span class="statrow">${STATS.map(k => `<b>${STAT_LABEL[k]}</b>${e.ps[k]}`).join('')}</span>`; }
function speciesCard(e) { return `<a class="card" href="${plink(e)}" data-nav><div class="art">${e.art ? `<img src="${e.art}" alt="" loading="lazy">` : ''}${e.is_mega ? '<span class="mega">Mega</span>' : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.types.map(typeChip).join('')}</div>${statRow(e)}</div></a>`; }
function speciesTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th></th><th>Name</th><th>Type</th>${STATS.map(k => `<th class="num">${STAT_LABEL[k]}</th>`).join('')}<th class="num">Total</th><th>Abilities</th></tr></thead><tbody>${rows.map(e => `<tr><td class="thumb"><img src="${e.sprite}" alt="" loading="lazy"></td><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a>${e.is_mega ? ' <span class="badge">Mega</span>' : ''}</td><td>${e.types.map(typeChip).join(' ')}</td>${STATS.map(k => `<td class="num">${e.ps[k]}</td>`).join('')}<td class="num">${e.total}</td><td class="muted">${e.abilities.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div>`; }
function moveTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Type</th><th>Cat</th><th class="num">BP</th><th class="num">Acc</th><th class="num">PP</th><th class="num">Prio</th><th>Effect</th></tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td>${typeChip(e.type)}</td><td>${catChip(e.cat)}</td><td class="num">${e.bp || '—'}</td><td class="num">${e.acc ?? '—'}</td><td class="num">${e.pp}</td><td class="num">${e.prio > 0 ? '+' : ''}${e.prio}</td><td class="muted">${esc(e.raw.short_desc || '')}</td></tr>`).join('')}</tbody></table></div>`; }
function abilityTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Effect</th><th class="num">Pokémon</th></tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td class="muted">${esc(e.raw.short_desc || '')}</td><td class="num">${IDX.ents.filter(x => x.kind === 'species' && x.abilitySlugs.includes(e.slug)).length}</td></tr>`).join('')}</tbody></table></div>`; }
function itemCard(e) { return `<a class="card item" href="${plink(e)}" data-nav><div class="art">${e.sprite ? `<img src="${e.sprite}" alt="" loading="lazy">` : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.cats.map(c => `<span class="chip neutral">${esc(c)}</span>`).join('')}</div><div class="muted small">${esc(e.raw.short_desc || e.raw.description || '')}</div></div></a>`; }
const SORTS = [['', 'Relevance'], ['name', 'Name'], ['dex', 'Dex #'], ['hp', 'HP'], ['atk', 'Attack'], ['def', 'Defense'], ['spa', 'Special Attack'], ['spd', 'Special Defense'], ['spe', 'Speed'], ['total', 'Total'], ['bp', 'Base Power'], ['acc', 'Accuracy'], ['pp', 'PP'], ['prio', 'Priority']];
function results(st) {
  const q = st.q; let r;
  try { r = search(IDX, q); }
  catch (err) { if (!(err instanceof QueryError)) throw err; const [s, e] = err.span || [0, 0];
    return `<section class="wrap"><div class="notice error"><b>${err.kind === 'syntax' ? 'Syntax error' : 'Scope error'}.</b> ${esc(err.message)}<pre><code>${esc(q.slice(0, s))}<mark>${esc(q.slice(s, e) || ' ')}</mark>${esc(q.slice(e))}</code></pre>${err.kind === 'semantic' ? '<p>Add <code>kind:species</code> or <code>kind:move</code>, or split it into two searches.</p>' : '<p>See the <a href="?guide=1" data-nav>syntax guide</a>.</p>'}<p><a href="${qlink(q).replace('?q=', '?adv=1&q=')}" data-nav>Edit in advanced search</a></p></div></section>`; }
  const scopeTxt = r.scope.length === 4 ? 'all kinds' : r.scope.map(k => KIND_LABEL[k]).join(', ');
  const curOrder = r.order || '';
  const controls = `<div class="controls"><div class="wrap controls-in"><div class="count"><b>${r.results.length}</b> result${r.results.length === 1 ? '' : 's'} <span class="muted">· ${scopeTxt}</span> <a class="editadv" href="${qlink(q).replace('?q=', '?adv=1&q=')}${st.view === 'list' ? '&view=list' : ''}" data-nav>Edit in advanced search</a></div>
    <div class="ctl"><label>View</label><span class="seg"><a href="${setParam('view', 'grid')}" data-nav class="${st.view === 'grid' ? 'on' : ''}">Grid</a><a href="${setParam('view', 'list')}" data-nav class="${st.view === 'list' ? 'on' : ''}">List</a></span>
    <label>Sort</label><select id="sort">${SORTS.map(([v, l]) => `<option value="${v}" ${v === curOrder ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div></div>`;
  if (!r.results.length) return controls + `<section class="wrap"><div class="notice zero"><b>No results.</b> The query parsed fine and was searched across ${scopeTxt}.<ul><li>Bare words match <b>names</b> only — use <code>o:</code> for description text.</li><li>Stats are the in-game Level 50 values, not base stats.</li><li><code>m:</code> wants a move name, e.g. <code>m:"iron head"</code>.</li></ul><p><a href="${qlink(q).replace('?q=', '?adv=1&q=')}" data-nav>Edit in advanced search</a></p></div></section>`;
  const groups = {}; for (const e of r.results) (groups[e.kind] ||= []).push(e);
  let body = '';
  for (const k of KINDS) { const rows = groups[k]; if (!rows) continue; const cap = rows.slice(0, 300);
    let inner; if (k === 'species') inner = st.view === 'list' ? speciesTable(cap) : `<div class="grid">${cap.map(speciesCard).join('')}</div>`;
    else if (k === 'move') inner = moveTable(cap); else if (k === 'ability') inner = abilityTable(cap); else inner = `<div class="grid items">${cap.map(itemCard).join('')}</div>`;
    body += `<section class="wrap group"><h2>${KIND_LABEL[k]} <span class="muted">${rows.length}</span></h2>${inner}${rows.length > 300 ? `<p class="muted">Showing 300 of ${rows.length}. Narrow the query.</p>` : ''}</section>`; }
  return controls + body;
}

// ----- detail pages -----
function effChips(e) { const w = IDX.types.filter(t => e.eff[t] >= 2), rs = IDX.types.filter(t => e.eff[t] > 0 && e.eff[t] < 1), im = IDX.types.filter(t => e.eff[t] === 0);
  const f = (ts, mark) => ts.map(t => `<a href="${qlink(mark + ':' + t)}" data-nav>${typeChip(t)}${e.eff[t] === 4 ? '<sup>×4</sup>' : e.eff[t] === 0.25 ? '<sup>×¼</sup>' : ''}</a>`).join(' ') || '<span class="muted">—</span>';
  return `<dl class="eff"><dt>Weak</dt><dd>${f(w, 'weak')}</dd><dt>Resists</dt><dd>${f(rs, 'resists')}</dd><dt>Immune</dt><dd>${f(im, 'immune')}</dd></dl><p class="muted small">Type chart only — abilities such as Levitate are not applied.</p>`; }
function statTable(e) { const max = 250; return `<table class="stats"><tbody>${STATS.map(k => `<tr><th>${STAT_LABEL[k]}</th><td class="num">${e.ps[k]}</td><td class="bar"><i style="width:${Math.min(100, (e.ps[k] - (k === 'hp' ? 75 : 20)) / max * 100 * 1.6)}%"></i></td></tr>`).join('')}<tr class="tot"><th>Total</th><td class="num">${e.total}</td><td></td></tr></tbody></table><p class="muted small">In-game stats at Level 50, 0 Stat Points, neutral Stat Alignment.</p>`; }
function detail(d) {
  const e = IDX.ents.find(x => x.kind === d.kind && x.slug === d.slug);
  if (!e) return `<section class="wrap"><div class="notice error">No ${d.kind} called <code>${esc(d.slug)}</code>.</div></section>`;
  const back = `<p class="back"><a href="#" id="back">← Back</a></p>`;
  if (e.kind === 'species') {
    const megas = IDX.ents.filter(x => x.is_mega && x.base_slug === e.slug); const base = e.base_slug && IDX.speciesBySlug[e.base_slug];
    const moves = e.learnset.map(s => IDX.moveBySlug[s]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    return `<section class="wrap page">${back}<div class="page-grid"><div class="page-art"><div class="artbox">${e.art ? `<img src="${e.art}" alt="${esc(e.name)}">` : ''}</div>
      <div class="toolbox"><h3>Toolbox</h3><a href="${qlink('t:' + e.types.join(' t:'))}" data-nav>Other ${e.types.join('/')} Pokémon</a>${e.abilities.map(a => `<a href="${qlink('a:' + JSON.stringify(a))}" data-nav>Pokémon with ${esc(a)}</a>`).join('')}<a href="${qlink('lb:' + JSON.stringify(e.name) + ' cat:physical order:bp')}" data-nav>Its physical moves by power</a><a href="${qlink('lb:' + JSON.stringify(e.name) + ' cat:special order:bp')}" data-nav>Its special moves by power</a><a href="${qlink('lb:' + JSON.stringify(e.name) + ' prio>0')}" data-nav>Its priority moves</a>${e.stone ? `<a href="${qlink('name=' + e.stone)}" data-nav>Its Mega Stone</a>` : ''}</div></div>
      <div class="page-main"><h1>${esc(e.name)}${e.is_mega ? ' <span class="badge">Mega</span>' : ''}</h1><div class="chips big">${e.types.map(typeChip).join('')}</div>
      <p class="muted">#${e.dex ?? '—'} · ${e.kg} kg${base ? ` · Mega of <a href="${plink(base)}" data-nav>${esc(base.name)}</a>` : ''}${e.stone ? ` · holds <b>${esc(IDX.ents.find(x => x.kind === 'item' && x.slug === e.stone)?.name || e.stone)}</b>` : ''}</p>
      <h3>Abilities</h3><ul class="plain">${e.abilitySlugs.map((s, i) => { const a = IDX.ents.find(x => x.kind === 'ability' && x.slug === s); return `<li><a href="${a ? plink(a) : '#'}" data-nav><b>${esc(e.abilities[i])}</b></a>${e.raw.abilities && e.raw.abilities[i] && e.raw.abilities[i].is_hidden ? ' <span class="badge">Hidden</span>' : ''} <span class="muted">${esc(a ? a.raw.short_desc || '' : '')}</span></li>`; }).join('')}</ul>
      <h3>Stats</h3>${statTable(e)}<h3>Defensive matchups</h3>${effChips(e)}
      ${megas.length ? `<h3>Mega Evolutions</h3><div class="grid mini">${megas.map(speciesCard).join('')}</div>` : ''}
      <h3>Learnset <span class="muted">${moves.length}</span></h3><div class="movechips">${moves.map(m => `<a class="mc type-${m.type}" href="${plink(m)}" data-nav>${esc(m.name)}</a>`).join('')}</div></div></div></section>`;
  }
  if (e.kind === 'move') { const lb = (IDX.learnedBy[e.slug] || []).filter(s => !s.is_mega);
    return `<section class="wrap page">${back}<div class="page-grid"><div class="page-art"><div class="artbox movebox"><div class="chips big">${typeChip(e.type)}${catChip(e.cat)}</div><div class="bigstat"><span><b>${e.bp || '—'}</b>BP</span><span><b>${e.acc ?? '—'}</b>Acc</span><span><b>${e.pp}</b>PP</span><span><b>${e.prio > 0 ? '+' : ''}${e.prio}</b>Prio</span></div></div>
      <div class="toolbox"><h3>Toolbox</h3><a href="${qlink('m=' + JSON.stringify(e.name))}" data-nav>Pokémon that learn it (search)</a><a href="${qlink('m=' + JSON.stringify(e.name) + ' order:spe')}" data-nav>…fastest first</a><a href="${qlink('t:' + e.type + ' cat:' + e.cat + ' order:bp')}" data-nav>Other ${e.type} ${e.cat} moves</a>${e.flags.map(f => `<a href="${qlink('flag:' + f)}" data-nav>All <i>${f}</i> moves</a>`).join('')}</div></div>
      <div class="page-main"><h1>${esc(e.name)}</h1><p>${esc(e.raw.long_desc || e.raw.short_desc || '')}</p><p class="muted">Target: ${esc(e.target)}${e.variable ? ' · variable power' : ''}${e.classes.length ? ' · Classification: ' + e.classes.map(esc).join(', ') : ''}<br>Flags: ${e.flags.map(f => `<code>${f}</code>`).join(' ') || '—'}</p>
      <h3>Learned by <span class="muted">${lb.length}</span></h3><div class="grid mini">${lb.map(speciesCard).join('')}</div></div></div></section>`; }
  if (e.kind === 'ability') { const holders = IDX.ents.filter(x => x.kind === 'species' && x.abilitySlugs.includes(e.slug));
    return `<section class="wrap page">${back}<div class="page-grid"><div class="page-art"><div class="toolbox"><h3>Toolbox</h3><a href="${qlink('a=' + JSON.stringify(e.name))}" data-nav>Pokémon with it (search)</a><a href="${qlink('a=' + JSON.stringify(e.name) + ' order:spe')}" data-nav>…fastest first</a></div></div>
      <div class="page-main"><h1>${esc(e.name)}</h1><p>${esc(e.raw.long_desc || e.raw.short_desc || '')}</p><h3>Pokémon <span class="muted">${holders.length}</span></h3><div class="grid mini">${holders.map(speciesCard).join('')}</div></div></div></section>`; }
  const megaFor = IDX.ents.filter(x => x.is_mega && x.stone === e.slug);
  return `<section class="wrap page">${back}<div class="page-grid"><div class="page-art"><div class="artbox itembox">${e.sprite ? `<img src="${e.sprite}" alt="">` : ''}</div><div class="toolbox"><h3>Toolbox</h3>${e.cats.map(c => `<a href="${qlink('cat:' + JSON.stringify(c))}" data-nav>All ${esc(c)} items</a>`).join('')}</div></div>
    <div class="page-main"><h1>${esc(e.name)}</h1><div class="chips big">${e.cats.map(c => `<span class="chip neutral">${esc(c)}</span>`).join('')}</div><p>${esc(e.raw.long_desc || e.raw.description || '')}</p>${megaFor.length ? `<h3>Mega Evolution</h3><div class="grid mini">${megaFor.map(speciesCard).join('')}</div>` : ''}</div></div></section>`;
}

// ----- syntax guide -----
function guide() {
  const T = rows => `<table class="guide"><tbody>${rows.map(([a, b]) => `<tr><td><code>${esc(a)}</code></td><td>${b}</td></tr>`).join('')}</tbody></table>`;
  return `<section class="wrap page doc"><h1>Syntax guide</h1><p>Type words to search names. Add <code>field:value</code> terms to filter. Terms combine with AND; use <code>or</code>, <code>-</code>, parentheses, quotes and <code>/regex/</code> as needed. Every search is a link you can share.</p>
  <h2>Shape of a query</h2>${T([['word', 'name match across Pokémon, moves, abilities, items'], ['a b', 'AND'], ['a or b', 'OR — lower precedence than AND'], ['-a', 'NOT'], ['( … )', 'grouping'], ['"iron head"', 'quote values with spaces'], ['field:/re/', 'regex on text fields, case-insensitive'], [': = != < <= > >=', 'operators; <code>:</code> means "matches"']])}
  <h2>Pokémon</h2>${T([['t: type:', 'has type — <code>t:steel t:fairy</code> both, <code>-t:water</code> neither, <code>t=steel/fairy</code> exactly'], ['a: ability:', 'has ability (any slot)'], ['m: move: learns:', 'learnset contains the move; repeat for AND'], ['hp atk def spa spd spe', 'in-game stats at Level 50 (0 Stat Points, neutral alignment)'], ['total', 'sum of the six stats'], ['weak: xweak: resists: xresists: immune:', 'takes ≥2× / 4× / ≤½× / ¼× / 0× from a type — type chart only'], ['is:mega  stone:  base:', 'Mega formes'], ['dex: kg: abilities:', 'National Dex number, weight, ability count']])}
  <h2>Moves</h2>${T([['t: cat:', 'type; physical / special / status'], ['bp: acc: pp: prio:', 'numbers — <code>bp>=80</code>, <code>prio>0</code>'], ['flag:', 'contact, protect, sound, punch, bite, pulse, bullet, slicing, wind, powder, …'], ['target:', 'spread, single, or Showdown target ids'], ['class:', 'Champions Classification — <code>class:punching</code>'], ['lb: learnedby:', 'moves a Pokémon learns'], ['is:spread is:variable', 'spread moves, variable-power moves']])}
  <h2>Abilities &amp; items</h2>${T([['o: desc: text:', 'description text — moves, abilities, items'], ['cat:', 'item category — berry, mega stone, recovery, …'], ['for:', 'Mega Stone for a Pokémon'], ['is:consumable is:held', 'item class']])}
  <h2>Scope, sort, kinds</h2>${T([['kind: is:', 'species, move, ability, item'], ['order: dir:', 'spe, bp, name, dex, total, … · asc / desc']])}
  <p>A query's result kinds are the intersection of what its fields apply to: <code>t:fire spe>100</code> is Pokémon only; <code>t:fire bp>=80</code> is moves only; both together is an error, not an empty list. Regulation history (<code>r:</code>, <code>new:</code>, <code>removed:</code>) is not in this prototype.</p>
  <h2>Examples</h2><div class="ex-grid">${EXAMPLES.map(([q, why]) => `<a class="ex" href="${qlink(q)}" data-nav><code>${esc(q)}</code><span>${esc(why)}</span></a>`).join('')}</div></section>`;
}

// ---------- advanced search form (home page) — Scryfall /advanced structure ----------
const FLAG_LIST = ['contact', 'protect', 'sound', 'punch', 'bite', 'pulse', 'bullet', 'slicing', 'wind', 'powder', 'dance', 'heal', 'recharge', 'charge', 'reflectable', 'snatch', 'bypasssub', 'gravity', 'defrost', 'explosive', 'mental', 'mirror', 'metronome'];
const CRIT_LIST = [['mega', 'Mega forme'], ['spread', 'Spread move'], ['variable', 'Variable-power move'], ['consumable', 'Consumable item'], ['held', 'Held item']];
const STAT_OPTS = [...STATS.map(k => [k, ({ hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Special Attack', spd: 'Special Defense', spe: 'Speed' })[k]]), ['total', 'Total'], ['kg', 'Weight (kg)'], ['dex', 'National Dex #']];
const MATCH_OPTS = [['xweak', 'Extremely weak to'], ['weak', 'Weak to'], ['resists', 'Resists'], ['xresists', 'Doubly resists'], ['immune', 'Immune to']];
const MNUM_OPTS = [['bp', 'Base Power'], ['acc', 'Accuracy'], ['pp', 'PP'], ['prio', 'Priority']];
const MODE_OPTS = [['=', 'equal to'], ['<', 'less than'], ['>', 'greater than'], ['<=', 'less than or equal to'], ['>=', 'greater than or equal to'], ['!=', 'not equal to']];
const quote = v => /[\s"():<>=!\/]/.test(v) || v === '' ? JSON.stringify(v) : v;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const ICONS = { name: 'M3 5h18v14H3z M7 9h6 M7 13h10', text: 'M4 5h16 M4 9h16 M4 13h10 M4 17h7', type: 'M20 12l-8 8-8-8 8-8z', ability: 'M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7z', move: 'M5 12h14 M13 6l6 6-6 6', stat: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2', forme: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8v8 M8 12h8', reg: 'M5 4h14v16H5z M9 4v16 M13 9h3 M13 13h3', match: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5', cat: 'M4 6h16 M4 12h16 M4 18h16', crit: 'M9 6h11 M9 12h11 M9 18h11 M4 6h1 M4 12h1 M4 18h1', num: 'M4 7h16 M4 12h16 M4 17h16 M8 4v16 M16 4v16', flag: 'M5 21V4h12l-2 4 2 4H5', target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', lb: 'M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z M8 7h7', item: 'M6 8h12l1 12H5z M9 8V6a3 3 0 0 1 6 0v2', pref: 'M14 4l6 6-9 9H5v-6z M12 6l6 6', kinds: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z' };
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[k]}"/></svg>`;
function emptyForm() { return { kinds: new Set(KINDS), name: '', text: '', types: [], typeMode: 'all', abilities: [], moves: [], stats: [{ stat: 'spe', op: '>=', val: '' }], formes: { base: true, mega: true }, regStatus: 'legal', matchups: [{ rel: 'weak', type: '' }], cats: new Set(), crit: [], mnums: [{ stat: 'bp', op: '>=', val: '' }], flags: [], target: 'any', cls: '', lb: '', icats: new Set(), iclass: 'any', view: 'grid', order: '', dir: '', also: [] }; }
function buildQuery(fs) {
  const t = []; const tok = (arr, field, q) => arr.forEach(x => t.push((x.neg ? '-' : '') + field + ':' + (q ? quote(x.v) : x.v)));
  const k = [...fs.kinds]; if (k.length === 1) t.push('kind:' + k[0]); else if (k.length === 2 || k.length === 3) t.push('(' + k.map(x => 'kind:' + x).join(' or ') + ')');
  if (fs.name.trim()) t.push(quote(fs.name.trim()));
  if (fs.text.trim()) t.push(/^\/.*\/$/.test(fs.text.trim()) ? 'o:' + fs.text.trim() : 'o:' + quote(fs.text.trim()));
  const inc = fs.types.filter(x => !x.neg).map(x => x.v), exc = fs.types.filter(x => x.neg).map(x => x.v);
  if (inc.length) { if (fs.typeMode === 'exact') t.push('t=' + inc.slice(0, 2).join('/')); else if (fs.typeMode === 'any' && inc.length > 1) t.push('(' + inc.map(x => 't:' + x).join(' or ') + ')'); else inc.forEach(x => t.push('t:' + x)); }
  exc.forEach(x => t.push('-t:' + x));
  tok(fs.abilities, 'a', true); tok(fs.moves, 'm', true);
  fs.stats.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
  if (fs.formes.mega && !fs.formes.base) t.push('is:mega'); else if (fs.formes.base && !fs.formes.mega) t.push('-is:mega');
  fs.matchups.filter(r => r.type).forEach(r => t.push(`${r.rel}:${r.type}`));
  const c = [...fs.cats]; if (c.length === 1) t.push('cat:' + c[0]); else if (c.length === 2) t.push('(' + c.map(x => 'cat:' + x).join(' or ') + ')');
  tok(fs.crit, 'is', false);
  fs.mnums.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
  tok(fs.flags, 'flag', false);
  if (fs.target !== 'any') t.push('target:' + fs.target);
  if (fs.cls) t.push('class:' + quote(fs.cls));
  if (fs.lb.trim()) t.push('lb:' + quote(fs.lb.trim()));
  const ic = [...fs.icats]; if (ic.length === 1) t.push('cat:' + quote(ic[0])); else if (ic.length > 1) t.push('(' + ic.map(x => 'cat:' + quote(x)).join(' or ') + ')');
  if (fs.iclass !== 'any') t.push('is:' + fs.iclass);
  if (fs.order) { t.push('order:' + fs.order); if (fs.dir) t.push('dir:' + fs.dir); }
  return t.concat(fs.also).join(' ');
}
function astText(n) { if (!n) return ''; if (n.type === 'word') return quote(n.v); if (n.type === 'term') return n.field + n.op + (n.isRegex ? '/' + n.val + '/' : quote(n.val)); if (n.type === 'not') return '-' + astText(n.node); if (n.type === 'or') return '(' + n.items.map(astText).join(' or ') + ')'; return n.items.map(astText).join(' '); }
function queryToForm(q) {
  const fs = emptyForm(); fs.stats = []; fs.mnums = []; fs.matchups = [];
  let ast; try { ast = parse(q); } catch (e) { fs.also = [q]; return fs; }
  if (!ast) return fs;
  const items = ast.type === 'and' ? ast.items : [ast];
  const statKeys = new Set(STAT_OPTS.map(x => x[0])), mnumKeys = new Set(MNUM_OPTS.map(x => x[0]));
  const isCatVal = v => ['physical', 'special', 'status'].includes(norm(v));
  const byName = (kind, v) => { const e = IDX.ents.find(x => x.kind === kind && (x.norm === norm(v) || x.compact === compact(v))); return e ? e.name : v; };
  for (const it of items) {
    if (it.type === 'word') { fs.name = (fs.name + ' ' + it.v).trim(); continue; }
    if (it.type === 'or' && it.items.every(x => x.type === 'term' && x.op === ':' && !x.isRegex)) {
      const fields = new Set(it.items.map(x => F[x.field] && F[x.field].name)); const vals = it.items.map(x => x.val);
      if (fields.size === 1 && fields.has('kind') && vals.every(v => KINDS.includes(norm(v)))) { fs.kinds = new Set(vals.map(norm)); continue; }
      if (fields.size === 1 && fields.has('t') && vals.every(v => IDX.types.includes(norm(v)))) { vals.forEach(v => fs.types.push({ v: norm(v), neg: false })); fs.typeMode = 'any'; continue; }
      if (fields.size === 1 && fields.has('cat')) { if (vals.every(isCatVal)) { vals.forEach(v => fs.cats.add(norm(v))); continue; } if (vals.every(v => IDX_ITEM_CATS.map(norm).includes(norm(v)))) { vals.forEach(v => fs.icats.add(IDX_ITEM_CATS.find(c => norm(c) === norm(v)))); continue; } }
      fs.also.push(astText(it)); continue; }
    const neg = it.type === 'not'; const tm = neg ? it.node : it;
    if (tm.type !== 'term' || !F[tm.field]) { fs.also.push(astText(it)); continue; }
    const f = F[tm.field].name, v = tm.val, vn = norm(v);
    if (tm.isRegex && f !== 'o') { fs.also.push(astText(it)); continue; }
    if (f === 't' && tm.op === ':' && IDX.types.includes(vn)) { fs.types.push({ v: vn, neg }); if (!neg && fs.typeMode === 'any') fs.typeMode = 'all'; }
    else if (f === 't' && tm.op === '=' && !neg && v.split(/[\/,+]/).every(x => IDX.types.includes(norm(x)))) { v.split(/[\/,+]/).forEach(x => fs.types.push({ v: norm(x), neg: false })); fs.typeMode = 'exact'; }
    else if (f === 'a' && tm.op === ':') fs.abilities.push({ v: byName('ability', v), neg });
    else if (f === 'm' && tm.op === ':') fs.moves.push({ v: byName('move', v), neg });
    else if (f === 'flag' && tm.op === ':') fs.flags.push({ v: vn, neg });
    else if (f === 'is' && vn === 'mega') { fs.formes = neg ? { base: true, mega: false } : { base: false, mega: true }; }
    else if (f === 'is' && CRIT_LIST.some(c => c[0] === vn)) fs.crit.push({ v: vn, neg });
    else if (neg) fs.also.push(astText(it));
    else if (f === 'kind' && KINDS.includes(vn)) fs.kinds = new Set([vn]);
    else if (f === 'name' && tm.op === ':') fs.name = (fs.name + ' ' + v).trim();
    else if (f === 'o' && tm.op === ':') fs.text = tm.isRegex ? '/' + v + '/' : v;
    else if (statKeys.has(f) && tm.op !== ':') fs.stats.push({ stat: f, op: tm.op, val: v });
    else if (mnumKeys.has(f) && tm.op !== ':') fs.mnums.push({ stat: f, op: tm.op, val: v });
    else if (MATCH_OPTS.some(m => m[0] === f) && tm.op === ':' && IDX.types.includes(vn)) fs.matchups.push({ rel: f, type: vn });
    else if (f === 'cat' && tm.op === ':' && isCatVal(v)) fs.cats.add(vn);
    else if (f === 'cat' && tm.op === ':' && IDX_ITEM_CATS.map(norm).includes(vn)) fs.icats.add(IDX_ITEM_CATS.find(c => norm(c) === vn));
    else if (f === 'target' && tm.op === ':' && ['spread', 'single'].includes(vn)) fs.target = vn;
    else if (f === 'class' && tm.op === ':') fs.cls = IDX.classes.find(c => norm(c) === vn) || v;
    else if (f === 'lb' && tm.op === ':') fs.lb = byName('species', v);
    else if (f === 'order' && tm.op === ':') fs.order = vn;
    else if (f === 'dir' && tm.op === ':') fs.dir = vn;
    else fs.also.push(astText(it));
  }
  fs.stats.push({ stat: 'spe', op: '>=', val: '' }); fs.mnums.push({ stat: 'bp', op: '>=', val: '' }); fs.matchups.push({ rel: 'weak', type: '' });
  return fs;
}
let FS = null;
// --- controls ---
const sel = (name, opts, cur, cls) => `<select class="form-input auto ${cls || ''}" data-fs="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const cb = (attr, val, label, on) => `<label class="asc"><input type="checkbox" ${attr}="${esc(val)}" ${on ? 'checked' : ''}> ${label}</label>`;
const TK_META = () => ({ types: { group: 'Types', items: IDX.types.map(t => [t, cap(t)]), placeholder: 'Enter a type or choose from the list' }, abilities: { group: 'Abilities', items: IDX.ents.filter(e => e.kind === 'ability').map(e => [e.name, e.name]), placeholder: 'Enter an ability or choose from the list' }, moves: { group: 'Moves', items: IDX.ents.filter(e => e.kind === 'move').map(e => [e.name, e.name]), placeholder: 'Enter a move or choose from the list' }, flags: { group: 'Flags', items: FLAG_LIST.map(f => [f, f]), placeholder: 'Enter a flag or choose from the list' }, crit: { group: 'Criteria', items: CRIT_LIST.map(([v, l]) => [v, l]), placeholder: 'Enter a criterion or choose from the list' }, species: { group: 'Pokémon', items: IDX.ents.filter(e => e.kind === 'species' && !e.is_mega).map(e => [e.name, e.name]), placeholder: 'Enter a Pokémon, e.g. “Garchomp”' } });
function tokLabel(key, v) { const m = TK_META()[key]; const hit = m.items.find(x => x[0] === v); return hit ? hit[1] : v; }
function tokens(key) { const fs = FS, m = TK_META()[key]; return `<div class="tok-wrap"><div class="tokens" data-tk="${key}">${fs[key].map((x, i) => `<div class="tok"><button type="button" class="tok-x" data-tx="${key}" data-i="${i}" aria-label="Remove">×</button><button type="button" class="pol ${x.neg ? 'not' : 'is'}" data-pol="${key}" data-i="${i}" title="Toggle include / exclude">${x.neg ? 'NOT' : 'IS'}</button><span class="tok-l">${esc(tokLabel(key, x.v))}</span></div>`).join('')}<input type="text" class="tok-in" data-tkin="${key}" placeholder="${esc(m.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"></div><div class="tok-menu" data-menu="${key}" hidden></div></div>`; }
function singlePicker(key, fsField, value) { const m = TK_META()[key]; return `<div class="tok-wrap single"><input type="text" class="form-input tok-in" data-fs="${fsField}" data-tkin="${key}" data-single="1" value="${esc(value)}" placeholder="${esc(m.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="tok-menu" data-menu="${key}" hidden></div></div>`; }
// --- suggestion menu (Scryfall-style list directly under the field; one entry per row) ---
let MENU = { key: null, rows: [], hi: -1 };
function menuRows(key, typed) { const m = TK_META()[key]; const q = norm(typed), qc = compact(typed); const chosen = new Set((FS[key] || []).map(x => x.v)); return m.items.filter(([v, l]) => !chosen.has(v) && (!q || norm(l).includes(q) || compact(l).includes(qc))); }
function openMenu(input) { const key = input.dataset.tkin; const menu = input.closest('.tok-wrap').querySelector('.tok-menu'); const rows = menuRows(key, input.value); MENU = { key, rows, hi: rows.length && input.value ? 0 : -1, input, menu };
  if (!rows.length) { menu.innerHTML = `<div class="tok-menu-empty">No matches</div>`; menu.hidden = false; return; }
  menu.innerHTML = `<div class="tok-menu-group">${esc(TK_META()[key].group)}</div>` + rows.slice(0, 400).map(([v, l], i) => `<div class="tok-menu-row ${i === MENU.hi ? 'hi' : ''}" data-pick="${esc(v)}" data-i="${i}">${esc(l)}</div>`).join('') + (rows.length > 400 ? `<div class="tok-menu-empty">…keep typing to narrow the list</div>` : ''); menu.hidden = false; }
function closeMenu() { if (MENU.menu) MENU.menu.hidden = true; MENU = { key: null, rows: [], hi: -1 }; }
function moveHi(d) { if (!MENU.menu || !MENU.rows.length) return; MENU.hi = Math.max(0, Math.min(MENU.rows.length - 1, MENU.hi + d)); [...MENU.menu.querySelectorAll('.tok-menu-row')].forEach((r, i) => { r.classList.toggle('hi', i === MENU.hi); if (i === MENU.hi) r.scrollIntoView({ block: 'nearest' }); }); }
function pick(input, v) { const key = input.dataset.tkin; if (input.dataset.single) { input.value = v; closeMenu(); readForm(); return; } if (addToken(key, v)) { closeMenu(); rerenderTokens(key); const nin = $(`[data-tkin="${key}"]`); if (nin) nin.focus(); } }
function dupRow(kind, r, i, opts) { return `<div class="band dup" data-row="${kind}" data-i="${i}"><select class="form-input auto small-select" data-f="stat">${opts.map(([v, l]) => `<option value="${v}" ${v === r.stat ? 'selected' : ''}>${l}</option>`).join('')}</select><select class="form-input auto small-select" data-f="op">${MODE_OPTS.map(([v, l]) => `<option value="${v}" ${v === r.op ? 'selected' : ''}>${l}</option>`).join('')}</select><input type="number" class="form-input auto small-select" data-f="val" value="${esc(r.val)}" placeholder="Any value, e.g. “100”"></div>`; }
const pill = t => t ? `<span class="chip type-${t}">${t}</span>` : `<span class="pill-none">Type…</span>`;
function pillSelect(attrs, val) { return `<div class="pillsel" ${attrs}><button type="button" class="form-input auto pill-btn" data-pillbtn>${pill(val)}</button><div class="tok-menu pill-menu" hidden><div class="tok-menu-group">Types</div>${IDX.types.map(t => `<div class="tok-menu-row ${t === val ? 'hi' : ''}" data-pillpick="${t}">${pill(t)}</div>`).join('')}</div></div>`; }
function matchRow(r, i) { return `<div class="band dup" data-row="matchups" data-i="${i}"><select class="form-input auto small-select" data-f="rel">${MATCH_OPTS.map(([v, l]) => `<option value="${v}" ${v === r.rel ? 'selected' : ''}>${l}</option>`).join('')}</select>${pillSelect(`data-f="type" data-val="${esc(r.type)}"`, r.type)}</div>`; }
function advForm() {
  const fs = FS; const on = k => fs.kinds.has(k);
  const row = (ic, label, kind, bands, tip, short) => `<div class="form-row" ${kind && !on(kind) ? 'hidden' : ''} data-sec="${kind || ''}"><label class="form-row-label ${short ? 'short' : ''}">${icon(ic)} ${label}</label><div class="form-row-content">${bands}${tip ? `<p class="form-row-tip">${tip}</p>` : ''}</div></div>`;
  const band = (inner, cls) => `<div class="band ${cls || ''}">${inner}</div>`;
  return `<section class="wrap adv"><form id="adv" class="form-layout" novalidate>
  ${row('kinds', 'Search in', null, band(KINDS.map(k => cb('data-kind', k, KIND_LABEL[k], on(k))).join(''), 'cbs'), 'Which kinds of results to return. The rows below follow this choice.', true)}
  ${row('name', 'Name', null, band(`<input type="text" class="form-input" data-fs="name" value="${esc(fs.name)}" placeholder="Any words in the name, e.g. “Garchomp”">`), '')}
  ${row('text', 'Text', null, band(`<input type="text" class="form-input" data-fs="text" value="${esc(fs.text)}" placeholder="Any text, e.g. “flinch”">`), 'Enter text that should appear in the description of a move, ability or item. Wrap it in slashes for a regular expression, e.g. /heals?|restores?/.')}
  ${row('type', 'Types', 'species', band(tokens('types')) + band(sel('typeMode', [['all', 'Including these types'], ['exact', 'Exactly these types'], ['any', 'Any of these types']], fs.typeMode)), 'Choose any type to match. Click the “IS” or “NOT” button to toggle between including and excluding a type. Moves match on their own type.')}
  ${row('ability', 'Abilities', 'species', band(tokens('abilities')), 'Any slot, hidden abilities included. “NOT” excludes Pokémon that have it.')}
  ${row('move', 'Learns', 'species', band(tokens('moves')), 'Every “IS” move must be in the learnset; “NOT” moves must not be.')}
  ${row('stat', 'Stats', 'species', `<div id="stats-rows">${fs.stats.map((r, i) => dupRow('stats', r, i, STAT_OPTS)).join('')}</div>`, 'Restrict Pokémon based on their in-game stats (Level 50, 0 Stat Points, neutral alignment). Stats Total is the sum of the six.')}
  ${row('forme', 'Formes', 'species', band(cb('data-forme', 'base', 'Base formes', fs.formes.base) + cb('data-forme', 'mega', 'Mega formes', fs.formes.mega), 'cbs'), 'Include or exclude Mega formes, which are listed as their own entries.', true)}
  ${row('reg', 'Regulation', null, band(sel('regStatus', [['legal', 'Legal'], ['new', 'Newly legal'], ['removed', 'Removed']], fs.regStatus, 'medium-select') + `<select class="form-input auto medium-select" disabled><option>${esc(IDX.meta.regulation.regulation)}</option></select>`), 'Only the current regulation is loaded in this prototype; “Newly legal” and “Removed” arrive with regulation history.', true)}
  ${row('match', 'Matchups', 'species', `<div id="matchups-rows">${fs.matchups.map(matchRow).join('')}</div>`, 'Defensive matchups from the type chart only — abilities such as Levitate are not applied. Choosing a type adds another row.')}
  ${row('cat', 'Category', 'move', band(['physical', 'special', 'status'].map(c => cb('data-cat', c, cap(c), fs.cats.has(c))).join(''), 'cbs'), 'Only return moves of the selected categories.', true)}
  ${row('num', 'Move numbers', 'move', `<div id="mnums-rows">${fs.mnums.map((r, i) => dupRow('mnums', r, i, MNUM_OPTS)).join('')}</div>`, 'Base power, accuracy, PP (Champions values) and priority. Moves that never miss count as accuracy above 100.')}
  ${row('flag', 'Flags', 'move', band(tokens('flags')), 'Contact, protect, sound, punch, bite, pulse, bullet, slicing, wind, powder… Click “IS” / “NOT” to include or exclude.')}
  ${row('target', 'Target', 'move', band(sel('target', [['any', 'Any target'], ['spread', 'Spread (hits more than one)'], ['single', 'Single target']], fs.target) + sel('cls', [['', 'Any classification'], ...IDX.classes.map(c => [c, c])], fs.cls)), 'Target and Champions Classification.')}
  ${row('lb', 'Learned by', 'move', band(singlePicker('species', 'lb', fs.lb)), 'Only moves this Pokémon can learn.')}
  ${row('crit', 'Criteria', null, band(tokens('crit')), 'Enter any criteria to match, in any order. Click “IS” / “NOT” to include or exclude an item.')}
  ${row('item', 'Item category', 'item', band(IDX_ITEM_CATS.map(c => cb('data-icat', c, esc(c), fs.icats.has(c))).join(''), 'cbs') + band(sel('iclass', [['any', 'Any class'], ['consumable', 'Consumable'], ['held', 'Held']], fs.iclass)), 'Only return items of the selected categories.', true)}
  ${row('pref', 'Preferences', null, band(sel('view', [['grid', 'Display as Grid'], ['list', 'Display as List']], fs.view) + sel('order', SORTS.map(([v, l]) => [v, 'Sort by ' + l]), fs.order) + sel('dir', [['', 'Default order'], ['asc', 'Ascending'], ['desc', 'Descending']], fs.dir)), '')}
  <div class="form-row also" ${fs.also.length ? '' : 'hidden'}><label class="form-row-label short">${icon('crit')} Also</label><div class="form-row-content"><div class="band"><code id="also">${esc(fs.also.join(' '))}</code></div><p class="form-row-tip">Terms from the typed query this form has no control for. They stay in the search.</p></div></div>
  <div class="submit-bar"><code id="qpreview" class="qpreview" title="The query this form will run"></code><button type="button" class="reset-n" id="reset">Reset</button><button type="submit" class="submit-n" id="go">Search with these options</button></div>
  </form>
  </section>`;
}
function readForm() {
  const f = $('#adv'); if (!f) return; const fs = FS;
  fs.kinds = new Set([...f.querySelectorAll('[data-kind]')].filter(x => x.checked).map(x => x.dataset.kind));
  for (const el of f.querySelectorAll('[data-fs]')) fs[el.dataset.fs] = el.value;
  fs.formes = { base: !!f.querySelector('[data-forme=base]')?.checked, mega: !!f.querySelector('[data-forme=mega]')?.checked };
  fs.cats = new Set([...f.querySelectorAll('[data-cat]')].filter(x => x.checked).map(x => x.dataset.cat));
  fs.icats = new Set([...f.querySelectorAll('[data-icat]')].filter(x => x.checked).map(x => x.dataset.icat));
  for (const kind of ['stats', 'mnums']) fs[kind] = [...f.querySelectorAll(`[data-row="${kind}"]`)].map(r => ({ stat: r.querySelector('[data-f=stat]').value, op: r.querySelector('[data-f=op]').value, val: r.querySelector('[data-f=val]').value }));
  fs.matchups = [...f.querySelectorAll('[data-row="matchups"]')].map(r => ({ rel: r.querySelector('[data-f=rel]').value, type: r.querySelector('[data-f=type]').dataset.val || '' }));
  for (const sec of f.querySelectorAll('.form-row[data-sec]')) if (sec.dataset.sec) sec.hidden = !fs.kinds.has(sec.dataset.sec);
  // duplicant: keep exactly one empty trailing row
  for (const kind of ['stats', 'mnums']) { const rows = fs[kind]; const empties = rows.filter(r => r.val === '').length; if (empties === 0) { rows.push({ stat: kind === 'stats' ? 'spe' : 'bp', op: '>=', val: '' }); rerenderRows(kind, true); } }
  if (!fs.matchups.some(r => !r.type)) { fs.matchups.push({ rel: 'weak', type: '' }); rerenderRows('matchups'); }
  updatePreview();
}
function updatePreview() { if (!FS) return; const q = buildQuery(FS); const p = $('#qpreview'); if (p) p.textContent = q || ''; const go = $('#go'); if (go) go.disabled = !q; }
function submitForm() { readForm(); const q = buildQuery(FS); if (!q) return; nav(qlink(q) + (FS.view === 'list' ? '&view=list' : '')); }
function addToken(key, raw) {
  const v = raw.trim(); if (!v) return false; let val = v;
  if (key === 'types') { const t = norm(v); if (!IDX.types.includes(t)) return false; val = t; }
  else if (key === 'flags') { const t = norm(v).replace(/ /g, ''); if (!FLAG_LIST.includes(t)) return false; val = t; }
  else if (key === 'crit') { const c = CRIT_LIST.find(([k, l]) => norm(l) === norm(v) || k === norm(v)); if (!c) return false; val = c[0]; }
  else if (key === 'species') { const e = IDX.ents.find(x => x.kind === 'species' && (x.norm === norm(v) || x.compact === compact(v))); val = e ? e.name : v; }
  else if (key === 'abilities' || key === 'moves') { const kind = key === 'abilities' ? 'ability' : 'move'; const e = IDX.ents.find(x => x.kind === kind && (x.norm === norm(v) || x.compact === compact(v))); val = e ? e.name : v; }
  if (FS[key].some(x => x.v === val)) return true;
  FS[key].push({ v: val, neg: false }); return true;
}
function rerenderTokens(key) { const box = $(`[data-tk="${key}"]`); if (!box) return; box.closest('.tok-wrap').outerHTML = tokens(key); updatePreview(); }
function bindForm() {
  const f = $('#adv'); if (!f) return; updatePreview();
  f.addEventListener('input', ev => { const t = ev.target; if (t.classList.contains('tok-in')) { openMenu(t); if (t.dataset.single) readForm(); return; } readForm(); });
  f.addEventListener('focusin', ev => { const t = ev.target; if (t.classList && t.classList.contains('tok-in')) openMenu(t); });
  f.addEventListener('focusout', ev => { const t = ev.target; if (t.classList && t.classList.contains('tok-in')) setTimeout(() => { if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('.tok-wrap')) closeMenu(); }, 120); });
  f.addEventListener('change', ev => { if (ev.target.classList.contains('tok-in')) return; readForm(); });
  f.addEventListener('keydown', ev => { const t = ev.target; if (!(t.classList && t.classList.contains('tok-in'))) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (MENU.menu && !MENU.menu.hidden) moveHi(1); else openMenu(t); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); moveHi(-1); return; }
    if (ev.key === 'Escape') { closeMenu(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); if (MENU.rows.length && MENU.hi >= 0) pick(t, MENU.rows[MENU.hi][0]); else if (t.dataset.single) { closeMenu(); readForm(); } else if (addToken(t.dataset.tkin, t.value)) { closeMenu(); rerenderTokens(t.dataset.tkin); $(`[data-tkin="${t.dataset.tkin}"]`)?.focus(); } return; }
    if (ev.key === 'Backspace' && !t.value && !t.dataset.single && FS[t.dataset.tkin].length) { FS[t.dataset.tkin].pop(); rerenderTokens(t.dataset.tkin); $(`[data-tkin="${t.dataset.tkin}"]`)?.focus(); } });
  f.addEventListener('pointerdown', ev => { const pp = ev.target.closest('[data-pillpick]'); if (pp) { ev.preventDefault(); const ps = pp.closest('.pillsel'); ps.dataset.val = pp.dataset.pillpick; ps.querySelector('.pill-btn').innerHTML = pill(pp.dataset.pillpick); ps.querySelector('.pill-menu').hidden = true; readForm(); return; }
    const r = ev.target.closest('[data-pick]'); if (r) { ev.preventDefault(); const input = r.closest('.tok-wrap').querySelector('.tok-in'); pick(input, r.dataset.pick); } });
  f.addEventListener('click', ev => {
    const pol = ev.target.closest('[data-pol]'); if (pol) { const x = FS[pol.dataset.pol][Number(pol.dataset.i)]; x.neg = !x.neg; rerenderTokens(pol.dataset.pol); return; }
    const tx = ev.target.closest('[data-tx]'); if (tx) { FS[tx.dataset.tx].splice(Number(tx.dataset.i), 1); rerenderTokens(tx.dataset.tx); return; }
    if (ev.target.classList.contains('tokens')) ev.target.querySelector('.tok-in')?.focus();
    const pb = ev.target.closest('[data-pillbtn]'); if (pb) { const menu = pb.nextElementSibling; const open = menu.hidden; f.querySelectorAll('.pill-menu').forEach(m => m.hidden = true); menu.hidden = !open; return; }
    if (!ev.target.closest('.pillsel')) f.querySelectorAll('.pill-menu').forEach(m => m.hidden = true);
  });
  f.addEventListener('submit', ev => { ev.preventDefault(); submitForm(); });
  $('#reset').addEventListener('click', () => { FS = emptyForm(); history.replaceState('app', '', location.pathname); render(); });
}
function rerenderRows(k, keepFocus) { const box = $('#' + k + '-rows'); if (!box) return; const active = document.activeElement; const idx = active && active.closest ? active.closest('[data-row]')?.dataset.i : null; const fld = active && active.dataset ? active.dataset.f : null; box.innerHTML = k === 'matchups' ? FS[k].map(matchRow).join('') : FS[k].map((r, i) => dupRow(k, r, i, k === 'stats' ? STAT_OPTS : MNUM_OPTS)).join(''); if (keepFocus && idx != null && fld) { const el = box.querySelector(`[data-row="${k}"][data-i="${idx}"] [data-f="${fld}"]`); if (el) { el.focus(); if (el.type === 'number' || el.type === 'text') { const L = el.value.length; try { el.setSelectionRange(L, L); } catch (e) {} } } } updatePreview(); }

// ----- render + events -----
function render() {
  const st = state();
  let body; if (st.detail) body = detail(st.detail); else if (st.guide) body = guide(); else if (st.q && !st.adv) body = results(st); else { if (st.adv && st.q) { FS = queryToForm(st.q); FS.view = st.view; } else if (!FS || !st.adv) FS = emptyForm(); body = advForm(); }
  app.innerHTML = header(st) + `<main>${body}</main>` + footer();
  document.title = st.detail ? `${IDX.ents.find(x => x.kind === st.detail.kind && x.slug === st.detail.slug)?.name || 'VGC Dex'} · VGC Dex` : st.q ? `${st.q} · VGC Dex` : 'VGC Dex';
  bindForm();
  const f = $('#form'); if (f) f.addEventListener('submit', ev => { ev.preventDefault(); const v = $('#q').value.trim(); nav(v ? qlink(v) + (st.view !== 'grid' ? '&view=' + st.view : '') : ''); });
  const sort = $('#sort'); if (sort) sort.addEventListener('change', () => { let q = st.q.replace(/\s*\b(order|sort|dir|direction):\S+/g, '').trim(); if (sort.value) q += ' order:' + sort.value; nav(qlink(q) + (st.view !== 'grid' ? '&view=' + st.view : '')); });
  for (const id of ['random', 'random2']) { const el = $('#' + id); if (el) el.addEventListener('click', ev => { ev.preventDefault(); const sp = IDX.ents.filter(e => e.kind === 'species'); nav(plink(sp[Math.floor(Math.random() * sp.length)])); }); }
  const back = $('#back'); if (back) back.addEventListener('click', ev => { ev.preventDefault(); if (history.length > 1 && document.referrer !== '' || history.state === 'app') history.back(); else nav(''); });
  const th = $('#theme'); if (th) th.addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'light'; const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; try { localStorage.setItem('vgcdex-theme', nx); } catch (e) {} });
}
document.addEventListener('click', ev => { const a = ev.target.closest('a[data-nav]'); if (!a) return; const href = a.getAttribute('href'); if (!href || href.startsWith('#')) return; ev.preventDefault(); history.pushState('app', '', href === './' ? location.pathname : href); render(); window.scrollTo(0, 0); });
window.addEventListener('popstate', render);
window.VGCDEX = { search: q => search(IDX, q), parse, get idx() { return IDX; } };
fetch('data/m-c.json').then(r => r.json()).then(d => { IDX = buildIndex(d); IDX_ITEM_CATS = d.item_categories.slice(); render(); })
  .catch(err => { app.innerHTML = `<main class="wrap"><div class="notice error">Failed to load data: ${esc(err.message)}</div></main>`; });
})();
