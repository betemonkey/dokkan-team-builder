// The 🛡 DEF check panel (approved mockup: mockups/def-readable.html, option A, picked 2026-11-23). Asked the same day:
// show how much DEF each unit needs to take 0 damage, not how much it's short.
// This builds a real Festival team, runs the page's own defCheck() on it (as the page gets it from the
// server), and checks that every unit shows the DEF it needs against normal attacks AND against the Super, the same
// numbers the model has, ✓ only when it has that DEF, and never a "short" amount. Returns the problems (none = pass).
// Run alone:  node test/defcheck.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const team = require('../lib/team');

const ROOT = path.join(__dirname, '..');
const POS = ['r1a', 'r1b', 'r2a', 'r2b', 'f1', 'f2', 'f3'];
const BEATS = { STR: 'PHY', PHY: 'INT', INT: 'TEQ', TEQ: 'AGL', AGL: 'STR' };   // each type beats the next one

function pageCheckCode() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const esc = html.match(/^const esc = .*$/m);
  const a = html.indexOf('const CHECK_SLOT'), b = html.indexOf('function drawMaps(');
  if (!esc || a < 0 || b < a) throw new Error("the page's DEF check code was not found");
  return esc[0] + '\n' + html.slice(a, b);
}
const k = x => x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : Math.round(x / 1e3) + 'k';
const short = x => x >= 1e6 ? +(x / 1e6).toFixed(2) + 'M' : Math.round(x / 1e3) + 'k';   // 7M, 24.5M
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = h => unesc(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

module.exports = async function defCheckTest() {
  const fails = [];
  const ctx = vm.createContext({});
  vm.runInContext(pageCheckCode() + '\nthis.defCheck = defCheck;', ctx);
  const BOX = ['1032311', '1031921', '1021671'];
  const r = await team.build(['1031921', '1032311', '1021671'], BOX, true, { event: 'festival' });
  const t = JSON.parse(JSON.stringify(r.teams[0]));   // what the page gets from the server
  const html = ctx.defCheck(t);
  if (!html) return ['the DEF check is empty for a Festival team'];
  if (/\bshort\b/i.test(text(html))) fails.push('the DEF check still shows how much a unit is short');

  // the hits it is measured against, straight from the event data
  const ev = team._t.eventOf('festival'), boss = ev.enemies[ev.enemies.length - 1];
  const atk = boss.atk * (1 + (boss.saAtkBoostPct || 0) / 100);
  if (!html.includes(`<b>Normal attacks</b> · ${short(atk)}`)) fails.push(`the normal attacks column doesn't say ${short(atk)}`);
  if (!html.includes(`<b>Super Attack</b> · ${short(boss.superDamage)}`)) fails.push(`the Super Attack column doesn't say ${short(boss.superDamage)}`);
  for (const g of ['Rotation 1', 'Rotation 2', 'Floaters']) if (!html.includes(`>${g}<`)) fails.push(`no "${g}" group`);

  const byId = Object.fromEntries(t.members.map(m => [m.id, m]));
  const okCount = { normal: 0, super: 0 };
  let shown = 0;
  for (const pos of POS) {
    const sv = t.map.stats[pos]?.surv;
    if (!sv) continue;
    shown++;
    const e = sv.lastEnemies[sv.lastEnemies.length - 1], m = pos === 'f3' ? t.friend : byId[t.map.slots[pos]];
    if (!html.includes(`title="${m.name.replace(/&/g, '&amp;')}\n`)) fails.push(`${pos}: no row titled ${m.name}`);
    const never = e.def ?? sv.stacked, stacks = e.defIfAttacks ?? never;
    const two = sv.role !== 'first' && Math.round(stacks) !== Math.round(never), best = two ? stacks : never;
    // what gets through is halved when it guards or its type beats the enemy's
    const type = w => (w || '').split(' ').pop();
    const halved = e.guard || (!!sv.me && !!e.vs && BEATS[type(sv.me)] === type(e.vs));
    for (const [hit, need] of [['normal', e.normal], ['super', e.super]]) {
      const c = html.match(new RegExp(`<div class="cell" data-pos="${pos}" data-hit="${hit}" title="([^"]*)">[\\s\\S]*?<span class="res (ok|bad)">([✓✗]) needs <span class="n">([^<]+)</span></span>`));
      if (!c) { fails.push(`${pos} ${m.name}: no "needs" result against ${hit === 'super' ? 'the Super' : 'normal attacks'}`); continue; }
      const [, tip, cls, mark, shownNeed] = c, ok = best >= need;
      if (shownNeed !== k(need)) fails.push(`${pos} ${m.name}, ${hit}: shows needs ${shownNeed}, the model says ${k(need)}`);
      if ((mark === '✓') !== ok || (cls === 'ok') !== ok) fails.push(`${pos} ${m.name}, ${hit}: shows ${mark}, but it has ${k(best)} for ${k(need)}`);
      if (ok) okCount[hit]++;
      const takes = Math.max(0, need - best) * (halved ? 0.5 : 1);
      if (hit === 'super' && takes && !unesc(tip).includes(`one Super would still deal ~${k(takes)}`))
        fails.push(`${pos} ${m.name}: the Super tooltip should say one Super would still deal ~${k(takes)}`);
    }
  }
  if (shown < 5) fails.push(`only ${shown} units in the DEF check`);

  // Reported 2026-11-23 (approved mockup: mockups/def-align.html, option A): the "1 of 7 ✓" count lined up with nothing,
  // and the legend's orange "if it stacks" swatch read as if only the orange stripes meant that. So: the count and every "needs X"
  // end on the column's right edge, the three header lines sit level, and the legend swatches are neutral grey.
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const rule = sel => (page.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  if (!/text-align:\s*right/.test(rule('.defchk .res'))) fails.push('the "needs X" results are not right-aligned under the count');
  if (!/float:\s*right/.test(rule('.defchk .hd .cnt'))) fails.push('the "N of 7 ✓" count is not on the column\'s right edge');
  if (!/align-self:\s*end/.test(rule('.defchk .hd'))) fails.push('the header lines are not level (the empty one over the names sits higher)');
  const leg = (html.match(/<div class="leg">([\s\S]*?)<\/div>/) || [])[1] || '';
  if (/class="(now|st)\b/.test(leg)) fails.push('the legend still uses the bars\' red / orange swatches');
  if (!/class="gsolid"/.test(leg) || !/class="gstripe"/.test(leg)) fails.push('the legend has no grey solid and striped swatches');
  if (!/green<\/b> = enough/.test(leg)) fails.push('the legend doesn\'t say green = enough');
  for (const hit of ['normal', 'super']) {
    const label = hit === 'normal' ? 'Normal attacks' : 'Super Attack';
    const h = html.match(new RegExp(`<b>${label}</b>[^<]*<span class="cnt[^"]*"[^>]*>(\\d+) of (\\d+) ✓</span>`));
    if (!h) fails.push(`the ${label} column has no "N of ${shown} ✓" count`);
    else if (+h[1] !== okCount[hit] || +h[2] !== shown) fails.push(`the ${label} column counts ${h[1]} of ${h[2]} ✓, the units say ${okCount[hit]} of ${shown}`);
  }
  return fails;
};

if (require.main === module) {
  module.exports().then(f => {
    console.log(f.length ? `FAIL\n${f.map(x => '   - ' + x).join('\n')}` : 'pass');
    process.exit(f.length ? 1 : 0);
  }, e => { console.log(`FAIL: ${e.message}`); process.exit(1); });
}
