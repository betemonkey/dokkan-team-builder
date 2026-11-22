// Dokkan team builder: local web app. Run `node server.js`, open http://localhost:5177
const http = require('http');
const fs = require('fs');
const path = require('path');
const src = require('./lib/source');
const team = require('./lib/team');

const PORT = Number(process.env.PORT) || 5177;
// Where the box and the cache live: next to the code when run by hand, in the user's AppData when run by the app.
const DATA_DIR = process.env.DOKKAN_DATA || __dirname;

// Never let one bad request take the whole server down: log it and keep serving.
process.on('unhandledRejection', e => console.error('unhandled rejection:', e?.message || e));
process.on('uncaughtException', e => console.error('uncaught exception:', e?.message || e));

// In-game card art (the usual frame / character / rarity / type layers), proxied from
// dokkaninfo and cached on disk so each image is fetched once.
const ART_BASE = 'https://dokkaninfo.com/assets/global/en';
const ART_DIR = path.join(DATA_DIR, 'cache', 'art');
const RARE = { 3: 'ssr', 4: 'ur', 5: 'lr' };
const ART = {
  thumb: n => `/character/thumb/card_${n}_thumb/card_${n}_thumb.png`,                       // n = image id (ends in 0)
  frame: n => { const [t, r] = [Math.floor(n / 10), n % 10];                                   // n = type digit*10 + rarity
    return t <= 4 && RARE[r] ? `/layout/en/image/character/character_thumb_bg/cha_base_0${t}_0${r}.png` : null; },
  rare: n => RARE[n] ? `/layout/en/image/character/cha_rare_${RARE[n]}.png` : null,          // n = 3/4/5
  type: n => (n >= 10 && n <= 24) ? `/layout/en/image/character/cha_type_icon_${n}.png` : null, // n = 10..14 super, 20..24 extreme
};
fs.mkdirSync(ART_DIR, { recursive: true });
async function art(kind, n) {
  if (!Object.hasOwn(ART, kind) || !/^\d{1,8}$/.test(n)) return null;   // own keys only ("constructor" is not an art kind)
  const file = path.join(ART_DIR, `${kind}-${n}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const p = ART[kind](Number(n));
  if (!p) return null;
  const r = await fetch(ART_BASE + p, { headers: { 'User-Agent': 'dokkan-teambuilder (personal use)' } });
  if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}
const BOX_FILE = path.join(DATA_DIR, 'box.json');

const progress = new Map();    // build id -> latest step, for the loading animation
const cancelled = new Set();   // build ids the page no longer waits for (a newer build replaced them)
const readBox = () => { try { const b = JSON.parse(fs.readFileSync(BOX_FILE, 'utf8')); return Array.isArray(b) ? b : []; } catch { return []; } };
// The page's saved choices (tray, "I don't have it", kept leader, event), kept on disk: browser storage is tied to
// the page's address, and the desktop app gets a new port every launch, so it used to forget them on restart.
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_KEYS = ['dk-picks', 'dk-excluded', 'dk-leader', 'dk-event', 'dk-friend', 'dk-prev'];
const readState = () => { try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; } };
// Write to a temp file, then rename: a crash or a full disk mid-write can't leave a half-written box or state.
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const writeBox = b => writeAtomic(BOX_FILE, JSON.stringify(b, null, 2));

function send(res, code, data, type = 'application/json') {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

// JSON bodies only (a plain-text form post from another site is refused), and small.
function body(req, max = 10000) {
  return new Promise((ok, bad) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return bad(httpError(415, 'send JSON'));
    let s = '';
    req.on('data', c => { s += c; if (s.length > max) { bad(httpError(413, 'too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(httpError(400, 'bad JSON')); } });
  });
}

// Only answer requests made to this PC's address (blocks DNS-rebinding tricks), and only accept writes from this page.
function allowed(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  }
  return true;
}

const ids = (url, k) => (url.searchParams.get(k) || '').split(',').filter(x => /^\d{1,9}$/.test(x));

http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) return send(res, 403, { error: 'not allowed' });
    const url = new URL(req.url, 'http://localhost');   // inside the try: a malformed address is a 400, not a crash
    if (url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html');

    const am = url.pathname.match(/^\/art\/([a-z]+)\/(\d+)$/);
    if (am) {
      const buf = await art(am[1], am[2]);
      if (!buf) return send(res, 404, { error: 'no art' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800' });
      return res.end(buf);
    }

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (q.length < 3) return send(res, 200, []);
      return send(res, 200, (await src.search(q)).filter(t => !t.transformed));
    }

    if (url.pathname === '/api/box' && req.method === 'GET') return send(res, 200, readBox());

    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, readState());
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const s = await body(req, 200000);   // the "I don't have it" list can hold a few hundred units
      if (!s || typeof s !== 'object' || Array.isArray(s)) return send(res, 400, { error: 'state must be an object' });
      // known keys only, each a string (the page stores JSON text); anything too long is refused, not dropped
      const clean = {};
      for (const k of STATE_KEYS) {
        if (typeof s[k] !== 'string') continue;
        if (s[k].length > 100000) return send(res, 413, { error: `${k} too large` });
        clean[k] = s[k];
      }
      writeAtomic(STATE_FILE, JSON.stringify(clean));
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/box' && req.method === 'POST') {
      const { id } = await body(req);
      if (!/^\d{1,9}$/.test(String(id))) return send(res, 400, { error: 'bad unit id' });
      const box = readBox();
      if (!box.some(b => b.id === String(id))) {
        const u = await src.unit(id);
        box.push({ id: u.id, title: u.title, name: u.name, rarity: u.rarity, cls: u.cls, type: u.type, img: u.img });
        writeBox(box);
      }
      return send(res, 200, box);
    }

    if (url.pathname.startsWith('/api/box/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop();
      const box = readBox().filter(b => b.id !== id);
      writeBox(box);
      return send(res, 200, box);
    }

    if (url.pathname === '/api/unit') {
      const id = ids(url, 'id')[0];
      if (!id) return send(res, 400, { error: 'unit id needed' });
      return send(res, 200, await team.details(id, ids(url, 'leader')[0], ids(url, 'friend')[0]));
    }

    if (url.pathname === '/api/swap') {
      const leader = ids(url, 'leader')[0], slot = ids(url, 'slot')[0];
      if (!leader || !slot) return send(res, 400, { error: 'leader and slot needed' });
      // a team has 5 subs at most: more would make the rotation search explode (n! orders)
      const subs = [...new Set(ids(url, 'subs'))].slice(0, 5);
      return send(res, 200, await team.swapPreview(leader, subs, slot, [...new Set([slot, ...ids(url, 'cands')])].slice(0, 30),
        readBox().map(b => b.id), url.searchParams.get('festival') === '1', ids(url, 'friend')[0],
        { picks: ids(url, 'picks'), exclude: ids(url, 'exclude') }));
    }

    if (url.pathname === '/api/cancel') {
      const pid = (url.searchParams.get('pid') || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      if (pid) { cancelled.add(pid); setTimeout(() => cancelled.delete(pid), 120000); }
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/build') {
      const picks = ids(url, 'ids');
      if (!picks.length) return send(res, 400, { error: 'pick at least one unit' });
      // pid: the page's id for this build, so it can ask /api/progress how far along it is, or cancel it.
      const pid = (url.searchParams.get('pid') || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      try {
        return send(res, 200, await team.build(picks, readBox().map(b => b.id), url.searchParams.get('festival') === '1',
          { exclude: ids(url, 'exclude'), leader: ids(url, 'leader')[0], friend: ids(url, 'friend')[0], mine: url.searchParams.has('mine') ? ids(url, 'mine') : undefined, event: (url.searchParams.get('event') || '').replace(/[^a-z]/g, ''),
            progress: pid ? p => progress.set(pid, p) : null, cancelled: pid ? () => cancelled.has(pid) : null }));
      } finally { if (pid) setTimeout(() => progress.delete(pid), 5000); }
    }

    if (url.pathname === '/api/progress') {
      return send(res, 200, progress.get(url.searchParams.get('pid') || '') || null);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || (e.code === 'ERR_INVALID_URL' ? 400 : 500), { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`LISTENING ${PORT}`));   // this PC only, never the network

// Run by the desktop app: stop when the app is gone, even if it crashed.
const parent = Number(process.env.DOKKAN_PARENT_PID);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 3000);
