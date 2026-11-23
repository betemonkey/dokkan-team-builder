// Reads unit data from web-api.eu on demand, politely: disk cache, one request at a time.
const fs = require('fs');
const path = require('path');

const AJAX = 'https://www.web-api.eu/ajax_dokkan';
const IMG = 'https://www.web-api.eu/images/dokkan/';
const CACHE_DIR = path.join(process.env.DOKKAN_DATA || path.join(__dirname, '..'), 'cache');
const UNIT_TTL = 7 * 24 * 3600 * 1000;   // unit pages: a week
const SEARCH_TTL = 24 * 3600 * 1000;     // search results: a day
const GAP_MS = 400;                      // pause between live requests

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- polite queue ----------
let chain = Promise.resolve();
let liveRequests = 0;
function queued(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, GAP_MS)));
  return p;
}

async function post(body) {
  return queued(async () => {
    liveRequests++;
    const res = await fetch(AJAX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dokkan-teambuilder (personal use)' },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new Error(`web-api.eu answered ${res.status}`);
    return res.text();
  });
}

// Cache file per key. Simple keys keep their readable name (existing caches stay valid); anything with other
// characters gets a short hash added, so "goku's" and "goku_s" (or two non-Latin searches) never share a file.
function cacheFile(key) {
  if (/^[a-z0-9_-]{1,120}$/i.test(key)) return path.join(CACHE_DIR, key + '.html');
  const hash = require('crypto').createHash('sha1').update(key).digest('hex').slice(0, 10);
  return path.join(CACHE_DIR, key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 60) + '_' + hash + '.html');
}

// valid(html): only cache what looks like the real page (never a maintenance or error page).
async function cached(key, ttl, body, force, valid) {
  const f = cacheFile(key);
  if (!force && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl) return fs.readFileSync(f, 'utf8');
  const html = await post(body);
  if (valid && !valid(html)) throw Object.assign(new Error('the data site sent an unexpected page (maybe down for maintenance)'), { status: 502 });
  fs.writeFileSync(f, html);
  return html;
}

// ---------- parsing ----------
const decode = s => s
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// type_10..14 = Super AGL..PHY, type_20..24 = Extreme AGL..PHY (search tiles use the same numbers)
const TYPES = ['AGL', 'TEQ', 'INT', 'STR', 'PHY'];
function typeInfo(n) {
  n = Number(n);
  if (n >= 20) return { cls: 'Extreme', type: TYPES[n - 20] };
  if (n >= 10) return { cls: 'Super', type: TYPES[n - 10] };
  return { cls: '', type: TYPES[n] || '?' };
}

function imgId(id) { return String(id).slice(0, -1) + '0'; }

