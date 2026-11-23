// Saved choices with the app open twice. Each app window has its own address, so its own browser storage, but both
// share one state file. This runs the page's own save code (taken from public/index.html) in simulated windows
// against the real server, in a throwaway data folder, and returns the problems it finds (none = pass).
// Run alone:  node test/state.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function pageSaveCode() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const a = html.indexOf('const STATE_KEYS = ['), b = html.indexOf('function loadSaved(');
  if (a < 0 || b < a) throw new Error("the page's save code was not found");
  return html.slice(a, b);
}

const freePort = () => new Promise((ok, bad) => {
  const s = net.createServer().once('error', bad).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});

function startServer(dir, port) {
  return new Promise((ok, bad) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server.js')],
      { env: { ...process.env, PORT: String(port), DOKKAN_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { p.kill(); bad(new Error('the server did not start')); }, 15000);
    p.stdout.on('data', d => { if (String(d).includes('LISTENING')) { clearTimeout(t); ok(p); } });
    p.once('exit', c => { clearTimeout(t); bad(new Error(`the server stopped (${c})`)); });
  });
}

// One app window: its own storage and timers, the page's save code, and the real server behind fetch.
function openWindow(code, base, inflight, warns, firstRead, stored = {}) {
  const store = new Map(Object.entries(stored));
  const timers = new Map();
  const hide = [];
  let next = 0, sent = 0, failures = 0;
  const win = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    },
    XMLHttpRequest: class { open() {} send() { this.status = 200; this.responseText = firstRead; } },   // the page's one synchronous read
    fetch: (url, opts = {}) => {
      const save = (opts.method || 'GET') !== 'GET';
      if (save) sent++;
      const p = save && failures > 0 ? (failures--, Promise.reject(new TypeError('Failed to fetch'))) : fetch(base + url, opts);
      inflight.push(p.then(() => {}, () => {}));
      return p;
    },
    setTimeout: fn => { timers.set(++next, fn); return next; },
    clearTimeout: id => { timers.delete(id); },
    addEventListener: (ev, fn) => { if (ev === 'pagehide') hide.push(fn); },
    console: { log() {}, warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')) },
  };
  vm.createContext(win);
  vm.runInContext(code, win);
  const settle = () => Promise.all(inflight.splice(0));   // wait for the requests sent so far
  const flush = async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await settle(); };   // the save pause went by
  const close = async () => { for (const fn of hide) fn({}); timers.clear(); await settle(); };
  return {
    get: k => (store.has(k) ? store.get(k) : null),
    sent: () => sent,
    failNextSave: () => { failures++; },   // the next save doesn't reach the server
    flush,
    close,
    change: async (k, v) => { store.set(k, v); win.syncState(); await flush(); },
    changeThenClose: async (k, v) => { store.set(k, v); win.syncState(); await close(); },   // closed before the save pause
  };
}

