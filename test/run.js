// Scenario tests for the team builder. Builds real teams (from the cached site data, fetching what's missing)
// and checks the rules a Dokkan player never breaks, on every team of every scenario, in every event mode.
// Run:  node test/run.js            all scenarios, all modes
//       node test/run.js --quick    first 4 scenarios, Festival mode only
// Exit code 1 when any rule fails, so it can gate a release.
const team = require('../lib/team');

const BOX = ['1032311', '1031921', '1021671'];   // Monkey's registered box (his three picks)
const SCENARIOS = [
  { name: 'Broly (Wrathful) + Gomah + LSSJ Broly', picks: ['1031921', '1032311', '1021671'] },
  { name: '... + SSJ4 Vegeta + SSJ4 Goku (exchange)', picks: ['1031921', '1032311', '1021671', '1032881'] },
  { name: 'Vegeta (Angel) + Goku (Angel) exchange alone', picks: ['1030481'] },
  { name: 'Angel exchange + Gomah + both Brolys', picks: ['1030481', '1032311', '1031921', '1021671'] },
  { name: 'Majin Vegeta + SS2 Goku (Angel) exchange', picks: ['1033061'] },
  { name: 'Old LR SSJ4 Goku & Vegeta', picks: ['1022421'] },
  { name: 'Six picks (no open slot)', picks: ['1032311', '1031921', '1021671', '1033061', '1028491', '1018491'] },
  { name: 'Single UR (DAIMA SSJ4 Goku Mini)', picks: ['1032261'] },
  { name: 'Golden Frieza + Gogeta', picks: ['1031721'] },
  { name: 'Mixed classes, no shared category', picks: ['1032311', '1018491', '1030481'] },
  { name: 'Locked leader that misses a pick (SS2 Gohan Youth)', picks: ['1031921', '1032311', '1021671'], opts: { leader: '1030391' }, locked: true },
  { name: 'Top leaders marked "I don\'t have it"', picks: ['1031921', '1032311', '1021671'], opts: { exclude: ['1030481', '1028021', '1030471', '1016871', '1033061'] } },
  // Reported 2026-11-22: the DAIMA SSJ4 Goku (Mini) came back as leader AND friend. It doesn't stack and no posted
  // clear used it, while leaders that stack also boost all three picks. lasting: no added unit may fail.
  { name: 'Gomah + Broly (Wrathful) + Buu (Kid)', picks: ['1032311', '1031921', '1034151'], lasting: true },
];
const MODES = [
  { key: 'none', festival: false, event: '' },
  { key: 'festival', festival: true, event: 'festival' },
  { key: 'meteor', festival: true, event: 'meteor' },
];

const baseId = m => (m.startsAs && m.exchange ? m.exchange.id : m.id);
const formNames = m => [m.name, m.exchange?.name].filter(Boolean);

