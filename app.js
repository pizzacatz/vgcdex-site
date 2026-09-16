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
  const abilityBySlug = {};
  const moveBySlug = {};
  for (const m of d.moves) { const r = { kind: 'move', slug: m.slug, name: m.name, raw: m, type: m.type, cat: m.category, bp: m.power || 0,
    acc: m.accuracy === true || m.accuracy == null ? null : m.accuracy, pp: m.pp, prio: m.priority, target: m.target, flags: m.flags || [],
    classes: m.classifications || [], variable: !!m.variable_power, text: (m.short_desc || '') + ' ' + (m.long_desc || '') }; moveBySlug[m.slug] = r; ents.push(r); }
  for (const a of d.abilities) { const r = { kind: 'ability', slug: a.slug, name: a.name, raw: a, text: (a.short_desc || '') + ' ' + (a.long_desc || '') }; abilityBySlug[a.slug] = r; ents.push(r); }
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
  return { ents, types, learnedBy, moveBySlug, abilityBySlug, speciesBySlug, itemCats, classes, meta: { regulation: d.regulation, data_revision: d.data_revision, data_version: d.data_version } };
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
        else if (src[j] === '(') { let k = j + 1, depth = 1, inq = false; while (k < n && depth) { const c2 = src[k]; if (c2 === '"') inq = !inq; else if (!inq && c2 === '(') depth++; else if (!inq && c2 === ')') depth--; k++; } if (depth) throw new QueryError('syntax', 'Unclosed sub-query: missing closing )', [j, n]); val = src.slice(j + 1, k - 1); var isSub = true; j = k; toks.push({ t: 'term', field: fname.toLowerCase(), op, val, isRegex: false, isSub: true, quoted: false, s: start, e: j }); i = j; continue; }
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
  const spanOf = items => [items[0].span ? items[0].span[0] : 0, items[items.length - 1].span ? items[items.length - 1].span[1] : src.length];
  function expr() { const items = [andExpr()]; while (peek() && peek().t === 'or') { next(); items.push(andExpr()); } return items.length === 1 ? items[0] : { type: 'or', items, span: spanOf(items) }; }
  function andExpr() { const items = []; while (peek() && peek().t !== 'or' && peek().t !== ')') items.push(unary()); if (!items.length) throw new QueryError('syntax', 'Expected a term', peek() ? [peek().s, peek().e] : [src.length, src.length]); return items.length === 1 ? items[0] : { type: 'and', items, span: spanOf(items) }; }
  function unary() { if (peek().t === 'not') { const tk = next(); if (!peek() || peek().t === ')' || peek().t === 'or') throw new QueryError('syntax', 'Nothing after "-"', [tk.s, tk.e]); const inner = unary(); return { type: 'not', node: inner, span: [tk.s, inner.span ? inner.span[1] : tk.e] }; } return primary(); }
  function primary() { const tk = next();
    if (tk.t === '(') { const e = expr(); if (!peek() || peek().t !== ')') throw new QueryError('syntax', 'Missing closing ")"', [tk.s, tk.e]); next(); return e; }
    if (tk.t === ')') throw new QueryError('syntax', 'Unexpected ")"', [tk.s, tk.e]);
    if (tk.t === 'word') return { type: 'word', v: tk.v, span: [tk.s, tk.e] };
    if (tk.t === 'term') { const node = { type: 'term', ...tk, span: [tk.s, tk.e] }; if (tk.isSub) { let sub; try { sub = parse(tk.val); } catch (e) { if (e instanceof QueryError) throw new QueryError(e.kind, 'Inside ' + tk.field + ':( ): ' + e.message, node.span); throw e; } if (!sub) throw new QueryError('syntax', tk.field + ':( ) is empty', node.span); node.sub = sub; } return node; }
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
  if (node.sub) { if (f.name !== 'm' && f.name !== 'lb' && f.name !== 'a') throw new QueryError('syntax', `Only m:( ), a:( ) and lb:( ) take a sub-query, not "${node.field}"`, node.span); if (node.op !== ':') throw new QueryError('syntax', `${node.field}:( ) uses ":"`, node.span);
    let sc; try { sc = validate(node.sub, idx, {}); } catch (e) { if (e instanceof QueryError) throw new QueryError(e.kind, 'Inside ' + node.field + ':( ): ' + e.message, node.span); throw e; }
    const need = f.name === 'm' ? 'move' : f.name === 'a' ? 'ability' : 'species'; if (!sc.has(need)) throw new QueryError('semantic', `${node.field}:( ) must describe ${need === 'move' ? 'moves' : need === 'ability' ? 'abilities' : 'Pokémon'}; its fields apply to ${[...sc].join('/') || 'nothing'}`, node.span); node.subKind = need; return new Set(f.kinds); }
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
      if (node.sub) { if (f.name === 'm') return e.learnset.some(sl => { const mv = idx.moveBySlug[sl]; return mv && evalNode(node.sub, mv, idx); }); if (f.name === 'a') return e.abilitySlugs.some(sl => { const ab = idx.abilityBySlug[sl]; return ab && evalNode(node.sub, ab, idx); }); return (idx.learnedBy[e.slug] || []).some(sp => evalNode(node.sub, sp, idx)); }
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
  const subs = []; (function walk(n, neg) { if (!n) return; if (n.type === 'term' && n.sub && !neg) subs.push(n); else if (n.type === 'not') walk(n.node, !neg); else if (n.items) n.items.forEach(x => walk(x, neg)); })(ast);
  return { scope: [...scope], results: out, ast, order, dir, subs };
}
function subMatches(subs, e, idx) { const out = []; for (const n of subs) { if (F[n.field].name === 'a' && e.kind === 'species') { for (const sl of e.abilitySlugs) { const ab = idx.abilityBySlug[sl]; if (ab && evalNode(n.sub, ab, idx) && !out.includes(ab)) out.push(ab); } continue; } if (F[n.field].name === 'm' && e.kind === 'species') for (const sl of e.learnset) { const mv = idx.moveBySlug[sl]; if (mv && evalNode(n.sub, mv, idx) && !out.includes(mv)) out.push(mv); } else if (F[n.field].name === 'lb' && e.kind === 'move') for (const sp of (idx.learnedBy[e.slug] || [])) if (evalNode(n.sub, sp, idx) && !out.includes(sp)) out.push(sp); } return out; }

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
    ${compact ? `<form class="topsearch" id="form"><input id="q" type="search" value="${esc(st.q)}" placeholder='Search Pokémon, moves, abilities, items…' spellcheck="false" autocomplete="off" autocapitalize="off"><button type="submit" aria-label="Search">⌕</button><div class="tok-menu mainmenu" id="mainmenu" hidden></div></form>` : ''}
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
  ['t:steel spe>=100', 'Fast Steel types'], ['xweak:ice t:dragon', 'Dragons 4× weak to Ice'], ['m:"iron head" m:"knock off"', 'Learns both moves'], ['m:/^(u-turn|volt switch|flip turn)$/', 'Any pivot move (regex)'], ['t:fire spe>85 m:(t:rock cat:physical)', 'Fire types over 85 Speed with a physical Rock move'],
  ['a:intimidate or a:prankster', 'Either ability'], ['weak:fairy -resists:steel', 'Fairy-weak, no Steel resist'], ['immune:ground is:mega', 'Megas immune to Ground'],
  ['t:fire bp>=80 cat:special', 'Special Fire moves'], ['prio>0 -cat:status order:bp', 'Damaging priority, by power'], ['o:/flinch/ kind:move', 'Moves whose text says flinch'],
  ['o:/heals?|restores?/ kind:ability', 'Healing abilities'], ['cat:berry o:/hp/', 'Berries mentioning HP'], ['total>=775 -is:mega order:spe', '775+ total non-Megas by Speed']];