module.exports = async function stateTest() {
  const code = pageSaveCode();
  fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 'cache', 'test-state-'));   // cache/ is git-ignored
  const port = await freePort();
  const server = await startServer(dir, port).catch(e => { fs.rmSync(dir, { recursive: true, force: true }); throw e; });
  const base = `http://127.0.0.1:${port}`;
  const fails = [], warns = [], inflight = [];
  const saved = async () => (await fetch(base + '/api/state')).json();
  const open = async stored => openWindow(code, base, inflight, warns, await (await fetch(base + '/api/state')).text(), stored);
  const picks = (...ids) => JSON.stringify(ids.map(id => ({ id, name: 'Unit ' + id })));
  try {
    // First launch: nothing saved yet, so what this browser already had is kept and written to the file.
    const A = await open({ 'dk-event': 'festival' });
    await A.flush();
    let s = await saved();
    if (s['dk-event'] !== 'festival') fails.push(`first launch: the event this browser had was not saved (${s['dk-event']})`);

    // Window A picks units. The app is opened a second time (window B), which picks other units.
    await A.change('dk-picks', picks('1'));
    const B = await open();
    if (B.get('dk-picks') !== picks('1')) fails.push('the second window did not open with the saved picks');
    await B.change('dk-picks', picks('2'));

    // The older window changes only the event: that change is saved, and the newer picks stay.
    await A.change('dk-event', 'meteor');
    s = await saved();
    if (s['dk-picks'] !== picks('2')) fails.push('a change in the older window put its old picks back over the newer ones');
    if (s['dk-event'] !== 'meteor') fails.push(`the older window's event change was not saved (${s['dk-event']})`);

    // Closing the older window doesn't put its old picks back either.
    await A.close();
    s = await saved();
    if (s['dk-picks'] !== picks('2')) fails.push('closing the older window put its old picks back over the newer ones');

    // A change made just before closing is still saved.
    const cats = JSON.stringify({ sel: ['Pure Saiyans'], mode: 'and' });
    await B.changeThenClose('dk-cats', cats);
    s = await saved();
    if (s['dk-cats'] !== cats) fails.push('a change made just before closing was lost');

    // The next launch opens with the newest of everything, and closing it after no change sends nothing.
    const C = await open();
    for (const [k, v] of Object.entries({ 'dk-picks': picks('2'), 'dk-event': 'meteor', 'dk-cats': cats }))
      if (C.get(k) !== v) fails.push(`the next launch opened with ${k} = ${C.get(k)}`);
    await C.close();
    if (C.sent()) fails.push(`a window that changed nothing sent ${C.sent()} save(s) when closed`);

    // A save that doesn't reach the server is sent again with the next change.
    const D = await open(), w0 = warns.length;
    D.failNextSave();
    await D.change('dk-excluded', '["1016871"]');
    await D.change('dk-friend', '{"id":"1030431","name":"Goku"}');
    s = await saved();
    if (s['dk-excluded'] !== '["1016871"]') fails.push('a save that failed was not sent again with the next change');
    if (s['dk-friend'] !== '{"id":"1030431","name":"Goku"}') fails.push('the change after a failed save was not saved');
    if (warns.length !== w0 + 1) fails.push(`the failed save gave ${warns.length - w0} warnings, not 1`);
    warns.splice(w0);   // that one was expected
    await D.close();

    // The server: a save merges into the file, and a refused one changes nothing.
    const before = JSON.stringify(await saved());
    const write = async (method, body) =>
      (await fetch(base + '/api/state', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status;
    let st = await write('PATCH', { 'dk-picks': 7 });
    if (st !== 400) fails.push(`a save with a number instead of text answered ${st}, not 400`);
    st = await write('PATCH', { 'dk-picks': 'x'.repeat(100001) });
    if (st !== 413) fails.push(`an oversized save answered ${st}, not 413`);
    st = await write('PUT', {});
    if (st === 200) fails.push('a PUT still replaces the whole file');
    if (JSON.stringify(await saved()) !== before) fails.push('a refused save changed the file');
    st = await write('PATCH', { 'dk-leader': '"1030481"', 'not-a-choice': 'x' });
    s = await saved();
    if (st !== 200 || s['dk-leader'] !== '"1030481"' || 'not-a-choice' in s || s['dk-picks'] !== picks('2'))
      fails.push(`a one-choice save did not merge cleanly (${st}: ${JSON.stringify(s).slice(0, 160)})`);

    if (warns.length) fails.push(`the page reported failed saves: ${warns.slice(0, 3).join(' | ')}`);
  } finally {
    await new Promise(r => { server.once('exit', r); server.kill(); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return fails;
};

// for the other tests that need the real server
Object.assign(module.exports, { freePort, startServer });

if (require.main === module) {
  module.exports().then(f => {
    console.log(f.length ? `FAIL\n${f.map(x => '   - ' + x).join('\n')}` : 'pass');
    process.exit(f.length ? 1 : 0);
  }, e => { console.log(`FAIL: ${e.message}`); process.exit(1); });
}
