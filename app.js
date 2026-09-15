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
      dex: s.national_dex, kg: s.weight_kg, sprite: s.sprites && s.sprites.menu, art: s.sprites && s.sprites.front, eff: effOf(s.types) };
    speciesBySlug[s.slug] = row; ents.push(row);
  }
  for (const m of d.mega_evolutions) {
    const base = speciesBySlug[m.base_slug];
    ents.push({ kind: 'species', slug: m.slug, name: m.name, raw: m, is_mega: true, base_slug: m.base_slug, stone: m.mega_stone,
      types: m.types, abilities: [m.ability.name], abilitySlugs: [m.ability.slug], learnset: base ? base.learnset : [],
      ps: m.presented_stats, bs: m.base_stats, bst: STATS.reduce((n, k) => n + m.base_stats[k], 0),
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
  ['t:steel spe>=100', 'Fast Steel types'], ['m:"iron head" m:"knock off"', 'Learns both moves'], ['m:/^(u-turn|volt switch|flip turn)$/', 'Any pivot move (regex)'],
  ['a:intimidate or a:prankster', 'Either ability'], ['weak:fairy -resists:steel', 'Fairy-weak, no Steel resist'], ['immune:ground is:mega', 'Megas immune to Ground'],
  ['t:fire bp>=80 cat:special', 'Special Fire moves'], ['prio>0 -cat:status order:bp', 'Damaging priority, by power'], ['o:/flinch/ kind:move', 'Moves whose text says flinch'],
  ['o:/heals?|restores?/ kind:ability', 'Healing abilities'], ['cat:berry o:/hp/', 'Berries mentioning HP'], ['bst>=600 -is:mega order:spe', '600-BST non-Megas by Speed']];
// ----- results -----
function statRow(e) { return `<span class="statrow">${STATS.map(k => `<b>${STAT_LABEL[k]}</b>${e.ps[k]}`).join('')}</span>`; }
function speciesCard(e) { return `<a class="card" href="${plink(e)}" data-nav><div class="art">${e.art ? `<img src="${e.art}" alt="" loading="lazy">` : ''}${e.is_mega ? '<span class="mega">Mega</span>' : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.types.map(typeChip).join('')}</div>${statRow(e)}</div></a>`; }
function speciesTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th></th><th>Name</th><th>Type</th>${STATS.map(k => `<th class="num">${STAT_LABEL[k]}</th>`).join('')}<th class="num">BST</th><th>Abilities</th></tr></thead><tbody>${rows.map(e => `<tr><td class="thumb"><img src="${e.sprite}" alt="" loading="lazy"></td><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a>${e.is_mega ? ' <span class="badge">Mega</span>' : ''}</td><td>${e.types.map(typeChip).join(' ')}</td>${STATS.map(k => `<td class="num">${e.ps[k]}</td>`).join('')}<td class="num">${e.bst}</td><td class="muted">${e.abilities.map(esc).join(', ')}</td></tr>`).join('')}</tbody></table></div>`; }
function moveTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Type</th><th>Cat</th><th class="num">BP</th><th class="num">Acc</th><th class="num">PP</th><th class="num">Prio</th><th>Effect</th></tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td>${typeChip(e.type)}</td><td>${catChip(e.cat)}</td><td class="num">${e.bp || '—'}</td><td class="num">${e.acc ?? '—'}</td><td class="num">${e.pp}</td><td class="num">${e.prio > 0 ? '+' : ''}${e.prio}</td><td class="muted">${esc(e.raw.short_desc || '')}</td></tr>`).join('')}</tbody></table></div>`; }
function abilityTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Effect</th><th class="num">Pokémon</th></tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td class="muted">${esc(e.raw.short_desc || '')}</td><td class="num">${IDX.ents.filter(x => x.kind === 'species' && x.abilitySlugs.includes(e.slug)).length}</td></tr>`).join('')}</tbody></table></div>`; }
function itemCard(e) { return `<a class="card item" href="${plink(e)}" data-nav><div class="art">${e.sprite ? `<img src="${e.sprite}" alt="" loading="lazy">` : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.cats.map(c => `<span class="chip neutral">${esc(c)}</span>`).join('')}</div><div class="muted small">${esc(e.raw.short_desc || e.raw.description || '')}</div></div></a>`; }
const SORTS = [['', 'Relevance'], ['name', 'Name'], ['dex', 'Dex #'], ['bst', 'BST'], ['spe', 'Speed'], ['atk', 'Attack'], ['spa', 'Sp. Atk'], ['def', 'Defense'], ['spd', 'Sp. Def'], ['hp', 'HP'], ['bp', 'Base power'], ['pp', 'PP'], ['prio', 'Priority']];
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
  if (!r.results.length) return controls + `<section class="wrap"><div class="notice zero"><b>No results.</b> The query parsed fine and was searched across ${scopeTxt}.<ul><li>Bare words match <b>names</b> only — use <code>o:</code> for description text.</li><li>Stats are presented values; use <code>bspe</code> etc. for base stats.</li><li><code>m:</code> wants a move name, e.g. <code>m:"iron head"</code>.</li></ul><p><a href="${qlink(q).replace('?q=', '?adv=1&q=')}" data-nav>Edit in advanced search</a></p></div></section>`;
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
function statTable(e) { const max = 255; return `<table class="stats"><tbody>${STATS.map(k => `<tr><th>${STAT_LABEL[k]}</th><td class="num">${e.ps[k]}</td><td class="bar"><i style="width:${Math.min(100, e.bs[k] / max * 100 * 1.6)}%"></i></td><td class="num muted">${e.bs[k]}</td></tr>`).join('')}<tr class="tot"><th>Total</th><td class="num">${STATS.reduce((n, k) => n + e.ps[k], 0)}</td><td></td><td class="num muted">${e.bst}</td></tr></tbody></table><p class="muted small">Presented (Level 50, 0 SP, neutral alignment) · <span class="muted">base</span></p>`; }
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
  <h2>Pokémon</h2>${T([['t: type:', 'has type — <code>t:steel t:fairy</code> both, <code>-t:water</code> neither, <code>t=steel/fairy</code> exactly'], ['a: ability:', 'has ability (any slot)'], ['m: move: learns:', 'learnset contains the move; repeat for AND'], ['hp atk def spa spd spe', 'presented stats (in-game Level 50 numbers)'], ['bhp batk bdef bspa bspd bspe', 'base stats'], ['bst', 'base-stat total'], ['weak: resists: immune:', 'from the type chart only'], ['is:mega  stone:  base:', 'Mega formes'], ['dex: kg: abilities:', 'National Dex number, weight, ability count']])}
  <h2>Moves</h2>${T([['t: cat:', 'type; physical / special / status'], ['bp: acc: pp: prio:', 'numbers — <code>bp>=80</code>, <code>prio>0</code>'], ['flag:', 'contact, protect, sound, punch, bite, pulse, bullet, slicing, wind, powder, …'], ['target:', 'spread, single, or Showdown target ids'], ['class:', 'Champions Classification — <code>class:punching</code>'], ['lb: learnedby:', 'moves a Pokémon learns'], ['is:spread is:variable', 'spread moves, variable-power moves']])}
  <h2>Abilities &amp; items</h2>${T([['o: desc: text:', 'description text — moves, abilities, items'], ['cat:', 'item category — berry, mega stone, recovery, …'], ['for:', 'Mega Stone for a Pokémon'], ['is:consumable is:held', 'item class']])}
  <h2>Scope, sort, kinds</h2>${T([['kind: is:', 'species, move, ability, item'], ['order: dir:', 'spe, bp, name, dex, bst, … · asc / desc']])}
  <p>A query's result kinds are the intersection of what its fields apply to: <code>t:fire spe>100</code> is Pokémon only; <code>t:fire bp>=80</code> is moves only; both together is an error, not an empty list. Regulation history (<code>r:</code>, <code>new:</code>, <code>removed:</code>) is not in this prototype.</p>
  <h2>Examples</h2><div class="ex-grid">${EXAMPLES.map(([q, why]) => `<a class="ex" href="${qlink(q)}" data-nav><code>${esc(q)}</code><span>${esc(why)}</span></a>`).join('')}</div></section>`;
}