// ----- results -----
function statRow(e) { return `<span class="statrow">${STATS.map(k => `<b>${STAT_LABEL[k]}</b>${e.ps[k]}`).join('')}</span>`; }
let SUBS = [];
function matchLine(e) { if (!SUBS.length) return ''; const m = subMatches(SUBS, e, IDX); if (!m.length) return ''; return `<div class="matchline">${m.slice(0, 8).map(x => x.kind === 'move' ? `<span class="mc type-${x.type}">${esc(x.name)}</span>` : `<span class="chip neutral">${esc(x.name)}</span>`).join('')}${m.length > 8 ? `<span class="muted small">+${m.length - 8}</span>` : ''}</div>`; }
function speciesCard(e) { return `<a class="card" href="${plink(e)}" data-nav><div class="art">${e.art ? `<img src="${e.art}" alt="" loading="lazy">` : ''}${e.is_mega ? '<span class="mega">Mega</span>' : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.types.map(typeChip).join('')}</div>${statRow(e)}${matchLine(e)}</div></a>`; }
function speciesTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th></th><th>Name</th><th>Type</th>${STATS.map(k => `<th class="num">${STAT_LABEL[k]}</th>`).join('')}<th class="num">Total</th><th>Abilities</th>${SUBS.length ? '<th>Matching moves</th>' : ''}</tr></thead><tbody>${rows.map(e => `<tr><td class="thumb"><img src="${e.sprite}" alt="" loading="lazy"></td><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a>${e.is_mega ? ' <span class="badge">Mega</span>' : ''}</td><td>${e.types.map(typeChip).join(' ')}</td>${STATS.map(k => `<td class="num">${e.ps[k]}</td>`).join('')}<td class="num">${e.total}</td><td class="muted">${e.abilities.map(esc).join(', ')}</td>${SUBS.length ? `<td>${matchLine(e)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`; }
function moveTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Type</th><th>Cat</th><th class="num">BP</th><th class="num">Acc</th><th class="num">PP</th><th class="num">Prio</th><th>Effect</th>${SUBS.length ? '<th>Learned by</th>' : ''}</tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td>${typeChip(e.type)}</td><td>${catChip(e.cat)}</td><td class="num">${e.bp || '—'}</td><td class="num">${e.acc ?? '—'}</td><td class="num">${e.pp}</td><td class="num">${e.prio > 0 ? '+' : ''}${e.prio}</td><td class="muted">${esc(e.raw.short_desc || '')}</td>${SUBS.length ? `<td>${matchLine(e)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`; }
function abilityTable(rows) { return `<div class="tablewrap"><table class="list"><thead><tr><th>Name</th><th>Effect</th><th class="num">Pokémon</th></tr></thead><tbody>${rows.map(e => `<tr><td><a href="${plink(e)}" data-nav>${esc(e.name)}</a></td><td class="muted">${esc(e.raw.short_desc || '')}</td><td class="num">${IDX.ents.filter(x => x.kind === 'species' && x.abilitySlugs.includes(e.slug)).length}</td></tr>`).join('')}</tbody></table></div>`; }
function itemCard(e) { return `<a class="card item" href="${plink(e)}" data-nav><div class="art">${e.sprite ? `<img src="${e.sprite}" alt="" loading="lazy">` : ''}</div><div class="card-body"><div class="card-name">${esc(e.name)}</div><div class="chips">${e.cats.map(c => `<span class="chip neutral">${esc(c)}</span>`).join('')}</div><div class="muted small">${esc(e.raw.short_desc || e.raw.description || '')}</div></div></a>`; }
const SORTS = [['', 'Relevance'], ['name', 'Name'], ['dex', 'Dex #'], ['hp', 'HP'], ['atk', 'Attack'], ['def', 'Defense'], ['spa', 'Special Attack'], ['spd', 'Special Defense'], ['spe', 'Speed'], ['total', 'Total'], ['bp', 'Base Power'], ['acc', 'Accuracy'], ['pp', 'PP'], ['prio', 'Priority']];
function results(st) {
  const q = st.q; let r;
  try { r = search(IDX, q); }
  catch (err) { if (!(err instanceof QueryError)) throw err; const [s, e] = err.span || [0, 0];
    return `<section class="wrap"><div class="notice error"><b>${err.kind === 'syntax' ? 'Syntax error' : 'Scope error'}.</b> ${esc(err.message)}<pre><code>${esc(q.slice(0, s))}<mark>${esc(q.slice(s, e) || ' ')}</mark>${esc(q.slice(e))}</code></pre>${err.kind === 'semantic' ? '<p>Add <code>kind:species</code> or <code>kind:move</code>, or split it into two searches.</p>' : '<p>See the <a href="?guide=1" data-nav>syntax guide</a>.</p>'}<p><a href="${qlink(q).replace('?q=', '?adv=1&q=')}" data-nav>Edit in advanced search</a></p></div></section>`; }
  SUBS = r.subs || [];
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
      <div class="toolbox"><h3>Toolbox</h3><a href="${qlink('m=' + JSON.stringify(e.name))}" data-nav>Pokémon that learn it (search)</a><a href="${qlink('m=' + JSON.stringify(e.name) + ' order:spe')}" data-nav>…fastest first</a><a href="${qlink('t:' + e.type + ' cat:' + e.cat + ' order:bp')}" data-nav>Other ${e.type} ${e.cat} moves</a>${e.flags.filter(f => MECH_LABEL[f]).slice(0, 4).map(f => `<a href="${qlink('flag:' + f)}" data-nav>All moves: ${esc(MECH_LABEL[f])}</a>`).join('')}</div></div>
      <div class="page-main"><h1>${esc(e.name)}</h1><p>${esc(e.raw.long_desc || e.raw.short_desc || '')}</p><p class="muted">Target: ${esc(e.target)}${e.variable ? ' · variable power' : ''}</p>${e.classes.length ? `<h3>Classifications</h3><div class="chips">${e.classes.map(c => { const id = Object.keys(CLASS_BY_FLAG).find(k => CLASS_BY_FLAG[k] === c); return `<a href="${qlink('class:' + quote(c))}" data-nav class="chip neutral" title="${esc(id && CLASS_NOTE[id] || '')}">${esc(c)}</a>`; }).join('')}</div>` : ''}${e.flags.some(f => MECH_LABEL[f]) ? `<h3>Properties</h3><ul class="plain props">${e.flags.filter(f => MECH_LABEL[f]).map(f => `<li><a href="${qlink('flag:' + f)}" data-nav>${esc(MECH_LABEL[f])}</a></li>`).join('')}</ul>` : ''}
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
  <h2>Pokémon</h2>${T([['a:( … )', 'has an ability matching an ability query — <code>a:(o:/weather/)</code>; the Abilities picker takes a bare <code>/weather/</code> as shorthand'], ['t: type:', 'has type — <code>t:steel t:fairy</code> both, <code>-t:water</code> neither, <code>t=steel/fairy</code> exactly'], ['a: ability:', 'has ability (any slot)'], ['m: move: learns:', 'learnset contains the move; repeat for AND'], ['m:( … )', 'learns <b>a</b> move matching a move query — <code>m:(t:rock cat:physical)</code>, <code>m:(prio>0 -cat:status)</code>; matching moves are shown on results'], ['hp atk def spa spd spe', 'in-game stats at Level 50 (0 Stat Points, neutral alignment)'], ['total', 'sum of the six stats'], ['weak: xweak: resists: xresists: immune:', 'takes ≥2× / 4× / ≤½× / ¼× / 0× from a type — type chart only'], ['is:mega  stone:  base:', 'Mega formes'], ['dex: kg: abilities:', 'National Dex number, weight, ability count']])}
  <h2>Moves</h2>${T([['t: cat:', 'type; physical / special / status'], ['bp: acc: pp: prio:', 'numbers — <code>bp>=80</code>, <code>prio>0</code>'], ['class:', 'one of the game’s 12 Classifications — <code>class:punching</code>, <code>class:"Ball & Bomb"</code>'], ['flag:', 'other move properties by id — <code>flag:contact</code> (makes contact), <code>flag:protect</code> (can be blocked by Protect), <code>flag:bypasssub</code>, <code>flag:reflectable</code>, <code>flag:gravity</code>, <code>flag:recharge</code>, <code>flag:charge</code>…'], ['target:', 'spread, single, or Showdown target ids'], ['lb: learnedby:', 'moves a Pokémon learns'], ['lb:( … )', 'moves learned by <b>any</b> Pokémon matching a Pokémon query — <code>lb:(t:fire spe>85)</code>'], ['is:spread is:variable', 'spread moves, variable-power moves']])}
  <h2>Abilities &amp; items</h2>${T([['o: desc: text:', 'description text — moves, abilities, items'], ['cat:', 'item category — berry, mega stone, recovery, …'], ['for:', 'Mega Stone for a Pokémon'], ['is:consumable is:held', 'item class']])}
  <h2 id="subquery">Learns a move matching…</h2><p>On the advanced search, the boxes under <b>Learns</b> take a <em>move query</em>: the Pokémon matches when at least one move in its learnset satisfies every part of it. In the search bar the same thing is written <code>m:( … )</code>.</p>${T([['t:rock cat:physical', 'a physical Rock move'], ['t:rock cat:physical bp>=75', '…with 75+ base power'], ['(t:rock or t:ground) cat:physical acc>=90', 'Rock or Ground, physical, 90%+ accuracy'], ['prio>0 -cat:status', 'a damaging priority move'], ['flag:contact target:spread', 'a contact spread move'], ['class:punching', 'a Punching move'], ['o:/flinch/', 'a move whose text mentions flinch']])}<p>Fields that describe Pokémon (Speed, abilities, matchups…) are not allowed inside. Two expressions are two conditions that different moves may satisfy. Results show which moves matched. The same works for abilities — <code>a:(o:/weather/)</code>, or just <code>/weather/</code> in the Abilities picker — and in reverse for move searches: <code>lb:(t:fire spe>85)</code>.</p>
  <h2>Scope, sort, kinds</h2>${T([['kind: is:', 'species, move, ability, item'], ['order: dir:', 'spe, bp, name, dex, total, … · asc / desc']])}
  <p>A query's result kinds are the intersection of what its fields apply to: <code>t:fire spe>100</code> is Pokémon only; <code>t:fire bp>=80</code> is moves only; both together is an error, not an empty list. Regulation history (<code>r:</code>, <code>new:</code>, <code>removed:</code>) is not in this prototype.</p>
  <h2>Examples</h2><div class="ex-grid">${EXAMPLES.map(([q, why]) => `<a class="ex" href="${qlink(q)}" data-nav><code>${esc(q)}</code><span>${esc(why)}</span></a>`).join('')}</div></section>`;
}

// ---------- advanced search form (home page) — Scryfall /advanced structure ----------
// Move properties. Classifications = the game's own 12 labels (classification table, kind=classification), keyed by Showdown flag id.
const CLASS_BY_FLAG = { bullet: 'Ball & Bomb', bite: 'Biting', dance: 'Dance', explosive: 'Explosive', heal: 'Healing', mental: 'Mental', powder: 'Powder', pulse: 'Pulse', punch: 'Punching', slicing: 'Slicing', sound: 'Sound-Based', wind: 'Wind' };
const CLASS_NOTE = { explosive: 'Champions-native. Explosion, Self-Destruct and Misty Explosion only (Healing Wish tested negative). Damp prevents these.', mental: 'Champions-native. Taunt, Attract, Encore, Disable, Torment. No item or ability reads this — Mental Herb keys on the condition, not the move.' };
// Mechanical properties: live in Champions, unlabelled in-game (kind=mechanical). Internal/inert flags are deliberately absent
// (incl. `metronome` = "can be called by the move Metronome", which is not legal in M-C — corrected 2026-09-16).
const MECH = [['contact', 'Makes contact'], ['protect', 'Can be blocked by Protect'], ['bypasssub', 'Hits through Substitute'], ['reflectable', 'Can be reflected by Magic Bounce'], ['gravity', 'Disabled under Gravity'], ['defrost', 'Thaws a frozen user'], ['charge', 'Two-turn, charges first'], ['recharge', 'Must recharge next turn'], ['cantusetwice', 'Can’t be used twice in a row'], ['futuremove', 'Delayed strike, like Future Sight'], ['minimize', 'Double damage against Minimize'], ['mustpressure', 'Loses extra PP to Pressure'], ['noparentalbond', 'Not doubled by Parental Bond'], ['nosleeptalk', 'Can’t be called by Sleep Talk'], ['failcopycat', 'Can’t be copied by Copycat'], ['failencore', 'Can’t be locked in by Encore'], ['failinstruct', 'Can’t be repeated by Instruct']];
const MECH_LABEL = Object.fromEntries(MECH);
const FLAG_LIST = MECH.map(m => m[0]);
// picker entries: value 'c:<flag>' for a Classification, 'f:<flag>' for a mechanical property
const PROP_ITEMS = () => [...Object.entries(CLASS_BY_FLAG).sort((a, b) => a[1].localeCompare(b[1])).map(([f, n]) => ['c:' + f, n, 'Classifications', CLASS_NOTE[f] || '']), ...MECH.map(([f, l]) => ['f:' + f, l, 'Other properties', '']), ['i:variable', 'Variable power', 'Other properties', '']];
const propLabel = v => { const [k, f] = v.split(':'); return k === 'c' ? CLASS_BY_FLAG[f] : k === 'i' ? 'Variable power' : MECH_LABEL[f] || f; };
const CRIT_LIST = [['mega', 'Mega forme'], ['spread', 'Spread move'], ['variable', 'Variable-power move'], ['consumable', 'Consumable item'], ['held', 'Held item']];
const STAT_OPTS = [...STATS.map(k => [k, ({ hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Special Attack', spd: 'Special Defense', spe: 'Speed' })[k]]), ['total', 'Total'], ['kg', 'Weight (kg)'], ['dex', 'National Dex #']];
const MATCH_OPTS = [['xweak', 'Extremely weak to'], ['weak', 'Weak to'], ['resists', 'Resists'], ['xresists', 'Doubly resists'], ['immune', 'Immune to']];
const MNUM_OPTS = [['bp', 'Base Power'], ['acc', 'Accuracy'], ['pp', 'PP'], ['prio', 'Priority']];
const MODE_OPTS = [['=', 'equal to'], ['<', 'less than'], ['>', 'greater than'], ['<=', 'less than or equal to'], ['>=', 'greater than or equal to'], ['!=', 'not equal to']];
const quote = v => /[\s"():<>=!\/]/.test(v) || v === '' ? JSON.stringify(v) : v;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const pill = t => t ? `<span class="chip type-${t}">${t}</span>` : `<span class="pill-none">Type…</span>`;
const ICONS = { name: 'M3 5h18v14H3z M7 9h6 M7 13h10', text: 'M4 5h16 M4 9h16 M4 13h10 M4 17h7', type: 'M20 12l-8 8-8-8 8-8z', ability: 'M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7z', move: 'M5 12h14 M13 6l6 6-6 6', stat: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2', forme: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8v8 M8 12h8', reg: 'M5 4h14v16H5z M9 4v16 M13 9h3 M13 13h3', match: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5', cat: 'M4 6h16 M4 12h16 M4 18h16', crit: 'M9 6h11 M9 12h11 M9 18h11 M4 6h1 M4 12h1 M4 18h1', num: 'M4 7h16 M4 12h16 M4 17h16 M8 4v16 M16 4v16', flag: 'M5 21V4h12l-2 4 2 4H5', target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', lb: 'M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z M8 7h7', item: 'M6 8h12l1 12H5z M9 8V6a3 3 0 0 1 6 0v2', pref: 'M14 4l6 6-9 9H5v-6z M12 6l6 6', kinds: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z' };
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[k]}"/></svg>`;
const naturalDir = key => !key ? '' : ['hp', 'atk', 'def', 'spa', 'spd', 'spe', 'total', 'bp', 'acc', 'pp', 'prio'].includes(key) ? 'desc' : 'asc';
const TABS = [['species', 'Pokémon'], ['move', 'Moves'], ['ability', 'Abilities'], ['item', 'Items']];
function emptyForm() { return { tab: 'species', name: '', text: '', types: [], typeMode: 'all', abilities: [], moves: [], stats: [{ stat: 'spe', op: '>=', val: '' }], formes: { base: true, mega: true }, regStatus: 'legal', matchups: [{ rel: 'weak', type: '' }], cats: new Set(), mnums: [{ stat: 'bp', op: '>=', val: '' }], props: [], target: 'any', lb: '', icats: [], view: 'grid', order: '', dir: '', also: [] }; }
function buildQuery(fs) {
  const t = []; const tok = (arr, field, q) => arr.forEach(x => t.push((x.neg ? '-' : '') + field + ':' + (q ? quote(x.v) : x.v)));
  const tab = fs.tab; t.push('kind:' + tab);
  if (fs.name.trim()) t.push(quote(fs.name.trim()));
  const txt = fs.text.trim(); if (txt && tab !== 'species') t.push(/^\/.*\/$/.test(txt) ? 'o:' + txt : 'o:' + quote(txt));
  if (tab === 'species' || tab === 'move') {
    const inc = fs.types.filter(x => !x.neg).map(x => x.v), exc = fs.types.filter(x => x.neg).map(x => x.v);
    if (inc.length) { if (fs.typeMode === 'exact' && tab === 'species') t.push('t=' + inc.slice(0, 2).join('/')); else if ((fs.typeMode === 'any' || tab === 'move') && inc.length > 1) t.push('(' + inc.map(x => 't:' + x).join(' or ') + ')'); else inc.forEach(x => t.push('t:' + x)); }
    exc.forEach(x => t.push('-t:' + x)); }
  if (tab === 'species') {
    fs.abilities.forEach(x => t.push((x.neg ? '-' : '') + 'a:' + (x.expr ? '(' + (/^\/.*\/$/.test(x.v) ? 'o:' + x.v : x.v) + ')' : quote(x.v))));
    fs.moves.forEach(x => t.push((x.neg ? '-' : '') + 'm:' + (x.expr ? '(' + x.v + ')' : quote(x.v))));
    fs.stats.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
    fs.matchups.filter(r => r.type).forEach(r => t.push(`${r.rel}:${r.type}`));
    if (fs.formes.mega && !fs.formes.base) t.push('is:mega'); else if (fs.formes.base && !fs.formes.mega) t.push('-is:mega'); }
  if (tab === 'move') {
    const c = [...fs.cats]; if (c.length === 1) t.push('cat:' + c[0]); else if (c.length === 2) t.push('(' + c.map(x => 'cat:' + x).join(' or ') + ')');
    fs.mnums.filter(r => r.val !== '' && Number.isFinite(Number(r.val))).forEach(r => t.push(`${r.stat}${r.op}${r.val}`));
    fs.props.forEach(x => { const [k, f] = x.v.split(':'); t.push((x.neg ? '-' : '') + (k === 'c' ? 'class:' + quote(CLASS_BY_FLAG[f]) : k === 'i' ? 'is:' + f : 'flag:' + f)); });
    if (fs.target !== 'any') t.push('target:' + fs.target);
    if (fs.lb.trim()) t.push('lb:' + quote(fs.lb.trim())); }
  if (tab === 'item') tok(fs.icats, 'cat', true);
  if (fs.order) { t.push('order:' + fs.order); if (fs.dir && fs.dir !== naturalDir(fs.order)) t.push('dir:' + fs.dir); }
  return t.concat(fs.also).join(' ');
}
function astText(n) { if (!n) return ''; if (n.type === 'word') return quote(n.v); if (n.type === 'term') return n.field + n.op + (n.sub ? '(' + astText(n.sub) + ')' : n.isRegex ? '/' + n.val + '/' : quote(n.val)); if (n.type === 'not') return '-' + astText(n.node); if (n.type === 'or') return '(' + n.items.map(astText).join(' or ') + ')'; return n.items.map(astText).join(' '); }
function queryToForm(q) {
  const fs = emptyForm(); fs.stats = []; fs.mnums = []; fs.matchups = [];
  let ast; try { ast = parse(q); } catch (e) { fs.also = [q]; return fs; }
  if (!ast) return fs;
  // tab = the query's single kind if it has one; else its inferred scope if single; else Pokémon
  let scope = null; try { scope = validate(ast, IDX, {}); } catch (e) {}
  const items = ast.type === 'and' ? ast.items : [ast];
  const kindTerm = items.find(it => it.type === 'term' && F[it.field] && F[it.field].name === 'kind' && KINDS.includes(norm(it.val)));
  const kindGroup = items.find(it => it.type === 'or' && it.items.every(x => x.type === 'term' && F[x.field] && F[x.field].name === 'kind' && KINDS.includes(norm(x.val))));
  if (kindTerm) fs.tab = norm(kindTerm.val); else if (kindGroup) fs.tab = norm(kindGroup.items[0].val); else if (scope && scope.size === 1) fs.tab = [...scope][0];
  else { fs.tab = 'species'; try { const r = search(IDX, q); if (r.results.length) fs.tab = r.results[0].kind; } catch (e) {} }
  const statKeys = new Set(STAT_OPTS.map(x => x[0])), mnumKeys = new Set(MNUM_OPTS.map(x => x[0]));
  const isCatVal = v => ['physical', 'special', 'status'].includes(norm(v));
  const byName = (kind, v) => { const e = IDX.ents.find(x => x.kind === kind && (x.norm === norm(v) || x.compact === compact(v))); return e ? e.name : v; };
  const T = fs.tab;
  for (const it of items) {
    if (it === kindTerm || it === kindGroup) continue;
    if (it.type === 'word') { fs.name = (fs.name + ' ' + it.v).trim(); continue; }
    if (it.type === 'or' && it.items.every(x => x.type === 'term' && x.op === ':' && !x.isRegex)) {
      const fields = new Set(it.items.map(x => F[x.field] && F[x.field].name)); const vals = it.items.map(x => x.val);
      if (fields.size === 1 && fields.has('t') && vals.every(v => IDX.types.includes(norm(v))) && (T === 'species' || T === 'move')) { vals.forEach(v => fs.types.push({ v: norm(v), neg: false })); fs.typeMode = 'any'; continue; }
      if (fields.size === 1 && fields.has('cat') && vals.every(isCatVal) && T === 'move') { vals.forEach(v => fs.cats.add(norm(v))); continue; }
      fs.also.push(astText(it)); continue; }
    const neg = it.type === 'not'; const tm = neg ? it.node : it;
    if (tm.type !== 'term' || !F[tm.field]) { fs.also.push(astText(it)); continue; }
    const f = F[tm.field].name, v = tm.val, vn = norm(v);
    if (tm.sub) { if (f === 'm' && T === 'species') { fs.moves.push({ v: astText(tm.sub), neg, expr: true }); continue; } if (f === 'a' && T === 'species') { const sub = tm.sub; const bare = sub.type === 'term' && F[sub.field] && F[sub.field].name === 'o' && sub.isRegex; fs.abilities.push({ v: bare ? '/' + sub.val + '/' : astText(sub), neg, expr: true }); continue; } fs.also.push(astText(it)); continue; }
    if (tm.isRegex && f !== 'o') { fs.also.push(astText(it)); continue; }
    if (f === 'kind') { fs.also.push(astText(it)); continue; }
    if (f === 't' && tm.op === ':' && IDX.types.includes(vn) && (T === 'species' || T === 'move')) { fs.types.push({ v: vn, neg }); if (!neg && fs.typeMode === 'any') fs.typeMode = 'all'; }
    else if (f === 't' && tm.op === '=' && !neg && T === 'species' && v.split(/[\/,+]/).every(x => IDX.types.includes(norm(x)))) { v.split(/[\/,+]/).forEach(x => fs.types.push({ v: norm(x), neg: false })); fs.typeMode = 'exact'; }
    else if (f === 'a' && tm.op === ':' && T === 'species') fs.abilities.push({ v: byName('ability', v), neg, expr: false });
    else if (f === 'm' && tm.op === ':' && T === 'species') fs.moves.push({ v: byName('move', v), neg, expr: false });
    else if (f === 'flag' && tm.op === ':' && T === 'move') { const id = vn.replace(/ /g, ''); if (CLASS_BY_FLAG[id]) fs.props.push({ v: 'c:' + id, neg }); else if (MECH_LABEL[id]) fs.props.push({ v: 'f:' + id, neg }); else fs.also.push(astText(it)); }
    else if (f === 'class' && tm.op === ':' && T === 'move') { const ids = Object.keys(CLASS_BY_FLAG).filter(k => k === vn.replace(/ /g, '') || norm(CLASS_BY_FLAG[k]) === vn || norm(CLASS_BY_FLAG[k]).includes(vn)); if (ids.length === 1) fs.props.push({ v: 'c:' + ids[0], neg }); else fs.also.push(astText(it)); }
    else if (f === 'is' && vn === 'mega' && T === 'species') { fs.formes = neg ? { base: true, mega: false } : { base: false, mega: true }; }
    else if (f === 'is' && vn === 'variable' && T === 'move') fs.props.push({ v: 'i:variable', neg });
    else if (f === 'is' && vn === 'spread' && T === 'move' && !neg) fs.target = 'spread';
    else if (f === 'is' && (vn === 'consumable' || vn === 'held') && T === 'item') fs.icats.push({ v: IDX_ITEM_CATS.find(c => norm(c) === vn) || cap(vn), neg });
    else if (f === 'cat' && tm.op === ':' && T === 'item' && IDX_ITEM_CATS.map(norm).includes(vn)) fs.icats.push({ v: IDX_ITEM_CATS.find(c => norm(c) === vn), neg });
    else if (neg) fs.also.push(astText(it));
    else if (f === 'name' && tm.op === ':') fs.name = (fs.name + ' ' + v).trim();
    else if (f === 'o' && tm.op === ':' && T !== 'species') fs.text = tm.isRegex ? '/' + v + '/' : v;
    else if (statKeys.has(f) && tm.op !== ':' && T === 'species') fs.stats.push({ stat: f, op: tm.op, val: v });
    else if (mnumKeys.has(f) && tm.op !== ':' && T === 'move') fs.mnums.push({ stat: f, op: tm.op, val: v });
    else if (MATCH_OPTS.some(m => m[0] === f) && tm.op === ':' && IDX.types.includes(vn) && T === 'species') fs.matchups.push({ rel: f, type: vn });
    else if (f === 'cat' && tm.op === ':' && isCatVal(v) && T === 'move') fs.cats.add(vn);
    else if (f === 'target' && tm.op === ':' && ['spread', 'single'].includes(vn) && T === 'move') fs.target = vn;
    else if (f === 'lb' && tm.op === ':' && T === 'move') fs.lb = byName('species', v);
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
const TK_META = () => ({ types: { group: 'Types', items: IDX.types.map(t => [t, cap(t)]), placeholder: 'Enter a type or choose from the list' }, abilities: { group: 'Abilities', items: IDX.ents.filter(e => e.kind === 'ability').map(e => [e.name, e.name]), placeholder: 'Enter an ability, or a regex like /weather/' }, moves: { group: 'Moves', items: IDX.ents.filter(e => e.kind === 'move').map(e => [e.name, e.name]), placeholder: 'Enter a move, or an expression like t:rock cat:physical' }, props: { group: 'Properties', items: PROP_ITEMS(), placeholder: 'Enter a property or choose from the list', grouped: true }, species: { group: 'Pokémon', items: IDX.ents.filter(e => e.kind === 'species' && !e.is_mega).map(e => [e.name, e.name]), placeholder: 'Enter a Pokémon, e.g. “Garchomp”' }, icats: { group: 'Item categories', items: IDX_ITEM_CATS.map(c => [c, c]), placeholder: 'Enter a category or choose from the list' } });
function tokLabel(key, v) { const m = TK_META()[key]; const hit = m.items.find(x => x[0] === v); return hit ? hit[1] : v; }
function tokNote(key, v) { const m = TK_META()[key]; const hit = m.items.find(x => x[0] === v); return hit && hit[3] ? hit[3] : ''; }
function tokens(key) { const fs = FS, m = TK_META()[key]; return `<div class="tok-wrap"><div class="tokens" data-tk="${key}">${fs[key].map((x, i) => `<div class="tok"><button type="button" class="tok-x" data-tx="${key}" data-i="${i}" aria-label="Remove">×</button><button type="button" class="pol ${x.neg ? 'not' : 'is'}" data-pol="${key}" data-i="${i}" title="Toggle include / exclude">${x.neg ? 'NOT' : 'IS'}</button><span class="tok-l" title="${esc(tokNote(key, x.v))}">${key === 'types' ? pill(x.v) : x.expr ? `<code class="tok-expr">${esc(x.v)}</code>` : esc(tokLabel(key, x.v))}</span></div>`).join('')}<input type="text" class="tok-in" data-tkin="${key}" placeholder="${esc(m.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"></div><div class="tok-menu" data-menu="${key}" hidden></div></div>`; }
function singlePicker(key, fsField, value) { const m = TK_META()[key]; return `<div class="tok-wrap single"><input type="text" class="form-input tok-in" data-fs="${fsField}" data-tkin="${key}" data-single="1" value="${esc(value)}" placeholder="${esc(m.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="tok-menu" data-menu="${key}" hidden></div></div>`; }
// --- suggestion menu (Scryfall-style list directly under the field; one entry per row) ---
let MENU = { key: null, rows: [], hi: -1 };
function menuRows(key, typed) { const m = TK_META()[key]; const q = norm(typed), qc = compact(typed); const chosen = new Set((FS[key] || []).map(x => x.v)); return m.items.filter(([v, l]) => !chosen.has(v) && (!q || norm(l).includes(q) || compact(l).includes(qc))); }
const MAIN_FIELDS = [['kind:', 'species / move / ability / item'], ['t:', 'type'], ['a:', 'ability (or a:( … ))'], ['m:', 'learns move (or m:( … ))'], ['spe>=', 'Speed'], ['hp>=', 'HP'], ['atk>=', 'Attack'], ['def>=', 'Defense'], ['spa>=', 'Special Attack'], ['spd>=', 'Special Defense'], ['total>=', 'stats total'], ['weak:', 'takes 2×+ from a type'], ['xweak:', 'takes 4× from a type'], ['resists:', 'takes ½× or less'], ['xresists:', 'takes ¼×'], ['immune:', 'takes 0×'], ['is:', 'mega / spread / variable / consumable / held'], ['cat:', 'physical / special / status, or item category'], ['bp>=', 'base power'], ['acc>=', 'accuracy'], ['pp>=', 'PP'], ['prio>=', 'priority'], ['class:', 'Classification'], ['flag:', 'move property'], ['target:', 'spread / single'], ['lb:', 'learned by a Pokémon (or lb:( … ))'], ['o:', 'description text'], ['order:', 'sort key'], ['dir:', 'asc / desc']];
const SUB_FIELDS = [['t:', 'type'], ['cat:', 'physical / special / status'], ['bp>=', 'base power'], ['acc>=', 'accuracy'], ['pp>=', 'PP'], ['prio>=', 'priority'], ['class:', 'Classification (Punching, Sound-Based…)'], ['flag:', 'other property (contact, protect…)'], ['target:', 'spread / single'], ['o:', 'description text'], ['is:', 'spread / variable']];
function subContext(input) { const caret = input.selectionStart ?? input.value.length; const before = input.value.slice(0, caret); const m = /([^\s()]*)$/.exec(before); const tok = m ? m[1] : ''; const start = caret - tok.length; const ci = tok.indexOf(':'); if (ci < 0) { if (/[<>=!]/.test(tok)) return null; return { start, end: caret, field: '', partial: tok }; } return { start, end: caret, field: tok.slice(0, ci).toLowerCase(), partial: tok.slice(ci + 1) }; }
function subRows(ctx) { const q = norm(ctx.partial), qc = compact(ctx.partial); if (MENU_INPUT_KEY === 'abilities' && !ctx.field) { if (ctx.partial && !'o:'.startsWith(ctx.partial.toLowerCase())) return null; return { group: 'Fields', rows: [['o:', 'ability text — or type a bare /regex/']] }; } const f = x => { const pre = x.filter(([v]) => q && (norm(v).startsWith(q) || compact(v).startsWith(qc))); const rest = x.filter(([v, l]) => !pre.includes(x.find(y => y[0] === v)) && (!q || norm(l).includes(q))); return q ? pre.concat(rest) : x; };
  if (!ctx.field) return { group: 'Fields', rows: f(SUB_FIELDS), pills: false };
  const fld = F[ctx.field] ? F[ctx.field].name : ctx.field;
  if (fld === 't') return { group: 'Types', rows: f(IDX.types.map(t => [t, cap(t)])), pills: true };
  if (fld === 'cat') return { group: 'Category', rows: f([['physical', 'Physical'], ['special', 'Special'], ['status', 'Status']]) };
  if (fld === 'flag') return { group: 'Other properties', rows: f(MECH.map(([x, l]) => [x, l])) };
  if (fld === 'target') return { group: 'Target', rows: f([['spread', 'Spread (hits more than one)'], ['single', 'Single target']]) };
  if (fld === 'class') return { group: 'Classifications', plain: true, rows: f(Object.values(CLASS_BY_FLAG).sort().map(c => [quote(c), c])) };
  if (fld === 'is') return { group: 'Criteria', rows: f([['spread', 'Spread move'], ['variable', 'Variable-power move']]) };
  return null; }
let MENU_INPUT_KEY = null;
function mainRows(ctx) { const q = norm(ctx.partial), qc = compact(ctx.partial); const f = x => { const pre = x.filter(([v]) => q && (norm(v).startsWith(q) || compact(v).startsWith(qc))); const rest = x.filter(([v, l]) => !pre.includes(x.find(y => y[0] === v)) && (!q || norm(l).includes(q))); return q ? pre.concat(rest) : x; };
  if (!ctx.field) { const rows = []; let names = []; if (ctx.partial.length >= 2) names = IDX.ents.filter(e => e.norm.startsWith(q) || e.compact.startsWith(qc)).map(e => [quote(e.name), KIND_LABEL[e.kind]]); const fields = f(MAIN_FIELDS); return { group: names.length ? 'Names' : 'Fields', rows: names.concat(fields.map(([v, l]) => [v, l])), groups: names.length && fields.length ? names.length : 0, pills: false }; }
  const fld = F[ctx.field] ? F[ctx.field].name : ctx.field; const types = f(IDX.types.map(t => [t, cap(t)]));
  if (['t', 'weak', 'xweak', 'resists', 'xresists', 'immune'].includes(fld)) return { group: 'Types', rows: types, pills: true };
  if (fld === 'a') return { group: 'Abilities', plain: true, rows: f(IDX.ents.filter(e => e.kind === 'ability').map(e => [quote(e.name), e.name])) };
  if (fld === 'm') return { group: 'Moves', plain: true, rows: f(IDX.ents.filter(e => e.kind === 'move').map(e => [quote(e.name), e.name])) };
  if (fld === 'lb') return { group: 'Pokémon', plain: true, rows: f(IDX.ents.filter(e => e.kind === 'species' && !e.is_mega).map(e => [quote(e.name), e.name])) };
  if (fld === 'kind') return { group: 'Kinds', rows: f(KINDS.map(k => [k, KIND_LABEL[k]])) };
  if (fld === 'is') return { group: 'Criteria', rows: f([['mega', 'Mega forme'], ['spread', 'Spread move'], ['variable', 'Variable-power move'], ['consumable', 'Consumable item'], ['held', 'Held item']]) };
  if (fld === 'cat') return { group: 'Categories', plain: true, rows: f([['physical', 'Physical (move)'], ['special', 'Special (move)'], ['status', 'Status (move)'], ...IDX_ITEM_CATS.map(c => [quote(c), c + ' (item)'])]) };
  if (fld === 'class') return { group: 'Classifications', plain: true, rows: f(Object.values(CLASS_BY_FLAG).sort().map(c => [quote(c), c])) };
  if (fld === 'flag') return { group: 'Properties', rows: f(MECH.map(([x, l]) => [x, l])) };
  if (fld === 'target') return { group: 'Target', rows: f([['spread', 'Spread'], ['single', 'Single target']]) };
  if (fld === 'order') return { group: 'Sort by', rows: f(SORTS.filter(([v]) => v).map(([v, l]) => [v, l])) };
  if (fld === 'dir') return { group: 'Direction', rows: f([['asc', 'Ascending'], ['desc', 'Descending']]) };
  return null; }
function openMainMenu(input) { const menu = $('#mainmenu'); if (!menu) return; const ctx = subContext(input); const sr = ctx && mainRows(ctx); if (!sr || !sr.rows.length) { menu.hidden = true; MENU = { key: null, rows: [], hi: -1 }; return; }
  MENU = { key: 'main', rows: sr.rows, hi: ctx.partial ? 0 : -1, input, menu, ctx };
  let html = ''; sr.rows.forEach(([v, l], i) => { if (i === 0) html += `<div class="tok-menu-group">${esc(sr.group)}</div>`; if (sr.groups && i === sr.groups) html += `<div class="tok-menu-group">Fields</div>`; const isName = sr.groups && i < sr.groups; html += `<div class="tok-menu-row ${i === MENU.hi ? 'hi' : ''}" data-pick="${esc(v)}" data-i="${i}">${sr.pills ? pill(v) : (sr.plain || isName) ? `${esc(isName ? v.replace(/^"|"$/g, '') : l)}${isName ? ` <span class="muted">${esc(l)}</span>` : ''}` : `<code>${esc(v)}</code> <span class="muted">${esc(l)}</span>`}</div>`; });
  menu.innerHTML = html; menu.hidden = false; }
function openSubMenu(input) { MENU_INPUT_KEY = input.dataset.tkin; const menu = input.closest('.tok-wrap').querySelector('.tok-menu'); const ctx = subContext(input); const sr = ctx && subRows(ctx); if (!sr || !sr.rows.length) { menu.hidden = true; MENU = { key: null, rows: [], hi: -1 }; return; }
  MENU = { key: 'sub', rows: sr.rows, hi: ctx.partial ? 0 : -1, input, menu, ctx };
  menu.innerHTML = `<div class="tok-menu-group">${esc(sr.group)}</div>` + sr.rows.map(([v, l], i) => `<div class="tok-menu-row ${i === MENU.hi ? 'hi' : ''}" data-pick="${esc(v)}" data-i="${i}">${sr.pills ? pill(v) : sr.plain ? esc(l) : `<code>${esc(v)}</code> <span class="muted">${esc(l)}</span>`}</div>`).join(''); menu.hidden = false; }
function pickSub(input, v) { const ctx = MENU.ctx || subContext(input); const isField = !ctx.field; const insert = isField ? v : (ctx.field + ':' + v); const tail = input.value.slice(ctx.end); const needSpace = !isField && !/^\s/.test(tail) ; const nv = input.value.slice(0, ctx.start) + insert + (needSpace ? ' ' : '') + tail; input.value = nv; const pos = ctx.start + insert.length + (needSpace ? 1 : 0); const wasMain = MENU.key === 'main'; input.focus(); try { input.setSelectionRange(pos, pos); } catch (e) {} readForm(); if (isField && /[:=]$/.test(insert)) (wasMain ? openMainMenu : openSubMenu)(input); else closeMenu(); }
const looksExpr = v => /[:<>=\/()]/.test(v);
function nudgeIntoView(input) { if (window.innerWidth > 700) return; setTimeout(() => { const r = input.getBoundingClientRect(); if (r.top > 140 || r.top < 0) window.scrollBy({ top: r.top - 90, behavior: 'smooth' }); }, 250); }
function openMenu(input) { nudgeIntoView(input); if (input.dataset.acsub || ((input.dataset.tkin === 'moves' || input.dataset.tkin === 'abilities') && looksExpr(input.value))) return openSubMenu(input); const key = input.dataset.tkin; const menu = input.closest('.tok-wrap').querySelector('.tok-menu'); const rows = menuRows(key, input.value); MENU = { key, rows, hi: rows.length && input.value ? 0 : -1, input, menu };
  if (!rows.length) { menu.innerHTML = `<div class="tok-menu-empty">No matches</div>`; menu.hidden = false; return; }
  const grouped = TK_META()[key].grouped; let lastG = null;
  menu.innerHTML = (grouped ? '' : `<div class="tok-menu-group">${esc(TK_META()[key].group)}</div>`) + rows.slice(0, 400).map(([v, l, g, note], i) => { let h = ''; if (grouped && g !== lastG) { h = `<div class="tok-menu-group">${esc(g)}</div>`; lastG = g; } return h + `<div class="tok-menu-row ${i === MENU.hi ? 'hi' : ''}" data-pick="${esc(v)}" data-i="${i}" title="${esc(note || '')}">${key === 'types' ? pill(v) : esc(l)}${note ? ' <span class="muted">ⓘ</span>' : ''}</div>`; }).join('') + (rows.length > 400 ? `<div class="tok-menu-empty">…keep typing to narrow the list</div>` : ''); menu.hidden = false; }
function closeMenu() { if (MENU.menu) MENU.menu.hidden = true; MENU = { key: null, rows: [], hi: -1 }; }
function moveHi(d) { if (!MENU.menu || !MENU.rows.length) return; MENU.hi = Math.max(0, Math.min(MENU.rows.length - 1, MENU.hi + d)); [...MENU.menu.querySelectorAll('.tok-menu-row')].forEach((r, i) => { r.classList.toggle('hi', i === MENU.hi); if (i === MENU.hi) r.scrollIntoView({ block: 'nearest' }); }); }
function pick(input, v) { if (input.dataset.acsub || MENU.key === 'sub' || MENU.key === 'main') return pickSub(input, v); const key = input.dataset.tkin; if (input.dataset.single) { input.value = v; closeMenu(); readForm(); return; } if (addToken(key, v)) { closeMenu(); rerenderTokens(key); const nin = $(`[data-tkin="${key}"]`); if (nin) nin.focus(); } }
function dupRow(kind, r, i, opts) { return `<div class="band dup" data-row="${kind}" data-i="${i}"><select class="form-input auto small-select" data-f="stat">${opts.map(([v, l]) => `<option value="${v}" ${v === r.stat ? 'selected' : ''}>${l}</option>`).join('')}</select><select class="form-input auto small-select" data-f="op">${MODE_OPTS.map(([v, l]) => `<option value="${v}" ${v === r.op ? 'selected' : ''}>${l}</option>`).join('')}</select><input type="number" inputmode="numeric" pattern="[0-9]*" class="form-input auto small-select" data-f="val" value="${esc(r.val)}" placeholder="e.g. 100"></div>`; }
function pillSelect(attrs, val) { return `<div class="pillsel" ${attrs}><button type="button" class="form-input auto pill-btn" data-pillbtn>${pill(val)}</button><div class="tok-menu pill-menu" hidden><div class="tok-menu-group">Types</div>${IDX.types.map(t => `<div class="tok-menu-row ${t === val ? 'hi' : ''}" data-pillpick="${t}">${pill(t)}</div>`).join('')}</div></div>`; }
function matchRow(r, i) { return `<div class="band dup" data-row="matchups" data-i="${i}"><select class="form-input auto small-select" data-f="rel">${MATCH_OPTS.map(([v, l]) => `<option value="${v}" ${v === r.rel ? 'selected' : ''}>${l}</option>`).join('')}</select>${pillSelect(`data-f="type" data-val="${esc(r.type)}"`, r.type)}</div>`; }
function advForm() {
  const fs = FS; const T = fs.tab;
  const row = (ic, label, bands, tip, short) => `<div class="form-row"><label class="form-row-label ${short ? 'short' : ''}">${icon(ic)} ${label}</label><div class="form-row-content">${bands}${tip ? `<p class="form-row-tip">${tip}</p>` : ''}</div></div>`;
  const band = (inner, cls) => `<div class="band ${cls || ''}">${inner}</div>`;
  const sorts = T === 'species' ? SORTS.filter(([v]) => !['bp', 'acc', 'pp', 'prio'].includes(v)) : T === 'move' ? SORTS.filter(([v]) => ['', 'name', 'bp', 'acc', 'pp', 'prio'].includes(v)) : SORTS.filter(([v]) => ['', 'name'].includes(v));
  const tabs = `<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<a role="tab" class="tab ${k === T ? 'on' : ''}" href="#" data-tab="${k}" aria-selected="${k === T}">${l}</a>`).join('')}</div>`;
  const regRow = row('reg', 'Regulation', band(`<span class="regtext">Legal in Regulation ${esc(IDX.meta.regulation.regulation)}</span>`), 'Only the current regulation is loaded in this prototype. Choosing a regulation, and “newly legal” / “removed” searches, arrive with regulation history.', true);
  const shared1 = row('name', 'Name', band(`<input type="text" class="form-input" data-fs="name" value="${esc(fs.name)}" placeholder="Any words in the name, e.g. “${T === 'species' ? 'Garchomp' : T === 'move' ? 'Iron Head' : T === 'ability' ? 'Intimidate' : 'Sitrus Berry'}”">`), '')
    + (T === 'species' ? '' : row('text', 'Text', band(`<input type="text" class="form-input" data-fs="text" value="${esc(fs.text)}" placeholder="Any text, e.g. “flinch”">`), 'Words in the description. Wrap it in slashes for a regular expression, e.g. /heals?|restores?/.'));
  const typesRow = row('type', 'Types', band(tokens('types')) + (T === 'species' ? band(sel('typeMode', [['all', 'Including these types'], ['exact', 'Exactly these types'], ['any', 'Any of these types']], fs.typeMode)) : ''), T === 'species' ? 'Choose any type to match. Click the “IS” or “NOT” button to toggle between including and excluding a type.' : 'The move’s own type — any of the “IS” types; “NOT” excludes.');
  let body = '';
  if (T === 'species') body = typesRow
    + row('ability', 'Abilities', band(tokens('abilities')), 'Any slot, hidden abilities included; “NOT” excludes. A regex such as <code>/weather/</code> matches ability text; <code>o:immune</code> works too — see <a href="?guide=1#subquery" data-nav>the syntax guide</a>.')
    + row('stat', 'Stats', `<div id="stats-rows">${fs.stats.map((r, i) => dupRow('stats', r, i, STAT_OPTS)).join('')}</div>`, 'Restrict Pokémon based on their in-game stats (Level 50, 0 Stat Points, neutral alignment). Total is the sum of the six.')
    + row('match', 'Matchups', `<div id="matchups-rows">${fs.matchups.map(matchRow).join('')}</div>`, 'Defensive matchups from the type chart only — abilities such as Levitate are not applied. Choosing a type adds another row.')
    + row('forme', 'Formes', band(cb('data-forme', 'base', 'Base formes', fs.formes.base) + cb('data-forme', 'mega', 'Mega formes', fs.formes.mega), 'cbs'), 'Include or exclude Mega formes, which are listed as their own entries.', true)
    + row('move', 'Learns', band(tokens('moves')), 'Named moves must all be in the learnset; “NOT” moves must not be. An expression such as <code>t:rock cat:physical bp>=75</code> describes one move to learn — see <a href="?guide=1#subquery" data-nav>the syntax guide</a>.');
  else if (T === 'move') body = typesRow
    + row('cat', 'Category', band(['physical', 'special', 'status'].map(c => cb('data-cat', c, cap(c), fs.cats.has(c))).join(''), 'cbs'), 'Only return moves of the selected categories.', true)
    + row('num', 'Move numbers', `<div id="mnums-rows">${fs.mnums.map((r, i) => dupRow('mnums', r, i, MNUM_OPTS)).join('')}</div>`, 'Base power, accuracy, PP (Champions values) and priority. Moves that never miss count as accuracy above 100.')
    + row('flag', 'Properties', band(tokens('props')), 'The game’s Classifications (Punching, Sound-Based, Ball &amp; Bomb…) and other move properties in plain words. Every “IS” property must apply; “NOT” excludes.')
    + row('target', 'Target', band(sel('target', [['any', 'Any target'], ['spread', 'Spread (hits more than one)'], ['single', 'Single target']], fs.target)), '')
    + row('lb', 'Learned by', band(singlePicker('species', 'lb', fs.lb)), 'Only moves this Pokémon can learn.');
  else if (T === 'item') body = row('item', 'Item category', band(tokens('icats')), 'Berry, Mega Stone, Recovery, Consumable, Held… Every “IS” category must apply; “NOT” excludes.');
  const prefs = row('pref', 'Preferences', band(sel('view', [['grid', 'Display as Grid'], ['list', 'Display as List']], fs.view) + sel('order', sorts.map(([v, l]) => [v, 'Sort by ' + l]), fs.order) + `<select class="form-input auto" data-fs="dir" ${fs.order ? '' : 'disabled'}>${[['asc', 'Ascending'], ['desc', 'Descending']].map(([v, l]) => `<option value="${v}" ${(fs.dir || naturalDir(fs.order)) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`, 'prefs'), '');
  return `<section class="wrap adv">${tabs}<form id="adv" class="form-layout" novalidate>
  ${shared1}${body}<div class="settings-sep"><span>Search settings</span></div>${regRow}${prefs}
  <div class="form-row also" ${fs.also.length ? '' : 'hidden'}><label class="form-row-label short">${icon('crit')} Also</label><div class="form-row-content"><div class="band"><code id="also">${esc(fs.also.join(' '))}</code></div><p class="form-row-tip">Terms from the typed query this tab has no control for. They stay in the search.</p></div></div>
  <div class="submit-bar"><div class="qwrap"><code id="qpreview" class="qpreview" title="The query this form will run"></code><span id="qcount" class="qcount"></span></div><button type="button" class="reset-n" id="copylink" title="Copy a link to this search">Copy link</button><button type="button" class="reset-n" id="reset">Reset</button><button type="submit" class="submit-n" id="go">Search with these options</button></div>
  </form></section>`;
}
function readForm() {
  const f = $('#adv'); if (!f) return; const fs = FS;
  const prevOrder = fs.order;
  for (const el of f.querySelectorAll('[data-fs]')) { if (el.type === 'radio') { if (el.checked) fs[el.dataset.fs] = el.value; } else fs[el.dataset.fs] = el.value; }
  if (fs.order !== prevOrder) { fs.dir = ''; const d = f.querySelector('[data-fs=dir]'); if (d) { d.disabled = !fs.order; d.value = naturalDir(fs.order) || 'asc'; } }
  if (fs.tab === 'species') { fs.formes = { base: !!f.querySelector('[data-forme=base]')?.checked, mega: !!f.querySelector('[data-forme=mega]')?.checked }; if (!fs.formes.base && !fs.formes.mega) { fs.formes = { base: true, mega: true }; f.querySelectorAll('[data-forme]').forEach(x => x.checked = true); } fs.stats = [...f.querySelectorAll('[data-row="stats"]')].map(r => ({ stat: r.querySelector('[data-f=stat]').value, op: r.querySelector('[data-f=op]').value, val: r.querySelector('[data-f=val]').value })); fs.matchups = [...f.querySelectorAll('[data-row="matchups"]')].map(r => ({ rel: r.querySelector('[data-f=rel]').value, type: r.querySelector('[data-f=type]').dataset.val || '' })); }
  if (fs.tab === 'move') { fs.cats = new Set([...f.querySelectorAll('[data-cat]')].filter(x => x.checked).map(x => x.dataset.cat)); fs.mnums = [...f.querySelectorAll('[data-row="mnums"]')].map(r => ({ stat: r.querySelector('[data-f=stat]').value, op: r.querySelector('[data-f=op]').value, val: r.querySelector('[data-f=val]').value })); }
  updatePreview();
}
// duplicant rows: append a fresh row only when the last one has been committed (change / blur), never mid-typing
function ensureDupRow(kind) { const fs = FS; if (kind === 'matchups') { if (!fs.matchups.some(r => !r.type)) { fs.matchups.push({ rel: 'weak', type: '' }); $('#matchups-rows').insertAdjacentHTML('beforeend', matchRow(fs.matchups[fs.matchups.length - 1], fs.matchups.length - 1)); } return; }
  const rows = fs[kind]; if (rows.some(r => r.val === '')) return; const r = { stat: kind === 'stats' ? 'spe' : 'bp', op: '>=', val: '' }; rows.push(r); $('#' + kind + '-rows').insertAdjacentHTML('beforeend', dupRow(kind, r, rows.length - 1, kind === 'stats' ? STAT_OPTS : MNUM_OPTS)); }
function updatePreview() { if (!FS) return; const q = buildQuery(FS); const p = $('#qpreview'); if (p) p.textContent = q || ''; const go = $('#go'); if (go) go.disabled = !q; const c = $('#qcount'); if (c) { let txt = ''; if (q) { try { const n = search(IDX, q).results.length; txt = n === 1 ? '1 result' : n + ' results'; } catch (e) { txt = e instanceof QueryError ? (e.kind === 'syntax' ? 'syntax error' : 'scope error') : ''; } } c.textContent = txt; } }
function submitForm() { readForm(); const q = buildQuery(FS); if (!q) return; nav(qlink(q) + (FS.view === 'list' ? '&view=list' : '')); }
function addToken(key, raw) {
  const v = raw.trim(); if (!v) return false; let val = v;
  if (key === 'types') { const t = norm(v); if (!IDX.types.includes(t)) return false; val = t; }
  else if (key === 'props') { const hit = PROP_ITEMS().find(([id, l]) => norm(l) === norm(v) || id.slice(2) === norm(v).replace(/ /g, '') || id === v); if (!hit) return false; val = hit[0]; }
  else if (key === 'crit') { const c = CRIT_LIST.find(([k, l]) => norm(l) === norm(v) || k === norm(v)); if (!c) return false; val = c[0]; }
  else if (key === 'icats') { const c = IDX_ITEM_CATS.find(x => norm(x) === norm(v)); if (!c) return false; val = c; }
  else if (key === 'species') { const e = IDX.ents.find(x => x.kind === 'species' && (x.norm === norm(v) || x.compact === compact(v))); val = e ? e.name : v; }
  else if (key === 'abilities' && looksExpr(v)) { const inner = /^\/.*\/$/.test(v) ? 'o:' + v : v; try { validate(parse('a:(' + inner + ')'), IDX, {}); } catch (e) { return false; } if (FS.abilities.some(x => x.v === v)) return true; FS.abilities.push({ v, neg: false, expr: true }); return true; }
  else if (key === 'moves' && looksExpr(v)) { try { validate(parse('m:(' + v + ')'), IDX, {}); } catch (e) { return false; } if (FS.moves.some(x => x.v === v)) return true; FS.moves.push({ v, neg: false, expr: true }); return true; }
  else if (key === 'abilities' || key === 'moves') { const kind = key === 'abilities' ? 'ability' : 'move'; const e = IDX.ents.find(x => x.kind === kind && (x.norm === norm(v) || x.compact === compact(v))); if (!e) return false; val = e.name; }
  if (FS[key].some(x => x.v === val)) return true;
  FS[key].push({ v: val, neg: false }); return true;
}
function rerenderTokens(key) { const box = $(`[data-tk="${key}"]`); if (!box) return; box.closest('.tok-wrap').outerHTML = tokens(key); updatePreview(); }
function bindForm() {
  const f = $('#adv'); if (!f) return; updatePreview();
  f.addEventListener('input', ev => { const t = ev.target; if (t.classList.contains('tok-in')) { openMenu(t); if (t.dataset.single) readForm(); return; } readForm(); const row = t.closest('[data-row]'); if (row && t.dataset.f === 'val' && t.value !== '') ensureDupRow(row.dataset.row); });
  f.addEventListener('focusin', ev => { const t = ev.target; if (t.classList && t.classList.contains('tok-in')) openMenu(t); });
  f.addEventListener('focusout', ev => { const t = ev.target; if (t.classList && t.classList.contains('tok-in')) setTimeout(() => { if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('.tok-wrap')) closeMenu(); }, 250); });
  f.addEventListener('change', ev => { if (ev.target.classList.contains('tok-in')) return; readForm(); const row = ev.target.closest('[data-row]'); if (row && (ev.target.dataset.f === 'val' || ev.target.dataset.f === 'cat')) ensureDupRow(row.dataset.row); });
  f.addEventListener('focusout', ev => { const row = ev.target.closest && ev.target.closest('[data-row]'); if (row && ev.target.dataset.f === 'val') { readForm(); ensureDupRow(row.dataset.row); } });
  f.addEventListener('keydown', ev => { const t = ev.target; if (!(t.classList && t.classList.contains('tok-in'))) return;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (MENU.menu && !MENU.menu.hidden) moveHi(1); else openMenu(t); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); moveHi(-1); return; }
    if (ev.key === 'Escape') { closeMenu(); return; }
    if (ev.key === 'Enter') { if (t.dataset.acsub && !(MENU.rows.length && MENU.hi >= 0)) { closeMenu(); return; } if (MENU.key === 'sub' && !(MENU.rows.length && MENU.hi >= 0)) { ev.preventDefault(); if (addToken(t.dataset.tkin, t.value)) { closeMenu(); rerenderTokens(t.dataset.tkin); $(`[data-tkin="${t.dataset.tkin}"]`)?.focus(); } return; } ev.preventDefault(); if (MENU.rows.length && MENU.hi >= 0) pick(t, MENU.rows[MENU.hi][0]); else if (t.dataset.single) { closeMenu(); readForm(); } else if (addToken(t.dataset.tkin, t.value)) { closeMenu(); rerenderTokens(t.dataset.tkin); $(`[data-tkin="${t.dataset.tkin}"]`)?.focus(); } return; }
    if (ev.key === 'Backspace' && !t.value && !t.dataset.single && FS[t.dataset.tkin].length) { FS[t.dataset.tkin].pop(); rerenderTokens(t.dataset.tkin); $(`[data-tkin="${t.dataset.tkin}"]`)?.focus(); } });
  f.addEventListener('mousedown', ev => { if (ev.target.closest('.tok-menu')) ev.preventDefault(); });
  f.addEventListener('click', ev => { const pp = ev.target.closest('[data-pillpick]'); if (pp) { ev.preventDefault(); const ps = pp.closest('.pillsel'); ps.dataset.val = pp.dataset.pillpick; ps.querySelector('.pill-btn').innerHTML = pill(pp.dataset.pillpick); ps.querySelector('.pill-menu').hidden = true; readForm(); ensureDupRow(ps.closest('[data-row]').dataset.row); return; }
    const r = ev.target.closest('[data-pick]'); if (r) { ev.preventDefault(); const input = r.closest('.tok-wrap').querySelector('.tok-in'); pick(input, r.dataset.pick); } });
  f.addEventListener('click', ev => {
    const pol = ev.target.closest('[data-pol]'); if (pol) { const x = FS[pol.dataset.pol][Number(pol.dataset.i)]; x.neg = !x.neg; rerenderTokens(pol.dataset.pol); return; }
    const tx = ev.target.closest('[data-tx]'); if (tx) { FS[tx.dataset.tx].splice(Number(tx.dataset.i), 1); rerenderTokens(tx.dataset.tx); return; }
    if (ev.target.classList.contains('tokens')) ev.target.querySelector('.tok-in')?.focus();
    const pb = ev.target.closest('[data-pillbtn]'); if (pb) { const menu = pb.nextElementSibling; const open = menu.hidden; f.querySelectorAll('.pill-menu').forEach(m => m.hidden = true); menu.hidden = !open; return; }
    if (!ev.target.closest('.pillsel')) f.querySelectorAll('.pill-menu').forEach(m => m.hidden = true);
  });
  f.addEventListener('submit', ev => { ev.preventDefault(); submitForm(); });
  $('#copylink').addEventListener('click', () => { readForm(); const q = buildQuery(FS); if (!q) return; const url = location.origin + location.pathname + qlink(q) + (FS.view === 'list' ? '&view=list' : ''); const b = $('#copylink'); const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy link'; }, 1500); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => { prompt('Copy this link', url); }); else prompt('Copy this link', url); });
  f.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitForm(); } });
  $('#reset').addEventListener('click', () => { const tab = FS.tab; FS = emptyForm(); FS.tab = tab; history.replaceState('app', '', location.pathname); render(); });
  document.querySelectorAll('.tabs [data-tab]').forEach(a => a.addEventListener('click', ev => { ev.preventDefault(); readForm(); FS.tab = a.dataset.tab; FS.also = []; render(); }));
}
function rerenderRows(k, keepFocus) { const box = $('#' + k + '-rows'); if (!box) return; const active = document.activeElement; const idx = active && active.closest ? active.closest('[data-row]')?.dataset.i : null; const fld = active && active.dataset ? active.dataset.f : null; box.innerHTML = k === 'matchups' ? FS[k].map(matchRow).join('') : FS[k].map((r, i) => dupRow(k, r, i, k === 'stats' ? STAT_OPTS : MNUM_OPTS)).join(''); if (keepFocus && idx != null && fld) { const el = box.querySelector(`[data-row="${k}"][data-i="${idx}"] [data-f="${fld}"]`); if (el) { el.focus(); if (el.type === 'number' || el.type === 'text') { const L = el.value.length; try { el.setSelectionRange(L, L); } catch (e) {} } } } updatePreview(); }

// ----- render + events -----
function render() {
  const st = state();
  let body; if (st.detail) body = detail(st.detail); else if (st.guide) body = guide(); else if (st.q && !st.adv) body = results(st); else { if (st.adv && st.q) { if (!FS || FS.src !== st.q) { FS = queryToForm(st.q); FS.src = st.q; FS.view = st.view; } } else if (!FS || FS.src) { FS = emptyForm(); } body = advForm(); }
  app.innerHTML = header(st) + `<main>${body}</main>` + footer();
  if (location.hash) { const tgt = document.getElementById(location.hash.slice(1)); if (tgt) setTimeout(() => tgt.scrollIntoView({ block: 'start' }), 0); }
  document.title = st.detail ? `${IDX.ents.find(x => x.kind === st.detail.kind && x.slug === st.detail.slug)?.name || 'VGC Dex'} · VGC Dex` : st.q ? `${st.q} · VGC Dex` : 'VGC Dex';
  bindForm();
  const qi = $('#q'); if (qi) { qi.addEventListener('input', () => openMainMenu(qi)); qi.addEventListener('focus', () => openMainMenu(qi)); qi.addEventListener('blur', () => setTimeout(() => { if (MENU.key === 'main') closeMenu(); }, 250));
    qi.addEventListener('keydown', ev => { if (MENU.key !== 'main' || (MENU.menu && MENU.menu.hidden)) { if (ev.key === 'ArrowDown') { ev.preventDefault(); openMainMenu(qi); } return; } if (ev.key === 'ArrowDown') { ev.preventDefault(); moveHi(1); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveHi(-1); } else if (ev.key === 'Escape') closeMenu(); else if (ev.key === 'Enter' && MENU.hi >= 0) { ev.preventDefault(); pickSub(qi, MENU.rows[MENU.hi][0]); } else if (ev.key === 'Tab' && MENU.hi >= 0) { ev.preventDefault(); pickSub(qi, MENU.rows[MENU.hi][0]); } });
    $('#mainmenu').addEventListener('mousedown', ev => ev.preventDefault());
    $('#mainmenu').addEventListener('click', ev => { const r = ev.target.closest('[data-pick]'); if (r) { ev.preventDefault(); pickSub(qi, r.dataset.pick); } }); }
  const f = $('#form'); if (f) f.addEventListener('submit', ev => { ev.preventDefault(); const v = $('#q').value.trim(); nav(v ? qlink(v) + (st.view !== 'grid' ? '&view=' + st.view : '') : ''); });
  const sort = $('#sort'); if (sort) sort.addEventListener('change', () => { let q = st.q.replace(/\s*\b(order|sort|dir|direction):\S+/g, '').trim(); if (sort.value) q += ' order:' + sort.value; nav(qlink(q) + (st.view !== 'grid' ? '&view=' + st.view : '')); });
  for (const id of ['random', 'random2']) { const el = $('#' + id); if (el) el.addEventListener('click', ev => { ev.preventDefault(); const sp = IDX.ents.filter(e => e.kind === 'species'); nav(plink(sp[Math.floor(Math.random() * sp.length)])); }); }
  const back = $('#back'); if (back) back.addEventListener('click', ev => { ev.preventDefault(); if (history.length > 1 && document.referrer !== '' || history.state === 'app') history.back(); else nav(''); });
  const th = $('#theme'); if (th) th.addEventListener('click', () => { const cur = document.documentElement.dataset.theme || 'light'; const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; try { localStorage.setItem('vgcdex-theme', nx); } catch (e) {} });
}
document.addEventListener('click', ev => { const a = ev.target.closest('a[data-nav]'); if (!a) return; const href = a.getAttribute('href'); if (!href || href.startsWith('#')) return; ev.preventDefault(); history.pushState('app', '', href === './' ? location.pathname : href); render(); if (!href.includes('#')) window.scrollTo(0, 0); });
window.addEventListener('popstate', render);
window.VGCDEX = { search: q => search(IDX, q), parse, get idx() { return IDX; } };
fetch('data/m-c.json').then(r => r.json()).then(d => { IDX = buildIndex(d); IDX_ITEM_CATS = d.item_categories.slice(); render(); })
  .catch(err => { app.innerHTML = `<main class="wrap"><div class="notice error">Failed to load data: ${esc(err.message)}</div></main>`; });
})();