// Tiles from search results or partner lists.
function parseTiles(html) {
  const out = [];
  const re = /<div class='dchar_container[^']*' title='([^']*)' data-id='(\d+)'(?: data-uri='([^']*)')?>(.*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const inner = m[4];
    const rarity = (inner.match(/dokkan_assets\/([a-z]+)\.png' class='drarity'/) || [])[1] || '?';
    const t = (inner.match(/type_(\d+)\.png' class='dtype'/) || [])[1];
    const title = decode(m[1]);
    const dash = title.indexOf(' - ');
    out.push({
      id: m[2],
      title: dash > -1 ? title.slice(0, dash) : '',
      name: dash > -1 ? title.slice(dash + 3) : title,
      rarity: rarity.toUpperCase(),
      ...typeInfo(t),
      transformed: /dtransform/.test(inner),
      img: IMG + imgId(m[2]) + '.png',
    });
  }
  return out;
}

// A leader skill is one or more parts ("A" Category …; or "B" Category …). Each part has who it
// covers (categories, or a class/type scope), its ATK boost, and maybe an "additional" boost for a sub-group.
function scopeOf(head) {
  const tm = head.match(/(Super|Extreme)?\s*(AGL|TEQ|INT|STR|PHY)\s*Type/i);
  const cm = head.match(/(Super|Extreme) Class/i);
  const cap = w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : null;
  if (/All Types/i.test(head)) return { all: true };
  if (tm) return { cls: cap(tm[1]), type: tm[2].toUpperCase() };
  if (cm) return { cls: cap(cm[1]), type: null };
  return null;
}
function parseLeader(text) {
  const parts = [];
  for (const part of text.split(/;\s*(?:or\s+)?/)) {
    const [main, add = ''] = part.split(/,?\s*plus an additional/i);
    const head = main.split(/Ki \+|HP|ATK|DEF/)[0];
    const categories = /Category/.test(head) ? [...head.matchAll(/"([^"]+)"/g)].map(q => q[1]) : [];
    const scope = categories.length ? null : scopeOf(head);
    if (!categories.length && !scope) continue;
    const atk = Number((main.match(/ATK[^%;]*?\+(\d+)%/) || main.match(/\+(\d+)%/) || [])[1] || 0);
    const def = Number((main.match(/DEF[^%;]*?\+(\d+)%/) || [])[1] || 0);
    const ki = Number((main.match(/Ki \+(\d+)/) || [])[1] || 0);
    // HP: "HP +200% and ATK & DEF +170%" -> 200; "HP, ATK & DEF +170%" -> 170 (the first % after "HP")
    const hp = Number((main.match(/HP[^%;]*?\+(\d+)%/) || [])[1] || 0);
    const addCats = [...add.matchAll(/"([^"]+)"/g)].map(q => q[1]);
    const addPct = Number((add.match(/\+(\d+)%/) || [])[1] || 0);
    parts.push({ categories, scope, atk, def, ki, hp, add: addCats.length ? { categories: addCats, pct: addPct, def: /DEF/.test(add), hp: /HP/.test(add) } : null });
  }
  return {
    text,
    parts,
    categories: [...new Set(parts.flatMap(p => p.categories))],
    boost: Math.max(0, ...parts.map(p => p.atk + (p.add?.pct || 0))),
  };
}

// Stacking = PERMANENT only. A Super Attack raise with no turn limit keeps adding up every time it's used;
// a passive like "For every attack performed: ATK & DEF 10% (up to 80%)" climbs for the rest of the battle.
// Anything "for N turns", "within the turn" or "temporarily" doesn't count.
const TIMED = /for \d+ turns?|within the turn|for the turn|this turn|temporarily/i;
function parseStacking(html) {
  const sa = decode((html.match(/Super ATK<\/span>:(.*?)<\/div>/s) || [])[1] || '');
  const saStats = [];
  // A duration covers everything joined by "and" up to the next comma (checked against DokkanStats' Detailed view):
  //   "Greatly raises ATK, greatly raises DEF for 1 turn"  -> ATK permanent, DEF 1 turn
  //   "Greatly raises ATK and raises DEF for 1 turn"       -> both 1 turn
  // The clause ends at a comma/semicolon or where the damage part ("causes ...") starts.
  for (const m of sa.matchAll(/raises (ATK & DEF|ATK|DEF)\b/gi)) {
    if (/allies/i.test(sa.slice(Math.max(0, m.index - 12), m.index))) continue;   // ally buffs aren't self stacks
    const clause = sa.slice(m.index + m[0].length).split(/[,;]/)[0].split(/\bcauses\b/i)[0];
    if (TIMED.test(clause)) continue;
    for (const st of m[1].toUpperCase().split(' & ')) if (!saStats.includes(st)) saStats.push(st);
  }
  const passive = (html.match(/Passive<\/span>:(.*?)<\/div><div><span class='df_tag'>Category/s) || [])[1] || '';
  const lines = [];
  for (const m of passive.matchAll(/<strong>(.*?)<\/strong>\s*<ul>(.*?)<\/ul>/gs)) {
    const cond = decode(m[1]);
    if (!/for every|with each|each time|every time/i.test(cond) || TIMED.test(cond)) continue;
    for (const li of m[2].matchAll(/<li>(.*?)<\/li>/gs)) {
      const eff = decode(li[1]);
      if (TIMED.test(eff)) continue;   // "ATK 100% within the turn" resets: not a stack
      if (/(^|[^A-Za-z])(ATK|DEF)([^A-Za-z]|$)/.test(eff)) lines.push(cond + ": " + eff);
    }
  }
  return { superAttack: sa, saStats, passive: lines, score: saStats.length * 2 + lines.length * 2 };
}

// Passive as shown in game: sections (condition) with their effect lines. "up" = the line raises something.
function parsePassive(html) {
  const raw = (html.match(/Passive<\/span>:(.*?)<\/div><div><span class='df_tag'>Category/s) || [])[1] || '';
  return [...raw.matchAll(/<strong>(.*?)<\/strong>\s*<ul>(.*?)<\/ul>/gs)].map(m => {
    const cond = decode(m[1]);
    const stackCond = /for every|with each|each time|every time/i.test(cond) && !TIMED.test(cond);
    return {
      cond,
      fx: [...m[2].matchAll(/<li>(.*?)<\/li>/gs)].map(li => {
        // Keep the game's arrows where they sit (right after the number): ▲ raises, ▼ lowers.
        const text = decode(li[1].replace(/<img[^>]*alt="Up"[^>]*>/g, ' ▲ ').replace(/<img[^>]*alt="Down"[^>]*>/g, ' ▼ '))
          .replace(/\s+([▲▼])/g, ' $1');
        return { text, stacks: stackCond && !TIMED.test(text) && /(^|[^A-Za-z])(ATK|DEF)([^A-Za-z]|$)/.test(text) };
      }),
    };
  });
}

function parseUnit(id, html) {
  const h2 = (html.match(/<h2[^>]*><b>(.*?)<\/b>(.*?)<\/h2>/s) || []);   // names can wrap lines
  const rarity = ((html.match(/dokkan_assets\/([a-z]+)\.png' class='df_rarity'/) || [])[1] || '?').toUpperCase();
  const t = (html.match(/type_(\d+)\.png' class='df_type'/) || [])[1];
  const release = decode((html.match(/Released:<\/span>([^<]*)/) || [])[1] || '');
  // Type leaders show the type as an icon: turn it back into words before stripping tags.
  const leaderRaw = decode(((html.match(/Leader skill<\/span>:(.*?)<\/div>/s) || [])[1] || '')
    .replace(/<img[^>]*type_(\d+)\.png[^>]*>/g, (_, n) => {
      const ti = typeInfo(n);
      return ' ' + (ti.cls ? ti.cls + ' ' : '') + ti.type + ' ';
    }));
  const catRaw = (html.match(/Category<\/span>:(.*?)<\/div>/s) || [])[1] || '';
  const categories = catRaw.split(/<span class='df_tag'>-<\/span>/).map(decode).filter(Boolean);
  const links = [...html.matchAll(/<li class='df_char_link'[^>]*>(.*?)<\/li>/g)].map(m => decode(m[1]));
  const linkNames = links.map(l => l.replace(/\s*\[.*$/, ''));
  // data-switch holds the max-level (Lv 10) text of each link; most players have links maxed.
  const linksMax = [...html.matchAll(/<li class='df_char_link' data-switch='([^']*)'>/g)].map(m => decode(m[1]));

  // Partner list: grouped by number of shared links.
  const partners = [];
  for (const sec of html.split("<div class='dlk_section'>").slice(1)) {
    const n = Number((sec.match(/share (\d+) common/) || [])[1]);
    for (const tile of parseTiles(sec)) partners.push({ ...tile, shared: n });
  }

  return {
    id: String(id),
    title: decode(h2[1] || ''),
    name: decode(h2[2] || ''),
    rarity,
    ...typeInfo(t),
    release,
    leader: parseLeader(leaderRaw),
    stacking: parseStacking(html),
    passive: parsePassive(html),
    // Reversible Exchange: "Meets up with X and can perform Reversible Exchange" / "Can perform Reversible Exchange with X"
    exchangeWith: (() => {
      for (const s of parsePassive(html)) for (const t of [s.cond, ...s.fx.map(f => f.text)]) {
        const m = t.match(/Meets up with (.+?) and can perform\b.*Exchange/i) || t.match(/Exchange with (.+?)\s*$/i);
        if (m) return m[1].trim();
      }
      return null;
    })(),
    categories,
    links,
    linkNames,
    linksMax: linksMax.length === links.length ? linksMax : links,
    partners,
    img: IMG + imgId(id) + '.png',
  };
}

// ---------- public API ----------
async function search(q) {
  const html = await cached('search_' + q.toLowerCase(), SEARCH_TTL, { char: q });
  return parseTiles(html);
}

// opts.retryMissing: ignore a remembered "not found" (used for your picks: they come from a search, so they exist,
// and the site's "not found" is a plain HTTP 500 that a passing server error looks exactly like).
async function unit(id, force, opts = {}) {
  if (!/^\d{1,9}$/.test(String(id))) throw Object.assign(new Error('bad unit id'), { status: 400 });
  let html;
  // "not found" is remembered for 6 hours, so a build doesn't wait on the same unknown ids every time
  const miss = path.join(CACHE_DIR, `missing_${id}.txt`);
  if (!force && !opts.retryMissing && fs.existsSync(miss) && Date.now() - fs.statSync(miss).mtimeMs < 6 * 3600000)
    throw Object.assign(new Error(`unit ${id} not found`), { status: 404 });
  try {
    html = await cached('unit_' + id, UNIT_TTL, { link: id }, force, h => h.includes('dchar_full_data'));
    if (opts.retryMissing && fs.existsSync(miss)) { try { fs.unlinkSync(miss); } catch {} }
  }
  catch (e) {
    // web-api.eu answers 500 for an id it doesn't know
    if (/answered 500/.test(e.message)) {
      try { fs.writeFileSync(miss, String(Date.now())); } catch {}
      throw Object.assign(new Error(`unit ${id} not found`), { status: 404 });
    }
    throw e;
  }
  return parseUnit(id, html);
}

// The card a unit swaps into with Reversible Exchange: same title, a "transformed" form (id 4…),
// whose name matches who the passive says it meets up with. null if none / not an exchange unit.
async function exchangeForm(u) {
  if (!u.exchangeWith) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(u.exchangeWith);
  const tiles = (await search(u.title)).filter(t => t.transformed && t.id !== u.id && norm(t.title) === norm(u.title));
  const hit = tiles.find(t => norm(t.name).startsWith(want)) || tiles.find(t => norm(t.name).includes(want));
  return hit ? unit(hit.id) : null;
}

// ---------- whole categories (dokkanbattle.net lists every card of a category on one page) ----------
const DB_BASE = 'https://dokkanbattle.net';
const CAT_TTL = 7 * 24 * 3600 * 1000;

async function getCached(key, ttl, url, valid) {
  const f = cacheFile(key);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl) return fs.readFileSync(f, 'utf8');
  const html = await queued(async () => {
    liveRequests++;
    const res = await fetch(url, { headers: { 'User-Agent': 'dokkan-teambuilder (personal use)' } });
    if (!res.ok) throw new Error(`dokkanbattle.net answered ${res.status}`);
    return res.text();
  });
  // only keep pages that look real: a maintenance page would otherwise be "the data" for a week
  if (valid && !valid(html)) throw Object.assign(new Error('dokkanbattle.net sent an unexpected page'), { status: 502 });
  fs.writeFileSync(f, html);
  return html;
}

const normCat = s => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
let catIndex = null, catList = null;
async function categoryIds() {
  if (catIndex) return catIndex;
  const html = await getCached('db_categories', CAT_TTL, DB_BASE + '/categories', h => h.includes('data-catname'));
  const idx = new Map(), list = [];
  for (const m of html.matchAll(/href="\/category\/(\d+)"[^>]*data-catname="([^"]+)"/g)) {
    const name = decode(m[2]);
    if (!idx.has(normCat(name))) list.push({ name, id: m[1] });
    idx.set(normCat(name), m[1]);
  }
  if (idx.size) { catIndex = idx; catList = list; }   // an empty result isn't kept, so the next build tries again
  return idx;
}
// Every category ({ name, id }), A-Z: the category popup's list.
async function categoryList() {
  await categoryIds();
  return (catList || []).slice().sort((a, b) => a.name.localeCompare(b.name));
}
const fresh = (key, ttl) => { const f = cacheFile(key); return fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttl; };

// Every LR/UR card in a category: [{ id, rarity }]. IDs are the same as web-api.eu's.
// cacheOnly: answer from the disk cache or not at all (null), never from the network (the popup's card counts).
const membersMemo = new Map();   // category id -> { at: file time, list }, so the popup doesn't re-read 99 pages each time
async function categoryMembers(name, opts = {}) {
  const id = (await categoryIds()).get(normCat(name));
  if (!id) return [];
  const key = 'db_category_' + id;
  if (opts.cacheOnly && !fresh(key, CAT_TTL)) return null;
  const html = await getCached(key, CAT_TTL, `${DB_BASE}/category/${id}`, h => h.includes('/card/'));
  const at = fs.statSync(cacheFile(key)).mtimeMs, memo = membersMemo.get(id);
  if (memo && memo.at === at) return memo.list;
  const out = new Map();
  for (const m of html.matchAll(/href="\/card\/(\d+)"[\s\S]*?class="rarity (\w+)"/g)) {
    if ((m[2] === 'LR' || m[2] === 'UR') && !out.has(m[1])) out.set(m[1], { id: m[1], rarity: m[2] });
  }
  const list = [...out.values()];
  membersMemo.set(id, { at, list });
  return list;
}
// Fetches the category pages that aren't cached yet, one at a time through the polite queue, in the background
// (first: the names given, e.g. the categories your units are in). Only one runs at a time.
let warming = null;
function warmCategories(first = []) {
  if (warming) return warming;
  warming = (async () => {
    const list = await categoryList(), want = new Set(first.map(normCat));
    for (const c of [...list.filter(c => want.has(normCat(c.name))), ...list.filter(c => !want.has(normCat(c.name)))]) {
      if (fresh('db_category_' + c.id, CAT_TTL)) continue;
      try { await categoryMembers(c.name); } catch {}
    }
  })().catch(() => {}).finally(() => { warming = null; });
  return warming;
}

// Max-level stats of a card (dokkanbattle.net card page). Uses the most awakened state listed (EZA/SEZA when there is one)
// with full Hidden Potential; also returns the value without potential. null when the card page has none.
async function cardStats(id) {
  const html = await getCached('db_card_' + id, CAT_TTL, `${DB_BASE}/card/${id}`, h => h.includes('"states"'));
  const states = [...html.matchAll(/"label":"([^"]+)","lv_max":\d+,"skill_lv_max":(\d+),"stats":\{"hp":(\d+),"atk":(\d+),"def":(\d+),"leveled":\{"hp":(\d+),"atk":(\d+),"def":(\d+)\}/g)]
    .map(m => ({ label: m[1], saLvMax: +m[2], hp: +m[3], atk: +m[4], def: +m[5], defNoPot: +m[8] }));
  if (!states.length) return null;
  const st = states[states.length - 1];
  // Super Attacks: Ki needed, text (for ATK raises), damage base and per-level gain (DokkanStats: 100% + base + gain x (Lv - 1)).
  // The last block on the page is the most awakened state's, like the stats.
  const blocks = [...html.matchAll(/"supers":(\[[^\]]*\])/g)];
  let supers = [];
  try { supers = JSON.parse(blocks.length ? blocks[blocks.length - 1][1] : '[]').map(s => ({ ki: s.ki, style: s.style, name: s.name, desc: String(s.desc || '').replace(/\s+/g, ' '), base: +s.increase_rate || 0, gain: +s.lv_bonus || 0 })); } catch {}
  // Ki multiplier curve of this card (percent): at 12 Ki and at 24 Ki (LRs).
  const num = k => { const all = [...html.matchAll(new RegExp(`"${k}":(\\d+)`, 'g'))]; return all.length ? +all[all.length - 1][1] : null; };
  const kiMult = { at12: num('eball_mod_mid') || 150, at24: num('eball_mod_max') || null };
  return { ...st, supers, kiMult };
}

// Card stats are read many times per build (the event simulation tries hundreds of line-ups): keep each parsed
// result in memory for the life of the server, on top of the disk cache. A failed read isn't kept.
// A failed read is remembered for 10 minutes too, so one missing card isn't refetched over and over in a build.
const statsMemo = new Map();
function cardStatsMemo(id) {
  const key = String(id);
  if (!statsMemo.has(key)) statsMemo.set(key, cardStats(key).catch(e => { setTimeout(() => statsMemo.delete(key), 600000).unref?.(); throw e; }));
  return statsMemo.get(key);
}

module.exports = { search, unit, exchangeForm, categoryMembers, categoryList, warmCategories, normCat, cardStats: cardStatsMemo,
  stats: () => ({ liveRequests }), _parseLeader: parseLeader };