// ---------- advanced search form (home page) ----------
const FLAG_LIST = ['contact', 'protect', 'sound', 'punch', 'bite', 'pulse', 'bullet', 'slicing', 'wind', 'powder', 'dance', 'heal', 'recharge', 'charge', 'reflectable', 'snatch', 'bypasssub', 'gravity', 'defrost', 'explosive', 'mental'];
const STAT_OPTS = [...STATS.map(k => [k, STAT_LABEL[k]]), ...STATS.map(k => ['b' + k, 'base ' + STAT_LABEL[k]]), ['bst', 'BST']];
const MNUM_OPTS = [['bp', 'Base power'], ['acc', 'Accuracy'], ['pp', 'PP'], ['prio', 'Priority']];
const OPS_UI = [['>=', '≥'], ['>', '>'], ['=', '='], ['<=', '≤'], ['<', '<'], ['!=', '≠']];
const quote = v => /[\s"():<>=!\/]/.test(v) || v === '' ? JSON.stringify(v) : v;
function emptyForm() { return { kinds: new Set(KINDS), name: '', text: '', types: {}, typeMode: 'all', ability: '', moves: [''], stats: [{ stat: 'spe', op: '>=', val: '' }], weak: '', resists: '', immune: '', mega: 'include', cats: new Set(), mnums: [{ stat: 'bp', op: '>=', val: '' }], flags: {}, target: 'any', cls: '', lb: '', icats: new Set(), iclass: 'any', view: 'grid', order: '', dir: '', also: [] }; }
function buildQuery(fs) {
  const t = [];
  const k = [...fs.kinds]; if (k.length === 1) t.push('kind:' + k[0]); else if (k.length === 2 || k.length === 3) t.push('(' + k.map(x => 'kind:' + x).join(' or ') + ')');
  if (fs.name.trim()) t.push(quote(fs.name.trim()));
  if (fs.text.trim()) t.push(/^\/.*\/$/.test(fs.text.trim()) ? 'o:' + fs.text.trim() : 'o:' + quote(fs.text.trim()));
  const inc = Object.keys(fs.types).filter(x => fs.types[x] === 1), exc = Object.keys(fs.types).filter(x => fs.types[x] === -1);
  if (inc.length) { if (fs.typeMode === 'exact') t.push('t=' + inc.slice(0, 2).join('/')); else if (fs.typeMode === 'any' && inc.length > 1) t.push('(' + inc.map(x => 't:' + x).join(' or ') + ')'); else inc.forEach(x => t.push('t:' + x)); }
  exc.forEach(x => t.push('-t:' + x));
  if (fs.ability.trim()) t.push('a:' + quote(fs.ability.trim()));
  fs.moves.filter(m => m.trim()).forEach(m => t.push('m:' + quote(m.trim())));
  fs.stats.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
  if (fs.weak) t.push('weak:' + fs.weak); if (fs.resists) t.push('resists:' + fs.resists); if (fs.immune) t.push('immune:' + fs.immune);
  if (fs.mega === 'only') t.push('is:mega'); else if (fs.mega === 'exclude') t.push('-is:mega');
  const c = [...fs.cats]; if (c.length === 1) t.push('cat:' + c[0]); else if (c.length === 2) t.push('(' + c.map(x => 'cat:' + x).join(' or ') + ')');
  fs.mnums.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
  for (const f of Object.keys(fs.flags)) if (fs.flags[f] === 1) t.push('flag:' + f); else if (fs.flags[f] === -1) t.push('-flag:' + f);
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
  const fs = emptyForm(); fs.moves = []; fs.stats = []; fs.mnums = [];
  let ast; try { ast = parse(q); } catch (e) { fs.also = [q]; return fs; }
  if (!ast) return fs;
  const items = ast.type === 'and' ? ast.items : [ast];
  const statKeys = new Set(STAT_OPTS.map(x => x[0])), mnumKeys = new Set(MNUM_OPTS.map(x => x[0]));
  const isCatVal = v => ['physical', 'special', 'status'].includes(norm(v));
  for (const it of items) {
    if (it.type === 'word') { fs.name = (fs.name + ' ' + it.v).trim(); continue; }
    if (it.type === 'or' && it.items.every(x => x.type === 'term' && x.op === ':' && !x.isRegex)) {
      const fields = new Set(it.items.map(x => F[x.field] && F[x.field].name)); const vals = it.items.map(x => x.val);
      if (fields.size === 1 && fields.has('kind') && vals.every(v => KINDS.includes(norm(v)))) { fs.kinds = new Set(vals.map(norm)); continue; }
      if (fields.size === 1 && fields.has('t') && vals.every(v => IDX.types.includes(norm(v)))) { vals.forEach(v => fs.types[norm(v)] = 1); fs.typeMode = 'any'; continue; }
      if (fields.size === 1 && fields.has('cat')) { if (vals.every(isCatVal)) { vals.forEach(v => fs.cats.add(norm(v))); continue; } if (vals.every(v => IDX_ITEM_CATS.map(norm).includes(norm(v)))) { vals.forEach(v => fs.icats.add(IDX_ITEM_CATS.find(c => norm(c) === norm(v)))); continue; } }
      fs.also.push(astText(it)); continue; }
    const neg = it.type === 'not'; const tm = neg ? it.node : it;
    if (tm.type !== 'term' || !F[tm.field]) { fs.also.push(astText(it)); continue; }
    const f = F[tm.field].name, v = tm.val, vn = norm(v);
    if (tm.isRegex && f !== 'o') { fs.also.push(astText(it)); continue; }
    if (neg) { if (f === 't' && tm.op === ':' && IDX.types.includes(vn)) fs.types[vn] = -1; else if (f === 'flag' && tm.op === ':') fs.flags[vn] = -1; else if (f === 'is' && vn === 'mega') fs.mega = 'exclude'; else fs.also.push(astText(it)); continue; }
    if (f === 'kind' && KINDS.includes(vn)) fs.kinds = new Set([vn]);
    else if (f === 'name' && (tm.op === ':')) fs.name = (fs.name + ' ' + v).trim();
    else if (f === 'o' && tm.op === ':') fs.text = tm.isRegex ? '/' + v + '/' : v;
    else if (f === 't' && tm.op === '=' && v.split(/[\/,+]/).every(x => IDX.types.includes(norm(x)))) { v.split(/[\/,+]/).forEach(x => fs.types[norm(x)] = 1); fs.typeMode = 'exact'; }
    else if (f === 't' && tm.op === ':' && IDX.types.includes(vn)) { fs.types[vn] = 1; if (fs.typeMode === 'any') fs.typeMode = 'all'; }
    else if (f === 'a' && tm.op === ':') fs.ability = v;
    else if (f === 'm' && tm.op === ':') fs.moves.push(v);
    else if (statKeys.has(f) && tm.op !== ':') fs.stats.push({ stat: f, op: tm.op, val: v });
    else if (mnumKeys.has(f) && tm.op !== ':') fs.mnums.push({ stat: f, op: tm.op, val: v });
    else if (['weak', 'resists', 'immune'].includes(f) && tm.op === ':' && IDX.types.includes(vn)) fs[f] = vn;
    else if (f === 'is' && vn === 'mega') fs.mega = 'only';
    else if (f === 'is' && (vn === 'consumable' || vn === 'held')) fs.iclass = vn;
    else if (f === 'is' && vn === 'spread') fs.target = 'spread';
    else if (f === 'cat' && tm.op === ':' && isCatVal(v)) fs.cats.add(vn);
    else if (f === 'cat' && tm.op === ':' && IDX_ITEM_CATS.map(norm).includes(vn)) fs.icats.add(IDX_ITEM_CATS.find(c => norm(c) === vn));
    else if (f === 'flag' && tm.op === ':') fs.flags[vn] = 1;
    else if (f === 'target' && tm.op === ':' && ['spread', 'single'].includes(vn)) fs.target = vn;
    else if (f === 'class' && tm.op === ':') fs.cls = IDX.classes.find(c => norm(c) === vn) || v;
    else if (f === 'lb' && tm.op === ':') fs.lb = v;
    else if (f === 'order' && tm.op === ':') fs.order = vn;
    else if (f === 'dir' && tm.op === ':') fs.dir = vn;
    else fs.also.push(astText(it));
  }
  if (!fs.moves.length) fs.moves = ['']; if (!fs.stats.length) fs.stats = [{ stat: 'spe', op: '>=', val: '' }]; if (!fs.mnums.length) fs.mnums = [{ stat: 'bp', op: '>=', val: '' }];
  return fs;
}
let FS = null;
function tri(field, v, label, cls) { const st = (field === 't' ? FS.types : FS.flags)[v] || 0; return `<button type="button" class="tri ${cls || ''} s${st}" data-tri="${field}" data-v="${v}" aria-pressed="${st !== 0}">${label}</button>`; }
function numRow(kind, r, i, opts) { return `<div class="nrow" data-row="${kind}" data-i="${i}"><select data-f="stat">${opts.map(([v, l]) => `<option value="${v}" ${v === r.stat ? 'selected' : ''}>${l}</option>`).join('')}</select><select data-f="op">${OPS_UI.map(([v, l]) => `<option value="${v}" ${v === r.op ? 'selected' : ''}>${l}</option>`).join('')}</select><input type="number" data-f="val" value="${esc(r.val)}" placeholder="0"><button type="button" class="rm" data-rm="${kind}" data-i="${i}" aria-label="Remove">×</button></div>`; }
function moveRow(m, i) { return `<div class="nrow" data-row="moves" data-i="${i}"><input type="text" data-f="val" list="dl-moves" value="${esc(m)}" placeholder="e.g. Iron Head"><button type="button" class="rm" data-rm="moves" data-i="${i}" aria-label="Remove">×</button></div>`; }
function typeSelect(name, val) { return `<select data-fs="${name}"><option value="">—</option>${IDX.types.map(t => `<option value="${t}" ${t === val ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>`; }
function advForm() {
  const fs = FS; const row = (label, ctl, help) => `<div class="frow"><label>${label}</label><div class="fctl">${ctl}${help ? `<small>${help}</small>` : ''}</div></div>`;
  const kindsOn = k => fs.kinds.has(k);
  return `<section class="wrap adv"><div class="qline"><span>Query</span><code id="qpreview"></code><a href="#" id="qopen" title="Open results">Search →</a></div>
  <form id="adv">
  <h2>Search</h2>
  ${row('Kinds', KINDS.map(k => `<label class="cb"><input type="checkbox" data-kind="${k}" ${kindsOn(k) ? 'checked' : ''}> ${KIND_LABEL[k]}</label>`).join(''), 'Which kinds of results to include. Sections below follow this.')}
  ${row('Name', `<input type="text" data-fs="name" value="${esc(fs.name)}" placeholder="e.g. Garchomp, iron head">`, 'Words that appear in the name. Matches every kind.')}
  ${row('Text', `<input type="text" data-fs="text" value="${esc(fs.text)}" placeholder='e.g. flinch, or /heals?|restores?/'>`, 'Words in the description of a move, ability or item. Wrap in slashes for a regex.')}
  <div class="sec" data-kind="species" ${kindsOn('species') ? '' : 'hidden'}><h2>Pokémon</h2>
  ${row('Type', `<div class="tris">${IDX.types.map(t => tri('t', t, t, 'type-' + t)).join('')}</div><div class="inline"><select data-fs="typeMode"><option value="all" ${fs.typeMode === 'all' ? 'selected' : ''}>has all of these</option><option value="any" ${fs.typeMode === 'any' ? 'selected' : ''}>has any of these</option><option value="exact" ${fs.typeMode === 'exact' ? 'selected' : ''}>exactly these types</option></select></div>`, 'Click a type once to require it, twice to exclude it, again to clear.')}
  ${row('Ability', `<input type="text" data-fs="ability" list="dl-abilities" value="${esc(fs.ability)}" placeholder="e.g. Intimidate">`, 'Has this ability in any slot.')}
  ${row('Learns', `<div id="moves-rows">${fs.moves.map(moveRow).join('')}</div><button type="button" class="add" data-add="moves">+ add another move</button>`, 'Every listed move must be in the learnset.')}
  ${row('Stats', `<div id="stats-rows">${fs.stats.map((r, i) => numRow('stats', r, i, STAT_OPTS)).join('')}</div><button type="button" class="add" data-add="stats">+ add another stat</button>`, 'Presented stats are the in-game Level 50 numbers; "base" rows use base stats.')}
  ${row('Defence', `<div class="inline"><span>Weak to</span>${typeSelect('weak', fs.weak)}<span>Resists</span>${typeSelect('resists', fs.resists)}<span>Immune to</span>${typeSelect('immune', fs.immune)}</div>`, 'From the type chart only; abilities such as Levitate are not applied.')}
  ${row('Mega formes', ['include', 'only', 'exclude'].map(v => `<label class="cb"><input type="radio" name="mega" data-fs="mega" value="${v}" ${fs.mega === v ? 'checked' : ''}> ${v[0].toUpperCase() + v.slice(1)}</label>`).join(''), '')}
  </div>
  <div class="sec" data-kind="move" ${kindsOn('move') ? '' : 'hidden'}><h2>Moves</h2>
  ${row('Category', ['physical', 'special', 'status'].map(c => `<label class="cb"><input type="checkbox" data-cat="${c}" ${fs.cats.has(c) ? 'checked' : ''}> ${c[0].toUpperCase() + c.slice(1)}</label>`).join(''), '')}
  ${row('Numbers', `<div id="mnums-rows">${fs.mnums.map((r, i) => numRow('mnums', r, i, MNUM_OPTS)).join('')}</div><button type="button" class="add" data-add="mnums">+ add another</button>`, 'Base power, accuracy, PP (Champions values), priority.')}
  ${row('Flags', `<div class="tris">${FLAG_LIST.map(f => tri('flag', f, f)).join('')}</div>`, 'Once to require, twice to exclude.')}
  ${row('Target', `<select data-fs="target">${[['any', 'Any'], ['spread', 'Spread (hits multiple)'], ['single', 'Single target']].map(([v, l]) => `<option value="${v}" ${fs.target === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, '')}
  ${row('Classification', `<select data-fs="cls"><option value="">Any</option>${IDX.classes.map(c => `<option value="${esc(c)}" ${fs.cls === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`, 'Champions move Classifications.')}
  ${row('Learned by', `<input type="text" data-fs="lb" list="dl-species" value="${esc(fs.lb)}" placeholder="e.g. Garchomp">`, 'Only moves this Pokémon learns.')}
  </div>
  <div class="sec" data-kind="item" ${kindsOn('item') ? '' : 'hidden'}><h2>Items</h2>
  ${row('Category', IDX_ITEM_CATS.map(c => `<label class="cb"><input type="checkbox" data-icat="${esc(c)}" ${fs.icats.has(c) ? 'checked' : ''}> ${esc(c)}</label>`).join(''), '')}
  ${row('Class', ['any', 'consumable', 'held'].map(v => `<label class="cb"><input type="radio" name="iclass" data-fs="iclass" value="${v}" ${fs.iclass === v ? 'checked' : ''}> ${v[0].toUpperCase() + v.slice(1)}</label>`).join(''), '')}
  </div>
  <h2>Display</h2>
  ${row('Show as', ['grid', 'list'].map(v => `<label class="cb"><input type="radio" name="view" data-fs="view" value="${v}" ${fs.view === v ? 'checked' : ''}> ${v[0].toUpperCase() + v.slice(1)}</label>`).join(''), 'Grid shows Pokémon as cards; list shows a table.')}
  ${row('Sort by', `<div class="inline"><select data-fs="order">${SORTS.map(([v, l]) => `<option value="${v}" ${v === fs.order ? 'selected' : ''}>${l}</option>`).join('')}</select><select data-fs="dir"><option value="">Default order</option><option value="desc" ${fs.dir === 'desc' ? 'selected' : ''}>Descending</option><option value="asc" ${fs.dir === 'asc' ? 'selected' : ''}>Ascending</option></select></div>`, '')}
  <div class="frow also" ${fs.also.length ? '' : 'hidden'}><label>Also</label><div class="fctl"><code id="also">${esc(fs.also.join(' '))}</code><small>Terms from the typed query that this form has no control for. They stay in the search.</small></div></div>
  <div class="frow"><label></label><div class="fctl actions"><button type="submit" class="primary" id="go">Search with these options</button><button type="button" id="reset">Reset</button><a href="?guide=1" data-nav class="tryex">Syntax guide &amp; examples</a></div></div>
  </form>
  <datalist id="dl-abilities">${IDX.ents.filter(e => e.kind === 'ability').map(e => `<option value="${esc(e.name)}">`).join('')}</datalist>
  <datalist id="dl-moves">${IDX.ents.filter(e => e.kind === 'move').map(e => `<option value="${esc(e.name)}">`).join('')}</datalist>
  <datalist id="dl-species">${IDX.ents.filter(e => e.kind === 'species' && !e.is_mega).map(e => `<option value="${esc(e.name)}">`).join('')}</datalist>
  </section>`;
}
function readForm() {
  const f = $('#adv'); if (!f) return; const fs = FS;
  fs.kinds = new Set([...f.querySelectorAll('[data-kind]')].filter(x => x.checked).map(x => x.dataset.kind));
  for (const el of f.querySelectorAll('[data-fs]')) { if (el.type === 'radio') { if (el.checked) fs[el.dataset.fs] = el.value; } else fs[el.dataset.fs] = el.value; }
  fs.cats = new Set([...f.querySelectorAll('[data-cat]')].filter(x => x.checked).map(x => x.dataset.cat));
  fs.icats = new Set([...f.querySelectorAll('[data-icat]')].filter(x => x.checked).map(x => x.dataset.icat));
  for (const kind of ['moves', 'stats', 'mnums']) { const rows = [...f.querySelectorAll(`[data-row="${kind}"]`)]; fs[kind] = rows.map(r => kind === 'moves' ? r.querySelector('[data-f=val]').value : { stat: r.querySelector('[data-f=stat]').value, op: r.querySelector('[data-f=op]').value, val: r.querySelector('[data-f=val]').value }); }
  for (const sec of f.querySelectorAll('.sec[data-kind]')) sec.hidden = !fs.kinds.has(sec.dataset.kind);
  updatePreview();
}
function updatePreview() { const q = buildQuery(FS); const p = $('#qpreview'); if (p) p.textContent = q || '(empty)'; const go = $('#go'); if (go) go.disabled = !q; const o = $('#qopen'); if (o) o.hidden = !q; }
function submitForm() { readForm(); const q = buildQuery(FS); if (!q) return; nav(qlink(q) + (FS.view === 'list' ? '&view=list' : '')); }
function bindForm() {
  const f = $('#adv'); if (!f) return; updatePreview();
  f.addEventListener('input', readForm); f.addEventListener('change', readForm);
  f.addEventListener('click', ev => {
    const t = ev.target.closest('[data-tri]'); if (t) { const map = t.dataset.tri === 't' ? FS.types : FS.flags; const cur = map[t.dataset.v] || 0; const nx = cur === 0 ? 1 : cur === 1 ? -1 : 0; if (nx) map[t.dataset.v] = nx; else delete map[t.dataset.v]; t.className = t.className.replace(/\bs-?\d\b/, 's' + nx); t.setAttribute('aria-pressed', nx !== 0); updatePreview(); return; }
    const add = ev.target.closest('[data-add]'); if (add) { readForm(); const k = add.dataset.add; FS[k].push(k === 'moves' ? '' : { stat: k === 'stats' ? 'spe' : 'bp', op: '>=', val: '' }); rerenderRows(k); return; }
    const rm = ev.target.closest('[data-rm]'); if (rm) { readForm(); const k = rm.dataset.rm; FS[k].splice(Number(rm.dataset.i), 1); if (!FS[k].length) FS[k].push(k === 'moves' ? '' : { stat: k === 'stats' ? 'spe' : 'bp', op: '>=', val: '' }); rerenderRows(k); return; }
  });
  f.addEventListener('submit', ev => { ev.preventDefault(); submitForm(); });
  $('#reset').addEventListener('click', () => { FS = emptyForm(); history.replaceState('app', '', location.pathname); render(); });
  $('#qopen').addEventListener('click', ev => { ev.preventDefault(); submitForm(); });
}
function rerenderRows(k) { const box = $('#' + k + '-rows'); box.innerHTML = k === 'moves' ? FS.moves.map(moveRow).join('') : FS[k].map((r, i) => numRow(k, r, i, k === 'stats' ? STAT_OPTS : MNUM_OPTS)).join(''); updatePreview(); }

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
