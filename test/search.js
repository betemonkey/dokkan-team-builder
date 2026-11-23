// Searching from the first letter. The unit site's own search answers nothing under 3 letters, and the app waited for
// a 3rd letter too, so "hi" never showed Hit and "4" never showed the Super Saiyan 4s (reported 2026-11-23).
// This asks the real server, on real data, what every search box gets, and checks that the page sends short
// searches at all. Returns the problems it finds (none = pass).
// Run alone:  node test/search.js
const fs = require('fs');
const path = require('path');
const { freePort, startServer } = require('./state');
const src = require('../lib/source');

const ROOT = path.join(__dirname, '..');
const words = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const startsAWord = (name, w) => words(name).some(x => x.startsWith(w));
const names = list => list.slice(0, 3).map(u => u.name).join(', ');

module.exports = async function searchTest() {
  const fails = [];
  // The page: no search box (Build a team, My box, the Replace picker) waits for a 3rd letter.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const waits = (html.match(/\bq\.length\s*<\s*3\b/g) || []).length;
  if (waits) fails.push(`the page still ignores searches under 3 letters (${waits} search boxes)`);

  // The server, with the app's own data folder (searching only reads it).
  const port = await freePort();
  const server = await startServer(ROOT, port);
  const ask = async q => {
    const r = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error(`"${q}" answered HTTP ${r.status}`);
    return r.json();
  };
  try {
    // the report's two examples
    const hi = await ask('hi');
    if (!hi.some(u => u.name === 'Hit')) fails.push(`"hi" doesn't find Hit (${hi.length} results)`);
    const offHi = hi.filter(u => !startsAWord(u.name, 'hi'));
    if (offHi.length) fails.push(`"hi" also finds names where no word starts with "hi": ${names(offHi)}`);
    const four = await ask('4');
    for (const n of ['Super Saiyan 4 Goku', 'Super Saiyan 4 Vegeta', 'Super Saiyan 4 Gogeta'])
      if (!four.some(u => u.name === n)) fails.push(`"4" doesn't find ${n} (${four.length} results)`);
    const off4 = four.filter(u => !startsAWord(u.name, '4'));
    if (off4.length) fails.push(`"4" also finds names without a word starting with 4: ${names(off4)}`);

    // several words: each one has to start a word of the name. From 3 letters the site's own answer is kept too, and it
    // also matches titles ("Androids Hunting for Goku - Androids #14 & #15"), so those may follow, never come first.
    const both = await ask('goku 4');
    if (!both.some(u => u.name === 'Super Saiyan 4 Goku')) fails.push(`"goku 4" doesn't find Super Saiyan 4 Goku (${both.length} results)`);
    const isName = u => startsAWord(u.name, 'goku') && startsAWord(u.name, '4');
    const firstOther = both.findIndex(u => !isName(u)), lateName = both.findIndex((u, i) => i > firstOther && isName(u));
    if (firstOther >= 0 && lateName >= 0) fails.push(`"goku 4": ${both[lateName].name} (a name match) comes after ${both[firstOther].name} (not one)`);

    // 3 letters and more: everything the site's own search found is still there (it also matches titles and the
    // middle of a word, like Tagoma for "goma"), with the best matches first
    const site = (await src.search('goma')).filter(t => !t.transformed);
    const goma = await ask('goma');
    const lost = site.filter(t => !goma.some(u => u.id === t.id));
    if (lost.length) fails.push(`"goma" lost ${lost.length} of the site's own results: ${names(lost)}`);
    const iG = goma.findIndex(u => u.name === 'Third Eye Gomah'), iT = goma.findIndex(u => u.name === 'Tagoma');
    if (iG < 0 || iT < 0 || iG > iT) fails.push(`"goma": Third Eye Gomah (at ${iG}) should come before Tagoma (at ${iT})`);
    const hit = await ask('hit');
    if (!hit.length || !/^hit\b/i.test(hit[0].name)) fails.push(`"hit": the first result is ${hit[0]?.name || 'nothing'}, not a Hit`);

    // one letter: a short list, names that start with it first
    const g = await ask('g');
    if (!g.length || g.length > 60) fails.push(`"g" gives ${g.length} results (expected 1 to 60)`);
    else if (!/^g/i.test(g[0].name)) fails.push(`"g": the first result (${g[0].name}) doesn't start with G`);

    // every result is a card you can own, with what the page's cells need
    const all = [...hi, ...four, ...both, ...goma, ...hit, ...g];
    const ex = all.filter(u => u.transformed || /^4\d{6}$/.test(u.id));
    if (ex.length) fails.push(`exchanged forms in the results: ${names(ex)}`);
    const thin = all.filter(u => !/^\d+$/.test(u.id) || !u.name || !u.rarity || !u.type);
    if (thin.length) fails.push(`results missing an id, name, rarity or type: ${thin.slice(0, 3).map(u => JSON.stringify(u)).join(' ')}`);
  } finally {
    await new Promise(r => { server.once('exit', r); server.kill(); });
  }
  return fails;
};

if (require.main === module) {
  module.exports().then(f => {
    console.log(f.length ? `FAIL\n${f.map(x => '   - ' + x).join('\n')}` : 'pass');
    process.exit(f.length ? 1 : 0);
  }, e => { console.log(`FAIL: ${e.message}`); process.exit(1); });
}
