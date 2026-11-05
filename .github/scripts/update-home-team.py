#!/usr/bin/env python3
"""Home page team (D-85, D-95): the Masters winner of the latest official VGC Regional Championship.

Runs in the public site checkout (GitHub Action, twice a week; deploy.sh copies it there):
  1. Pokedata (pokedata.ovh) lists official events; take the newest finished
     "Regional Championships" with team lists whose winner's six Pokémon all resolve to
     Champions entries in data/m-c.json (a Pokémon holding its Mega Stone is drawn as the Mega).
  2. If that event is newer than team/home-team.json, fetch PokéAPI official artwork, trim it,
     resize to 420px tall WebP in team/, and rewrite team/home-team.json.
  3. Stamp the team into index.html (window.VGCDEX_TEAM) so the home page draws it on first paint.

Usage: python3 update-home-team.py <site-dir>            update if a newer Regional exists, then stamp
       python3 update-home-team.py <site-dir> --stamp    only stamp team/home-team.json into index.html
Needs Pillow. Prints what it did; exit 0 when nothing changed.
"""
import csv, io, json, os, re, sys, urllib.request

SITE = os.path.abspath(sys.argv[1])
TEAM_DIR = os.path.join(SITE, 'team')
TEAM_JSON = os.path.join(TEAM_DIR, 'home-team.json')
UA = {'User-Agent': 'vgcdex-home-team/1.0 (+https://vgcdex.com)'}
comp = lambda s: re.sub(r'[^a-z0-9]', '', str(s).lower())


def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


def stamp():
    """Write the current team into index.html between window.VGCDEX_TEAM= and the next ';'."""
    team = json.load(open(TEAM_JSON)) if os.path.exists(TEAM_JSON) else None
    path = os.path.join(SITE, 'index.html')
    html = open(path, encoding='utf-8').read()
    value = 'null' if not team else json.dumps(team, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    new, n = re.subn(r'window\.VGCDEX_TEAM=(?:null|\{.*?\});', lambda _: f'window.VGCDEX_TEAM={value};', html, count=1)
    if not n: sys.exit('index.html has no window.VGCDEX_TEAM= marker')
    if new != html:
        open(path, 'w', encoding='utf-8').write(new)
        print('stamped index.html')


if '--stamp' in sys.argv[2:]:
    stamp(); sys.exit(0)

from PIL import Image  # only the update path needs it

core = json.load(open(os.path.join(SITE, 'data/m-c.json')))
species, megas = core['species'], core['mega_evolutions']
DEMONYM = {'alolan': 'alola', 'galarian': 'galar', 'hisuian': 'hisui', 'paldean': 'paldea', 'female': 'f'}
FILLER = {'form', 'forme', 'male', 'of', 'the', 'breed', 'flower', 'mode', 'style', 'unremarkable', 'phony', 'counterfeit'}


def words(s):
    return {DEMONYM.get(w, w) for w in re.findall(r'[a-z0-9]+', s.lower())} - FILLER


def resolve(mon):
    """Pokedata 'Tauros [Paldean Form - Combat Breed]' + item -> a Champions species or Mega row."""
    m = re.match(r'\s*([^\[]+?)\s*(?:\[(.*)\])?\s*$', mon['name'])
    base, form = m.group(1), m.group(2) or ''
    roots = [s for s in species if comp(s['name']) == comp(base) or s['showdown_id'] == comp(base)]
    pool = [s for s in species if roots and s['national_dex'] == roots[0]['national_dex']] or \
           [s for s in species if comp(s['name']).startswith(comp(base))]
    if not pool: return None
    want = words(form) - words(base)
    # most forme words in common, then fewest extra words (the plain species), then shortest name
    row = max(pool, key=lambda s: (len(want & words(s['name'])), -len(words(s['name']) - words(base) - want), -len(s['name'])))
    if want and not (want & words(row['name'])) and len(pool) > 1 and any(want & words(s['name']) for s in pool): return None
    item = comp(mon.get('item') or '')
    mega = next((x for x in megas if x['base_slug'] == row['slug'] and comp(x['mega_stone']) == item), None)
    if mega: return {'slug': mega['slug'], 'name': mega['name'], 'dex': row['national_dex']}
    return {'slug': row['slug'], 'name': row['name'], 'dex': row['national_dex']}


events = json.loads(fetch('https://pokedata.ovh/apiv2/tournaments'))['vg']['data']
regionals = [t for t in events if 'Regional Championships' in t['name'] and t.get('tournamentStatus') == 'finished'
             and (t.get('decklists') or 0) > 0 and (t.get('winners') or {}).get('masters')]
regionals.sort(key=lambda t: (t['date']['end'], int((t.get('players') or {}).get('masters') or 0)), reverse=True)
current = json.load(open(TEAM_JSON)) if os.path.exists(TEAM_JSON) else None

pick = None
for t in regionals[:6]:
    if current and (t['date']['end'], t['id']) <= (current['date'], current['event_id']): break  # nothing newer
    data = json.loads(fetch(f"https://pokedata.ovh/api/complete/?id={int(t['id'])}&division=masters&game=vg"))
    winner = next((p for p in data['data']['masters'] if p.get('placing') == 1), None)
    deck = (winner or {}).get('decklist') or []
    team = [resolve(x) for x in deck]
    if len(team) != 6 or not all(team):
        print(f"skip {t['name']}: winner's team does not resolve to six Champions entries: {[x['name'] for x in deck]}")
        continue
    pick = (t, winner, team); break

if not pick:
    print('no newer Regional with a usable team; keeping', current and current['event'])
    stamp(); sys.exit(0)

t, winner, team = pick
# PokéAPI official artwork, keyed by pokemon id; match the Champions name's words to a PokéAPI identifier
pokemon = list(csv.DictReader(io.StringIO(fetch('https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon.csv').decode())))


def art_id(mon):
    want = {w for w in re.findall(r'[a-z0-9]+', mon['name'].lower())} | ({'female'} if mon['name'].endswith('-F') else set())
    want = {('female' if w == 'f' else w) for w in want}
    pool = [r for r in pokemon if r['species_id'] == str(mon['dex'])]
    best = min(pool, key=lambda r: (len(want - set(r['identifier'].split('-'))), len(set(r['identifier'].split('-')) - want), r['is_default'] != '1'))
    return best['id']


os.makedirs(TEAM_DIR, exist_ok=True)
out = []
for mon in team:
    im = Image.open(io.BytesIO(fetch(f'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{art_id(mon)}.png'))).convert('RGBA')
    im = im.crop(im.getbbox())
    im = im.resize((round(im.width * 420 / im.height), 420), Image.LANCZOS)
    im.save(os.path.join(TEAM_DIR, mon['slug'] + '.webp'), quality=80, method=6)
    out.append({'slug': mon['slug'], 'name': mon['name'], 'w': im.width})
for f in os.listdir(TEAM_DIR):  # drop the previous team's art
    if f.endswith('.webp') and f[:-5] not in {m['slug'] for m in out}: os.remove(os.path.join(TEAM_DIR, f))
player = re.sub(r'\s*\[[A-Z]{2}\]$', '', winner['name'])
json.dump({'event': t['name'], 'event_id': t['id'], 'date': t['date']['end'], 'player': player, 'team': out},
          open(TEAM_JSON, 'w'), ensure_ascii=False, indent=1)
print(f"home team -> {t['name']} ({t['date']['end']}), {player}: {', '.join(m['name'] for m in out)}")
stamp()
