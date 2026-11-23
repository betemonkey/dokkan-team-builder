// Scenario tests for the team builder. Builds real teams (from the cached site data, fetching what's missing)
// and checks the rules a Dokkan player never breaks, on every team of every scenario, in every event mode.
// Run:  node test/run.js            all scenarios, all modes
//       node test/run.js --quick    first 4 scenarios, Festival mode only
// Exit code 1 when any rule fails, so it can gate a release.
const team = require('../lib/team');

const BOX = ['1032311', '1031921', '1021671'];   // a small registered box (three picks)
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
  eq('slot: "is the 2nd attacker at the start of turn", unit 2nd', t.slotCondMet('When the character is the 2nd attacker at the start of turn', 'second'), true);
  eq('slot: "is the 2nd attacker at the start of turn", unit 1st', t.slotCondMet('When the character is the 2nd attacker at the start of turn', 'first'), false);
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
  // Guard and damage reduction in the 0-damage bar. Formula from the DokkanStats guide, and the same in a second,
  // independent damage-taken calculator: hit = enemy ATK x type (1.00 neutral, by type and class; 0.80 for EVERY hit
  // when the unit guards) x (1 - damage reduction) x variance 1.03. 0 damage when DEF >= hit. These test enemies have
  // no type, so they count neutral.
  const evN = n => ({ phases: n, enemies: Array.from({ length: n }, (_, i) => ({ name: 'E' + (i + 1), phase: i + 1, atk: 1000000, superDamage: 3000000 })) });
  const pu = (secs, extra = {}) => ({ id: '1000001', name: 'Test', cls: 'Super', type: 'AGL', categories: ['Fusion'], stacking: {}, ...extra,
    passive: secs.map(([cond, ...fx]) => ({ cond, fx: fx.map(text => ({ text })) })) });
  const bars = (secs, { role = 'first', pos = 'r1a', attacks = true, n = 2, conds = [], key = 'atk', extra } = {}) =>
    t.hitBars(t.defenseKit(pu(secs, extra), conds, role), evN(n), pos, attacks, false)[key].map(Math.round);
  eq('bar: no guard, no reduction', bars([['Basic effect(s)', 'ATK & DEF 100% ▲']]), [1030000, 1030000]);
  eq('bar: guard = every hit x0.80', bars([['Basic effect(s)', 'Guards all attacks']]), [824000, 824000]);
  eq('bar: 40% damage reduction', bars([['Basic effect(s)', 'Damage reduction rate 40% ▲']]), [618000, 618000]);
  eq('bar: guard and 40% damage reduction', bars([['Basic effect(s)', 'Guards all attacks', 'Damage reduction rate 40% ▲']]), [494400, 494400]);
  eq('bar: "crit & damage reduction 30%" wording', bars([['Basic effect(s)', 'Chance of performing a critical hit & damage reduction rate 30% ▲']]), [721000, 721000]);
  eq('bar: "damage reduction rate & crit 30%" wording', bars([['Basic effect(s)', 'Damage reduction rate & chance of performing a critical hit 30% ▲']]), [721000, 721000]);
  eq('bar: lowering the enemies\' damage reduction isn\'t its own', bars([['Basic effect(s)', 'Damage reduction rate 30% ▲'], ['When attacking', "All enemies' damage reduction rate 20% ▼"]]), [721000, 721000]);
  eq('bar: a falling reduction alone adds nothing', bars([['Basic effect(s)', 'Damage reduction rate 10% ▼ for every turn passed (no more than -60%)']]), [1030000, 1030000]);
  eq('bar: a chance to guard is not a guard', bars([['Basic effect(s)', 'High chance of guarding all attacks']]), [1030000, 1030000]);
  eq('bar: "disables the enemy\'s guard" is not its own guard', bars([['When attacking', "Disables the enemy's guard"]]), [1030000, 1030000]);
  eq('bar: guard only as 2nd or 3rd attacker, unit attacks 1st', bars([['As the 2nd or 3rd attacker in a turn', 'Guards all attacks']]), [1030000, 1030000]);
  eq('bar: guard only as 2nd or 3rd attacker, unit attacks 2nd', bars([['As the 2nd or 3rd attacker in a turn', 'Guards all attacks']], { role: 'second', pos: 'r1b' }), [824000, 824000]);
  eq('bar: guard "as the 1st attacker" inside the line, unit 2nd', bars([['Basic effect(s)', 'DEF 50% ▲ and guards all attacks as the 1st attacker in a turn']], { role: 'second', pos: 'r1b' }), [1030000, 1030000]);
  eq('bar: guard for the first 3 turns only', bars([["For 3 turns from the character's entry turn", 'Guards all attacks']], { n: 5 }), [1030000, 1030000, 1030000, 1030000, 1030000]);
  eq('bar: guard for 4 turns on entry', bars([["Activates the Entrance Animation upon the character's entry", 'Ki +3 and guards all attacks for 4 turns']]), [1030000, 1030000]);
  eq('bar: guard from the entrance animation, no end', bars([["Activates the Entrance Animation upon the character's entry", 'Guards all attacks']]), [824000, 824000]);
  // Type and class (asked 2026-11-23): the enemy's type and class against the unit's (here Super AGL). Same table in
  // the damage-taken calculator and in dokkanessentials.com's damage-received guide.
  const evT = (type, cls, more = {}) => ({ phases: 1, enemies: [{ name: 'E1', phase: 1, atk: 1000000, superDamage: 3000000, type, cls, ...more }] });
  const tbar = (type, cls, { secs = [['Basic effect(s)', 'ATK & DEF 100% ▲']], key = 'atk', more } = {}) =>
    Math.round(t.hitBars(t.defenseKit(pu(secs), [], 'first'), evT(type, cls, more), 'r1a', true, false, { type: 'AGL', cls: 'Super' })[key][0]);
  eq('type: neutral, same class x1.00', tbar('INT', 'Super'), 1030000);
  eq('type: neutral, Super vs Extreme x1.15', tbar('INT', 'Extreme'), 1184500);
  eq("type: the enemy's type beats the unit's (TEQ > AGL), same class x1.25", tbar('TEQ', 'Super'), 1287500);
  eq("type: the enemy's type beats the unit's, Super vs Extreme x1.50", tbar('TEQ', 'Extreme'), 1545000);
  eq("type: the unit's type beats the enemy's (AGL > STR), same class x0.90", tbar('STR', 'Super'), 927000);
  eq("type: the unit's type beats the enemy's, Super vs Extreme x1.00", tbar('STR', 'Extreme'), 1030000);
  eq('type: a guard is x0.80 whatever the match-up', tbar('TEQ', 'Extreme', { secs: [['Basic effect(s)', 'Guards all attacks']] }), 824000);
  eq('type: an enemy without a type counts neutral', tbar(undefined, undefined), 1030000);
  eq('type: Super Attacks too', tbar('INT', 'Extreme', { key: 'superDamage' }), 3553500);
  eq('type: a unit without a type counts neutral', t.typeMult({ type: 'TEQ', cls: 'Extreme' }, {}), 1);
  eq('a boss whose Super raises its ATK 50% hits x1.5 with its normal attacks after it', tbar('INT', 'Super', { more: { saAtkBoostPct: 50 } }), 1545000);
  // Mix & match by category (asked 2026-11-23): AND = in every chosen category, OR = in at least one; an exchanged
  // form (4xxxxxx) isn't a card of its own.
  const cm = (lists, mode) => t.categoryMatch(lists.map(l => l.map(id => ({ id }))), mode).sort();
  eq('category match AND: only the cards in every list', cm([['1000001', '1000002', '1000003'], ['1000002', '1000003'], ['1000003', '1000004']], 'and'), ['1000003']);
  eq('category match OR: the cards in at least one list, once each', cm([['1000001', '1000002'], ['1000002', '1000003']], 'or'), ['1000001', '1000002', '1000003']);
  eq('category match: an exchanged form is left out', cm([['1000001', '4000001']], 'or'), ['1000001']);
  eq('category match: one category is the same in AND and OR', cm([['1000002', '1000001']], 'and'), cm([['1000002', '1000001']], 'or'));
  eq('bar: guard from the 3rd turn on', bars([["Starting from the 3rd turn from the character's entry turn", 'Guards all attacks']], { n: 4 }), [1030000, 1030000, 824000, 824000]);
  eq('bar: guard from the 3rd turn, 2nd rotation (comes out on turn 2)', bars([["Starting from the 3rd turn from the character's entry turn", 'Guards all attacks']], { n: 5, pos: 'r2a' }), [1030000, 1030000, 1030000, 824000, 824000]);
  eq('bar: damage reduction from turn 2 of the battle', bars([['Starting from the 2nd turn from the start of battle', 'Damage reduction rate 50% ▲']]), [1030000, 515000]);
  eq('bar: reduction when receiving a Super Attack: normal attacks unchanged', bars([['When receiving a Super Attack', 'Damage reduction rate 50% ▲ temporarily']]), [1030000, 1030000]);
  eq('bar: reduction when receiving a Super Attack: Super Attacks halved', bars([['When receiving a Super Attack', 'Damage reduction rate 50% ▲ temporarily']], { key: 'superDamage' }), [1545000, 1545000]);
  eq('bar: reduction "temporarily when receiving a normal attack"', [bars([['Basic effect(s)', 'Damage reduction rate 60% ▲ temporarily when receiving a normal attack']])[0], bars([['Basic effect(s)', 'Damage reduction rate 60% ▲ temporarily when receiving a normal attack']], { key: 'superDamage' })[0]], [412000, 3090000]);
  // stacks: per Super Attack (1st attacker in rotation 1: out on turns 1, 3, 5, 7 -> 0, 1, 1, 2, 2, 3, 3, 4 Supers before)
  eq('bar: reduction +10% per Super Attack (up to 30%)', bars([['For every Super Attack performed', 'Damage reduction rate 10% ▲ (up to 30%)']], { n: 8 }), [1030000, 927000, 927000, 824000, 824000, 721000, 721000, 721000]);
  eq('bar: ... no Super Attack, no stack', bars([['For every Super Attack performed', 'Damage reduction rate 10% ▲ (up to 30%)']], { n: 3, attacks: false }), [1030000, 1030000, 1030000]);
  eq('bar: reduction that only lasts within the turn is not counted', bars([['For every attack received', 'Damage reduction rate 10% ▲ within the turn (up to 50%)']], { n: 3 }), [1030000, 1030000, 1030000]);
  eq('bar: 90% reduction falling 10% a turn, down to 30%', bars([["Activates the Entrance Animation upon the character's entry", 'Damage reduction rate 90% ▲', 'Damage reduction rate 10% ▼ for every turn passed (no more than -60%)']], { n: 9 }),
    [103000, 206000, 309000, 412000, 515000, 618000, 721000, 721000, 721000]);
  // (counted as of its next turn out: 1, 2, 2, 3, 3, 4 starts of turn)
  eq('bar: 30% reduction falling 10% per turn passed (section wording), down to 0', bars([['Basic effect(s)', 'Damage reduction rate 30% ▲'], ['For every turn passed', 'Damage reduction rate 10% ▼ (no more than -30%)']], { n: 5 }),
    [721000, 824000, 927000, 1030000, 1030000]);
  eq('bar: a fall "after receiving 7 or more attacks" counts from the start', bars([['Basic effect(s)', 'Damage reduction rate 50% ▲'], ['After receiving 7 or more attacks in battle', 'Damage reduction rate 20% ▼']]), [721000, 721000]);
  eq('bar: a falling reduction of unknown pace counts at its worst', bars([['Basic effect(s)', 'Damage reduction rate 30% ▲'], ['For every attack received', 'Damage reduction rate 10% ▼ (no more than -20%)']]), [927000, 927000]);
  eq('bar: reduction +10% at the start of each turn (up to 30%)', bars([['At the start of each turn', 'Damage reduction rate 10% ▲ (up to 30%)']], { n: 6 }), [927000, 824000, 824000, 721000, 721000, 721000]);
  eq('bar: reduction per Category ally (2 allies, up to 30%)', bars([['Per "Fusion" Category ally on the team', 'Damage reduction rate 10% ▲ (up to 30%)']],
    { conds: [{ cond: 'Per "Fusion" Category ally on the team', met: true, have: 2, per: true, need: 'per Fusion ally' }] }), [824000, 824000]);
  eq('bar: reduction before attacking is not counted (hits after its attack get none)', bars([['Basic effect(s)', 'Damage reduction rate 40% ▲ before attacking']]), [1030000, 1030000]);
  eq('bar: reduction that needs Ki Spheres is not counted', bars([['3 or more Ki Spheres obtained', 'Damage reduction rate 40% ▲']]), [1030000, 1030000]);
  eq('bar: reduction that needs HP is not counted', bars([['When HP is 50% or more', 'Damage reduction rate 40% ▲']]), [1030000, 1030000]);
  eq('bar: team condition met', bars([['When there is another "Fusion" Category ally attacking in the same turn', 'Damage reduction rate 40% ▲']],
    { conds: [{ cond: 'When there is another "Fusion" Category ally attacking in the same turn', met: true, need: 'Fusion ally', scope: 'turn' }] }), [618000, 618000]);
  eq('bar: team condition not met', bars([['When there is another "Fusion" Category ally attacking in the same turn', 'Damage reduction rate 40% ▲']],
    { conds: [{ cond: 'When there is another "Fusion" Category ally attacking in the same turn', met: false, need: 'Fusion ally', scope: 'turn' }] }), [1030000, 1030000]);
  // what the kit says it counted and left out (the page shows both)
  const kitOf = (secs, role = 'first', extra) => t.defenseKit(pu(secs, extra), [], role);
  const nc = kitOf([['As the 2nd or 3rd attacker in a turn', 'Guards all attacks'], ['Basic effect(s)', 'High chance of guarding all attacks']]).notCounted;
  eq('not counted: slot guard says why', nc.some(x => /guards all attacks/i.test(x.text) && /2nd or 3rd attacker/.test(x.why) && /1st/.test(x.why)), true);
  eq('not counted: chance to guard says why', nc.some(x => /chance of guarding/i.test(x.text) && /chance/i.test(x.why)), true);
  eq('not counted: "before receiving 3 attacks in battle"', kitOf([['Before receiving 3 attacks in battle', 'Damage reduction rate 66% ▲']]).notCounted.map(x => x.why), ['only for the first 3 hits of the battle']);
  eq('kit: guard in this slot', kitOf([['As the 2nd or 3rd attacker in a turn', 'Guards all attacks']], 'floater').guard, true);
  // a unit's support line counts for itself only when it belongs to who it supports
  eq('support: own "Fusion" allies\' DEF counts for a Fusion unit', kitOf([['Basic effect(s)', '"Successors" or "Fusion" Category allies\' Ki +1 and DEF 40% ▲']]).start, 40);
  eq('support: ... not for a unit outside those categories', kitOf([['Basic effect(s)', '"Successors" or "Fusion" Category allies\' Ki +1 and DEF 40% ▲']], 'first', { categories: ['Potara'] }).start, 0);
  eq('support: own DEF before an allies\' part still counts', kitOf([['Basic effect(s)', 'ATK & DEF 400% ▲ and "DAIMA" Category allies\' Ki +1, DEF 23% ▲']], 'first', { categories: ['Potara'] }).start, 400);
  eq('support: Extreme Class allies\' DEF, Super unit', kitOf([['Basic effect(s)', 'Extreme Class allies\' DEF 40% ▲']]).start, 0);
  eq('support: "Extreme Type allies\'" (older wording), Extreme unit', kitOf([['Basic effect(s)', 'Extreme Type allies\' ATK & DEF 50% ▲']], 'first', { cls: 'Extreme' }).start, 50);
  eq('support: (self excluded)', kitOf([['Basic effect(s)', '"Fusion" Category allies\' (self excluded) DEF 40% ▲']]).start, 0);
  // DEF that only holds within the turn, or only when it attacks, doesn't keep every hit at 0
  eq('DEF: stack within the turn is not counted', kitOf([['For every attack received', 'DEF 10% ▲ within the turn (up to 50%)']]).stackCap, 0);
  eq('DEF: "when attacking with 12 or more Ki" is not counted', kitOf([['Basic effect(s)', 'ATK & DEF 100% ▲ when attacking with 12 or more Ki']]).start, 0);
  eq('DEF: start of each turn +30% (up to 60%) stacks', kitOf([['At the start of each turn', 'ATK & DEF 30% ▲ (up to 60%)']]).stackCap, 60);
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
  // Asked 2026-11-22: count the unit's guard and damage reduction. The Angel duo (1030481) guards "as the 2nd or 3rd
  // attacker in a turn": as the friend (3rd slot) every hit counts x0.80, as the leader (attacks 1st) it doesn't.
  await extra('guard in the real Festival table: as a floater the Angel duo takes every hit at x0.80, as the 1st attacker at its type match-up', async () => {
    const src = require('../lib/source'), t = team._t, ev = t.eventOf('festival');
    const u = await src.unit('1030481'), lead = { L: u, F: u }, st = { conds: [], def: 0 };
    const asFirst = await t.survival(lead, u, st, 'festival', 'r1a'), asFloater = await t.survival(lead, u, st, 'festival', 'f3');
    const fails = [];
    if (!asFirst || !asFloater) return ['no survival data'];
    if (asFirst.kit.guard) fails.push('guards as the 1st attacker');
    if (!asFloater.kit.guard) fails.push('doesn\'t guard as the 3rd attacker');
    if (!asFirst.kit.notCounted.some(x => /guards all attacks/i.test(x.text) && /2nd or 3rd/.test(x.why))) fails.push('the leader\'s kit doesn\'t say why its guard is left out');
    for (const [j, e] of asFloater.lastEnemies.entries()) {
      const foe = ev.enemies.find(x => x.name === e.enemy && x.phase === e.phase);
      const r = e.normal / asFirst.lastEnemies[j].normal, want = 0.8 / t.typeMult(foe, u);
      if (Math.abs(r - want) > 0.001) fails.push(`${e.enemy}: needed DEF ratio ${r.toFixed(3)}, want ${want.toFixed(3)}`);
      if (!e.guard || asFirst.lastEnemies[j].guard) fails.push(`${e.enemy}: guard flag wrong in the table`);
    }
    return fails;
  });
  // Gomah's 33% sits on a line that also says "chance of evading enemy's attack" (the old parser skipped any line
  // with "enem" in it); Kid Buu's 50% comes from his entrance animation, with no end.
  // Asked 2026-11-23 ("does the info take into account the damage reduction?"): yes, for the Super's bar too.
  await extra('damage reduction in the real Festival table: Gomah 33%, Kid Buu 50%, LSSJ Broly 18%, and the bar is the hit x type x (1 - reduction) x 1.03, for normal attacks and the Super', async () => {
    const src = require('../lib/source'), t = team._t, ev = t.eventOf('festival');
    const fails = [];
    for (const [id, want] of [['1032311', 33], ['1034151', 50], ['1021671', 18]]) {
      const u = await src.unit(id), k = t.defenseKit(u, [], 'first');
      if (k.dr !== want) { fails.push(`${u.name}: damage reduction ${k.dr}%, want ${want}%`); continue; }
      const sv = await t.survival({ L: u, F: u }, u, { conds: [], def: 0 }, 'festival', 'r1a');
      const last = ev.enemies[ev.enemies.length - 1], e = sv.lastEnemies[sv.lastEnemies.length - 1];
      const bar = Math.ceil(last.atk * (1 + (last.saAtkBoostPct || 0) / 100) * (k.guard ? 0.8 : t.typeMult(last, u)) * (1 - want / 100) * 1.03);
      if (Math.abs(e.normal - bar) > 1) fails.push(`${u.name}: needs ${e.normal} vs ${last.name}, want ${bar}`);
      const superBar = Math.ceil(last.superDamage * (last.crit ? 1.5 : 1) * (k.guard ? 0.8 : t.typeMult(last, u))
        * (1 - Math.min(90, want + k.drHit.superDamage) / 100) * 1.03);
      if (Math.abs(e.super - superBar) > 1) fails.push(`${u.name}: needs ${e.super} vs ${last.name}'s Super, want ${superBar}`);
    }
    return fails;
  });
  // Asked 2026-11-23: each enemy's type, class and phase, from the game data on DOKKAN.FYI's stage page. In the game,
  // Phase 45/50 is Majin Buu (Good), Extreme INT; the Angel duo (Super AGL) takes his Kamehameha x1.15.
  await extra('type and class in the real Festival table: 57 enemies over 50 phases, Buu Extreme INT at phase 45, Super Gogeta at 49, the Angel duo takes Buu x1.15', async () => {
    const src = require('../lib/source'), t = team._t, ev = t.eventOf('festival');
    const fails = [];
    if (ev.enemies.length !== 57) fails.push(`${ev.enemies.length} enemies, want 57`);
    if (new Set(ev.enemies.map(e => e.phase)).size !== 50) fails.push('not 50 phases');
    if (!ev.enemies.every(e => e.type && e.cls)) fails.push('an enemy without a type or class');
    const buu = ev.enemies.find(e => e.name === 'Majin Buu (Good)');
    if (buu?.phase !== 45 || buu.cls !== 'Extreme' || buu.type !== 'INT') fails.push(`Buu: phase ${buu?.phase}, ${buu?.cls} ${buu?.type}`);
    const gog = ev.enemies.find(e => e.name === 'Super Gogeta' && e.phase === 49);
    if (!gog || gog.superDamage !== 28000000 || gog.saAtkBoostPct !== 50) fails.push('Super Gogeta (phase 49) missing or wrong');
    const u = await src.unit('4030491');
    if (u.cls !== 'Super' || u.type !== 'AGL') fails.push(`the Angel duo is ${u.cls} ${u.type}, want Super AGL`);
    const sv = await t.survival({ L: u, F: u }, u, { conds: [], def: 0 }, 'festival', 'f3');
    const row = sv?.lastEnemies.find(e => e.enemy === 'Majin Buu (Good)'), want = Math.ceil(5600000 * 1.15 * 1.03);
    if (!row || row.super !== want || row.vs !== 'Extreme INT') fails.push(`the Angel duo vs Buu's Super: ${row?.super} (${row?.vs}), want ${want} (Extreme INT)`);
    if (!sv?.typed || sv.me !== 'Super AGL') fails.push('the survival result doesn\'t say it counts the match-up');
    return fails;
  });
  // Asked 2026-11-23: mix & match by category (approved mockup: mockups/category-picker.html), on the real category
  // pages. The box is Gomah, Broly (Wrathful), LSSJ Broly and SSJ3 Goku.
  await extra('category board on real data: AND units are in every category, OR in at least one, leaders name a chosen category, boosts are the leader skill\'s', async () => {
    const src = require('../lib/source');
    const box = ['1032311', '1031921', '1021671', '1034201'], fails = [];
    const ps = await src.categoryMembers('Pure Saiyans'), mb = await src.categoryMembers('Movie Bosses');
    const inPs = new Set(ps.map(m => m.id)), inMb = new Set(mb.map(m => m.id)), card = id => !/^4\d{6}$/.test(id);
    const and = await team.categoryBoard(['Pure Saiyans', 'Movie Bosses'], 'and', box);
    const or = await team.categoryBoard(['Pure Saiyans', 'Movie Bosses'], 'or', box);
    const wantAnd = ps.filter(m => inMb.has(m.id) && card(m.id)).length, wantOr = [...new Set([...inPs, ...inMb])].filter(card).length;
    if (and.match !== wantAnd) fails.push(`AND: ${and.match} match, want ${wantAnd}`);
    if (or.match !== wantOr) fails.push(`OR: ${or.match} match, want ${wantOr}`);
    if (and.yours !== 2) fails.push(`AND: ${and.yours} of yours, want 2 (Broly (Wrathful) and LSSJ Broly)`);
    if (or.yours !== 3) fails.push(`OR: ${or.yours} of yours, want 3 (+ SSJ3 Goku)`);
    if (!and.leaders.length || !or.leaders.length) return [...fails, 'no leader found'];
    for (const l of [...and.leaders, ...or.leaders])
      if (!l.skill.cats.some(c => ['pure saiyans', 'movie bosses'].includes(src.normCat(c)))) fails.push(`${l.lead.name}: its skill doesn't name a chosen category`);
    for (const l of and.leaders) for (const c of l.cands) if (!inPs.has(c.id) || !inMb.has(c.id)) fails.push(`AND: ${c.name} (${c.id}) isn't in both`);
    for (const l of or.leaders) for (const c of l.cands) if (!inPs.has(c.id) && !inMb.has(c.id)) fails.push(`OR: ${c.name} (${c.id}) is in neither`);
    const top = and.leaders[0], L = await src.unit(top.lead.id);
    for (const c of top.cands.slice(0, 6)) { const want = team.boostFor(L, await src.unit(c.id)); if (c.boost !== want) fails.push(`${c.name}: boost ${c.boost}, want ${want}`); }
    const firstOther = top.cands.findIndex(c => !c.owned);
    if (firstOther > -1 && top.cands.slice(firstOther).some(c => c.owned)) fails.push('your units aren\'t listed first');
    const idx = await team.categoryIndex(box);
    if (idx.cats.length < 90) fails.push(`only ${idx.cats.length} categories in the popup's list`);
    const psRow = idx.cats.find(c => c.name === 'Pure Saiyans');
    if (psRow?.yours !== 3) fails.push(`Pure Saiyans: ${psRow?.yours} of yours in the popup, want 3`);
    return [...new Set(fails)].slice(0, 8);
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

  // The page's own save code in two app windows against the real server (test/state.js).
  await extra('saved choices with the app open twice: each window saves only what it changed, the older one never puts old choices back',
    require('./state'));

  // Every search box from the first letter, through the real server on real data (test/search.js).
  await extra('search from the first letter: "hi" finds Hit, "4" the Super Saiyan 4s, and 3+ letters keep all the site\'s own results',
    require('./search'));

  // The 🛡 DEF check panel, from the page's own code on a real Festival team (test/defcheck.js).
  await extra('DEF check: every unit shows the DEF it needs against normal attacks and the Super (the model\'s numbers), never how much it\'s short',
    require('./defcheck'));

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