// Every rule, on every team. Returns a list of human-readable failures.
function check(r, sc, mode) {
  const fails = [];
  // what you asked for, not what happened to load: a pick that silently fails to load must show up here
  const pickIds = new Set(sc.picks);
  const excluded = new Set(sc.opts?.exclude || []);
  if (!r.teams?.length) return ['no team built'];
  r.teams.forEach((t, i) => {
    const tag = `team ${i + 1}`;
    const ids = t.members.map(baseId);
    if (t.members.length > 6) fails.push(`${tag}: ${t.members.length} members (max 6 + friend)`);
    if (!t.friend) fails.push(`${tag}: no friend`);
    else {
      if (/^4\d{6}$/.test(baseId(t.friend))) fails.push(`${tag}: the friend is an exchanged form, not a card`);
      if (!t.friend.covered) fails.push(`${tag}: the friend gets no leader boost`);
    }
    for (const p of pickIds) if (!ids.includes(p)) fails.push(`${tag}: pick ${p} is not in the team`);
    // Rule: the game allows one card per name (both forms of an exchange unit count); the friend may copy the leader.
    for (let a = 0; a < t.members.length; a++)
      for (let b = a + 1; b < t.members.length; b++)
        if (formNames(t.members[a]).some(n => formNames(t.members[b]).includes(n)))
          fails.push(`${tag}: same name twice: ${t.members[a].name} / ${t.members[b].name}`);
    for (const m of t.members) {
      const id = baseId(m);
      if (/^4\d{6}$/.test(id) && !pickIds.has(id)) fails.push(`${tag}: ${m.name} is an exchanged form, not a card you can own`);
      if (excluded.has(id) && !pickIds.has(id)) fails.push(`${tag}: ${m.name} is marked "I don't have it" but is in the team`);
      // Rule: every non-pick unit is boosted by the leader skills (an unboosted filler is never the right call).
      if (!m.pick && !m.covered) fails.push(`${tag}: ${m.name} gets no leader boost`);
    }
    // Rule: an unboosted pick is only acceptable when the team says so (locked leader / no leader covers all).
    const unboosted = t.members.filter(m => m.pick && !m.covered).map(m => m.name);
    if (unboosted.length && !(t.uncoveredPicks || []).length)
      fails.push(`${tag}: your pick(s) ${unboosted.join(', ')} get no leader boost and the team doesn't warn about it`);
    // Event mode with clear data: every team says how much of it players cleared with.
    if (mode.event === 'festival') {
      const p = t.proven;
      if (!p) fails.push(`${tag}: no clear-data summary`);
      else if (!(p.inClears >= 0 && p.inClears <= p.of && p.of === t.members.length)) fails.push(`${tag}: clear summary says ${p.inClears} of ${p.of}`);
    }
    // Rule (events): the builder only adds units that last (they stack, or players cleared the event with them).
    // Any unit that doesn't (your pick, a kept leader, or the only way to boost every pick) is named in a ⚠ note.
    const all = [...t.members, t.friend].filter(Boolean);
    if (mode.event) {
      if (all.some(m => !m.fit)) fails.push(`${tag}: a unit has no event-fit info`);
      const bad = all.filter(m => m.fit && !m.fit.ok);
      // (notes name the card as it starts: a unit shown in its exchanged form carries that name in startsAs)
      for (const m of bad) if (!(t.fitNotes || []).some(n => n.startsWith(m.startsAs || m.name))) fails.push(`${tag}: ${m.name} won't last and the team doesn't say so`);
      // added by the builder: every non-pick slot, and the friend always (even a copy of your pick)
      const addedBad = bad.filter(m => !m.pick || m.role === 'Friend');
      if (t.unfit !== addedBad.length) fails.push(`${tag}: unfit says ${t.unfit}, the team has ${addedBad.length} added unit(s) that won't last`);
      if (sc.lasting && addedBad.length) fails.push(`${tag}: added unit(s) that won't last: ${addedBad.map(m => m.name).join(', ')}`);
      if (sc.lasting && all.some(m => baseId(m) === '1032261')) fails.push(`${tag}: the DAIMA SSJ4 Goku (Mini) is in the team again`);
    } else if (all.some(m => m.fit) || (t.fitNotes || []).length) fails.push(`${tag}: event-fit info without an event`);
  });
  // Events: among teams boosting the same number of picks, fewer added units that won't last come first.
  if (mode.event) {
    const cov = t => t.members.filter(m => m.pick && m.covered).length;
    const list = sc.locked ? r.teams.slice(1) : r.teams;
    for (let i = 1; i < list.length; i++)
      if (cov(list[i]) === cov(list[i - 1]) && list[i].unfit < list[i - 1].unfit)
        fails.push(`team ${i + 1 + (sc.locked ? 1 : 0)} adds fewer units that won't last than the team above it`);
  }
  // Event mode: among teams boosting the same number of picks (with as many units that won't last), the one closer
  // to real clears comes first.
  if (mode.event === 'festival') {
    const cov = t => t.members.filter(m => m.pick && m.covered).length;
    const list = sc.locked ? r.teams.slice(1) : r.teams;
    for (let i = 1; i < list.length; i++)
      if (cov(list[i]) === cov(list[i - 1]) && list[i].unfit === list[i - 1].unfit && (list[i].proven?.score || 0) > (list[i - 1].proven?.score || 0) + 1e-9)
        fails.push(`team ${i + 1 + (sc.locked ? 1 : 0)} is closer to real clears than the team above it`);
    // the proven-teams list: real 7-unit teams, closest to your picks first
    const P = r.proven;
    if (!P || !Array.isArray(P.teams) || !P.teams.length) fails.push('no "teams that cleared" list');
    else {
      for (const [i, pt] of P.teams.entries()) {
        if (!pt.leader || pt.subs.length !== 5 || !pt.friend) fails.push(`cleared team ${i + 1} isn't leader + 5 subs + friend`);
        if (i && pt.usesPicks > P.teams[i - 1].usesPicks) fails.push(`cleared team ${i + 1} uses more of your picks than the one above it`);
      }
    }
  }
  if (mode.event === 'meteor' && (r.proven || r.hasClears)) fails.push('Meteor Survival has no clear data, but the result claims some');
  // Rule: teams are ordered by how many of your picks the leaders boost (a kept leader may stay first, with a warning).
  const cov = t => t.members.filter(m => m.pick && m.covered).length;
  const ordered = sc.locked ? r.teams.slice(1) : r.teams;
  for (let i = 1; i < ordered.length; i++)
    if (cov(ordered[i]) > cov(ordered[i - 1])) fails.push(`teams out of order: a team boosting ${cov(ordered[i])} picks is below one boosting ${cov(ordered[i - 1])}`);
  // Rule: if any built team boosts every pick, the first unlocked team must too.
  const best = Math.max(...r.teams.map(cov));
  if (ordered[0] && cov(ordered[0]) < best) fails.push(`first team boosts ${cov(ordered[0])}/${pickIds.size} picks, another boosts ${best}`);
  if (sc.locked && cov(r.teams[0]) < pickIds.size && !(r.teams[0].uncoveredPicks || []).length)
    fails.push('the kept leader misses a pick and team 1 has no warning');
  return fails;
}

// Small, exact checks of the text parsers and rules (no network).
function unitTests() {
  const t = team._t;
  const fails = [];
  const eq = (label, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
  eq('slot: 2nd or 3rd attacker, unit 1st', t.slotCondMet('As the 2nd or 3rd attacker in a turn', 'first'), false);
  eq('slot: 2nd or 3rd attacker, unit 2nd', t.slotCondMet('As the 2nd or 3rd attacker in a turn', 'second'), true);
  eq('slot: 1st attacker, floater', t.slotCondMet('As the 1st attacker in a turn', 'floater'), false);
  eq('slot: not a slot condition', t.slotCondMet('When attacking', 'first'), false);
  const sv = (normal) => ({ phases: 50, stackedLasts: { normal } });
  eq('0-damage reach: never hit', t.zeroReach(sv({ all: true })), 51);
  eq('0-damage reach: hit from the start', t.zeroReach(sv({ never: true })), 0);
  eq('0-damage reach: safe to phase 41', t.zeroReach(sv({ phase: 41 })), 41);
  eq('0-damage reach: safe from phase 3 to 45', t.zeroReach(sv({ from: 3, phase: 45 })), 44);
  eq('0-damage reach: no data', t.zeroReach(null), 0);
  eq('form card id', t.isFormCard({ id: '4030491' }), true);
  eq('real card id', t.isFormCard({ id: '1030481' }), false);
  // leader skill HP (team HP in the simulation)
  const src = require('../lib/source');
  const L1 = src._parseLeader('"Successors", "Fused Fighters" or "Pure Saiyans" Category Ki +3, HP +200% and ATK & DEF +170%, plus an additional HP, ATK & DEF +50% for characters who also belong to the "Gifted Warriors" or "Fusion" Category');
  eq('leader HP: "HP +200% and ATK & DEF +170%"', [L1.parts[0].hp, L1.parts[0].atk, L1.parts[0].add.hp], [200, 170, true]);
  const L2 = src._parseLeader('"Super Bosses", "Transformation Boost" or "Full Power" Category Ki +3 and HP, ATK & DEF +170%');
  eq('leader HP: "HP, ATK & DEF +170%"', [L2.parts[0].hp, L2.parts[0].def], [170, 170]);
  // real clears: the bundled Festival snapshot, and how a unit's share is read
  const cl = t.clearsOf('festival');
  eq('festival clear data loaded', cl ? cl.n : 0, 155);
  eq('SSJ4 Goku & Vegeta share of clears', cl ? Math.round(t.proven(cl, { id: '1022421' }) * 155) : 0, 111);
  eq('a unit nobody cleared with', cl ? t.proven(cl, { id: '1000001' }) : -1, 0);
  eq('no clear data for Meteor Survival', t.clearsOf('meteor'), null);
  eq('no clear data without an event', t.clearsOf(null), null);
  // the strict order: covering a pick beats any amount of quality
  const mkTeam = (cov, lcov, score, id, unfit = 0) => ({ coveredPicks: cov, leaderCoveredPicks: lcov, score, unfit, lead: { L: { id }, F: { id } } });
  eq('order: more picks boosted wins over a huge score', [mkTeam(2, 2, 99999, 'a'), mkTeam(3, 3, 1, 'b')].sort(t.compareTeams)[0].lead.L.id, 'b');
  eq('order: own leader boosting a pick beats friend-only', [mkTeam(3, 2, 99999, 'a'), mkTeam(3, 3, 1, 'b')].sort(t.compareTeams)[0].lead.L.id, 'b');
  eq('order: ties broken by leader id', [mkTeam(3, 3, 5, 'z'), mkTeam(3, 3, 5, 'a')].sort(t.compareTeams)[0].lead.L.id, 'a');
  eq('order: no added unit that won\'t last beats a huge score', [mkTeam(3, 3, 99999, 'a', 2), mkTeam(3, 3, 1, 'b', 0)].sort(t.compareTeams)[0].lead.L.id, 'b');
  eq('order: ... and beats your own leader boosting a pick', [mkTeam(3, 3, 1, 'a', 1), mkTeam(3, 2, 1, 'b', 0)].sort(t.compareTeams)[0].lead.L.id, 'b');
  eq('order: boosting every pick still comes first', [mkTeam(2, 2, 1, 'a', 0), mkTeam(3, 3, 1, 'b', 2)].sort(t.compareTeams)[0].lead.L.id, 'b');
  // the event rule: it lasts if it stacks or players cleared the event with it (Gomah: no stack, 3 posted clears)
  const u = (id, score) => ({ id, stacking: { score } });
  eq('lasts: stacks, never cleared with', t.fitsEvent(cl, u('1000001', 2)), true);
  eq('lasts: no stack, in 3 posted clears', t.fitsEvent(cl, u('1032311', 0)), true);
  eq('lasts: no stack, no clear', t.fitsEvent(cl, u('1000001', 0)), false);
  eq('lasts: no stack, no clear data (Meteor)', t.fitsEvent(null, u('1032311', 0)), false);
  eq('clears counted over both forms', t.clearCount(cl, { id: '1000001', xform: { id: '1032311' } }), 3);
  return fails;
}

(async () => {
  const quick = process.argv.includes('--quick');
  const scenarios = quick ? SCENARIOS.slice(0, 4) : SCENARIOS;
  const modes = quick ? MODES.filter(m => m.key === 'festival') : MODES;
  let total = 0, failed = 0;
  const uf = unitTests();
  console.log(`unit tests: ${uf.length ? 'FAIL' : 'pass'}`); for (const f of uf) console.log('   - ' + f);
  if (uf.length) failed++;
  for (const sc of scenarios) {
    for (const mode of modes) {
      total++;
      const t0 = Date.now();
      let r, fails;
      try {
        r = await team.build(sc.picks, BOX, mode.festival, { event: mode.event, ...(sc.opts || {}) });
        fails = check(r, sc, mode);
      } catch (e) { fails = [`build threw: ${e.message}`]; }
      if (fails.length) failed++;
      const head = r?.teams?.[0];
      const line = head ? `${head.members[0].name.slice(0, 28)} / friend ${head.friend.name.slice(0, 24)}` : '';
      console.log(`${fails.length ? 'FAIL' : 'pass'} | ${mode.key.padEnd(8)} | ${sc.name.slice(0, 48).padEnd(48)} | ${String(Date.now() - t0).padStart(6)} ms | ${line}`);
      for (const f of fails) console.log('   - ' + f);
    }
  }
  // Review findings: things the page and the server must get right around exchange forms, loading and warnings.
  const extra = async (label, fn) => {
    total++;
    let fails;
    try { fails = await fn(); } catch (e) { fails = [`threw: ${e.message}`]; }
    if (fails.length) failed++;
    console.log(`${fails.length ? 'FAIL' : 'pass'} | ${label}`);
    for (const f of fails) console.log('   - ' + f);
  };
  await extra('a pick that can\'t be loaded is a visible warning, not a silent drop', async () => {
    const r = await team.build(['1031921', '1000001'], BOX, false, {});
    return r.warnings.some(w => /couldn't be loaded/.test(w) && w.includes('1000001')) ? [] : [`warnings: ${JSON.stringify(r.warnings)}`];
  });
  await extra('a kept leader sent as its exchanged form id (4030491) is kept as the card itself (1030481)', async () => {
    const r = await team.build(['1033061'], BOX, true, { event: 'festival', leader: '4030491' });
    const t = r.teams[0];
    return t.kept && baseId(t.members[0]) === '1030481' ? [] : [`team 1 kept=${t.kept}, leader ${baseId(t.members[0])}`];
  });
  await extra('"I don\'t have it" on an exchanged form id (4030491) keeps the card itself (1030481) out', async () => {
    const r = await team.build(['1032311', '1031921', '1021671'], BOX, true, { event: 'festival', exclude: ['4030491'] });
    const bad = r.teams.filter(t => t.members.some(m => baseId(m) === '1030481'));
    return bad.length ? [`${bad.length} team(s) still use 1030481`] : [];
  });
  await extra('coverage notes never say "no leader boosts all" when another team does', async () => {
    const fails = [];
    for (const [picks, opts] of [[['1032311', '1018491', '1030481'], {}], [['1031921', '1032311', '1021671'], { leader: '1030391' }]]) {
      const r = await team.build(picks, BOX, false, opts);
      const all = r.teams.some(t => !(t.uncoveredPicks || []).length);
      for (const [i, t] of r.teams.entries()) if (all && /^No leader found/.test(t.coverNote || '')) fails.push(`picks ${picks}: team ${i + 1} says "${t.coverNote}"`);
    }
    return fails;
  });
  await extra('Replace picker, leader slot: no current team member, no "I don\'t have it" unit', async () => {
    const out = await team.swapPreview('1030481', ['1031921', '1032311', '1021671'], '1030481', ['1030481', '1031921', '1028021', '1016871'],
      BOX, true, null, { picks: ['1031921', '1032311', '1021671'], exclude: ['1016871'] });
    const ids = out.map(x => x.id);
    const fails = [];
    if (ids.includes('1031921')) fails.push('offers Broly (Wrathful), already in the team, as leader');
    if (ids.includes('1016871')) fails.push('offers a unit marked "I don\'t have it"');
    if (!ids.includes('1030481')) fails.push('the current leader is missing from the list');
    return fails;
  });
  await extra('Replace picker in an event: a unit that won\'t last is never "best" and comes after the ones that do', async () => {
    const picks = ['1032311', '1031921', '1034151'];
    const out = await team.swapPreview('1027221', picks, '1027221', ['1027221', '1032261', '1028021', '1028011', '1021291'],
      BOX, true, null, { picks, event: 'festival' });
    const fails = [];
    const daima = out.find(x => x.id === '1032261');
    if (!daima) fails.push('the DAIMA SSJ4 Goku (Mini) is missing from the list');
    else if (daima.fits !== false) fails.push('the DAIMA SSJ4 Goku (Mini) is marked as lasting');
    if (out.some(x => x.best && !x.fits)) fails.push('a unit that won\'t last is marked best');
    for (let i = 1; i < out.length; i++)
      if (out[i].uncoveredPicks.length === out[i - 1].uncoveredPicks.length && out[i].fits && !out[i - 1].fits)
        fails.push(`${out[i].name} lasts but is listed below ${out[i - 1].name}, which doesn't`);
    return fails;
  });
  await extra('the DAIMA SSJ4 Goku (Mini) doesn\'t last Festival (no stack, no posted clear); Gomah does (3 clears)', async () => {
    const src = require('../lib/source'), t = team._t, cl = t.clearsOf('festival');
    const fails = [];
    if (t.fitsEvent(cl, await src.unit('1032261'))) fails.push('the DAIMA SSJ4 Goku (Mini) counts as lasting');
    if (!t.fitsEvent(cl, await src.unit('1032311'))) fails.push('Gomah doesn\'t count as lasting');
    return fails;
  });
  // The ground the event rule stands on: "it stacks" has to describe the units players really clear with.
  await extra('the event rule matches real clears: at least 85% of the unit slots in the 155 posted Festival clears stack', async () => {
    const src = require('../lib/source'), d = require('../data/festival-of-battles-clears.json');
    const memo = new Map();
    const stacks = id => {
      if (!memo.has(id)) memo.set(id, (async () => {
        try {
          const u = await src.unit(id);
          let x = null;
          if (u.exchangeWith) { try { x = await src.exchangeForm(u); } catch {} }
          return [u, x].filter(Boolean).some(f => (f.stacking?.score || 0) > 0);
        } catch { return null; }
      })());
      return memo.get(id);
    };
    let n = 0, yes = 0;
    for (const tm of d.teams) for (const id of [tm.leader, ...tm.subs, tm.friend]) {
      const s = await stacks(id);
      if (s === null) continue;
      n++; if (s) yes++;
    }
    return n > 1000 && yes / n >= 0.85 ? [] : [`${yes}/${n} unit slots stack (${(100 * yes / n).toFixed(1)}%)`];
  });

  await extra('"Use this team" rebuilds a posted clear exactly (leader, friend, all 6), without calling them your picks', async () => {
    // the standard Festival team, loaded while your own picks were Broly (Wrathful), Gomah and LSSJ Broly
    const six = ['1030481', '1030431', '1022421', '1022381', '1030341', '1022631'];
    const r = await team.build(six, BOX, true, { event: 'festival', leader: '1030481', friend: '1030431', mine: ['1031921', '1032311', '1021671'] });
    const t = r.teams[0], fails = [];
    if (!t.kept) fails.push('the leader was not kept');
    if (baseId(t.members[0]) !== '1030481') fails.push(`leader is ${baseId(t.members[0])}`);
    if (baseId(t.friend) !== '1030431') fails.push(`friend is ${baseId(t.friend)}`);
    if (t.members.map(baseId).sort().join(',') !== [...six].sort().join(',')) fails.push(`units differ: ${t.members.map(baseId).join(',')}`);
    if (t.members.some(m => m.mine)) fails.push('a loaded unit is marked as one of your picks');
    if (!t.proven?.exact) fails.push('not recognized as a posted clear');
    return fails;
  });

  // Same input twice must give the same teams.
  const a = await team.build(SCENARIOS[0].picks, BOX, true, { event: 'festival' });
  const b = await team.build(SCENARIOS[0].picks, BOX, true, { event: 'festival' });
  const sig = r => r.teams.map(t => [t.friend.id, ...t.members.map(baseId)].join(',')).join(' | ');
  const det = sig(a) === sig(b);
  console.log(`${det ? 'pass' : 'FAIL'} | determinism: same picks twice give the same teams`);
  if (!det) failed++;
  console.log(`\n${total + 2 - failed}/${total + 2} checks passed`);
  process.exit(failed ? 1 : 0);
})();
