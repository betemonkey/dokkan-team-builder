// Builds a full team around the units you picked.
// Team = leader + 5 subs + friend. The friend is borrowed, so it can be a different leader than yours:
// every unit gets your leader's boost AND the friend leader's boost. Picks go in first; the rest is filled.
const src = require('./source');

const POOL_CAP = 36;            // max link partners loaded across all picks
const FESTIVAL_POOL_CAP = 100;  // Festival mode looks wider, since only stackers qualify (first build is slower, then cached)
const SUBS = 5;
const MAX_PICKS = 6;
const PAIR_POOL = 12;           // leaders tried as leader x friend pairs
const KI_GOAL = 12;             // Ki needed to launch a Super Attack
const KI_FROM_ORBS = 4;         // rough Ki a unit collects from spheres each turn; below goal - this = "may lack Ki"

// ---------- leader skills ----------
// The ATK boost one unit gets from a leader skill, or -1 when the leader doesn't cover it.
// "or" parts don't add up: the unit gets the best part it qualifies for, plus that part's
// "additional" boost when it also has one of those categories.
function partCovers(p, u) {
  if (p.categories.length) return p.categories.some(c => u.categories.includes(c));
  if (p.scope?.all) return true;
  if (p.scope) return (!p.scope.cls || p.scope.cls === u.cls) && (!p.scope.type || p.scope.type === u.type);
  return false;
}
function boostFor(leader, u) {
  let best = -1;
  for (const p of leader.leader.parts || []) {
    if (!partCovers(p, u)) continue;
    const add = p.add && p.add.categories.some(c => u.categories.includes(c)) ? p.add.pct : 0;
    best = Math.max(best, p.atk + add);
  }
  return best;
}
function kiFor(leader, u) {
  let ki = 0;
  for (const p of leader.leader.parts || []) if (partCovers(p, u)) ki = Math.max(ki, p.ki || 0);
  return ki;
}
const covers = (leader, u) => boostFor(leader, u) >= 0;

// A "lead" = your leader L + the friend leader F (F may be L itself).
const lBoost = (lead, u) => Math.max(0, boostFor(lead.L, u));
const fBoost = (lead, u) => Math.max(0, boostFor(lead.F, u));
// For choosing units: the boost averaged over both forms of an exchange unit (a form the leaders miss drags it down).
const boostAvg = (lead, u) => avg(forms(u).map(f => lBoost(lead, f) + fBoost(lead, f)));
const coveredBy = (lead, u) => covers(lead.L, u) || covers(lead.F, u);
const leadKi = (lead, u) => kiFor(lead.L, u) + kiFor(lead.F, u);

// ---------- unit traits ----------
// Exchange units (Reversible Exchange) spend the battle in two forms: u and u.xform (loaded in build()).
const forms = u => (u.xform ? [u, u.xform] : [u]);
// A unit's names: every form's (an exchange unit can turn into the other form mid-fight, so both count).
// The game forbids two cards with the same name in a team; the friend is the one exception (it may copy your leader).
const formNames = u => forms(u).map(f => f.name);
const takesName = (set, u) => formNames(u).some(n => set.has(n));
const addNames = (set, u) => { for (const n of formNames(u)) set.add(n); return set; };
const clash = (a, b) => a.id !== b.id && formNames(a).some(n => formNames(b).includes(n));
// A transformed form (id 4xxxxxx) only exists by exchanging: it can't be a card on its own in your team.
const isFormCard = u => /^4\d{6}$/.test(String(u.id));
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
// Stacker if either form stacks permanently.
const stackScore = u => Math.max(...forms(u).map(f => f.stacking?.score || 0));
function sharedLinks(a, b) {
  const set = new Set(a.linkNames);
  return b.linkNames.filter(n => set.has(n));
}
// Shared-link count, averaged over every form pairing (an exchange unit links differently after swapping).
const lk = (a, b) => avg(forms(a).flatMap(x => forms(b).map(y => sharedLinks(x, y).length)));
const rarityBonus = r => ({ LR: 3, UR: 2, SSR: 0 }[r] ?? -2);
// Newer units are usually stronger: a small tie-break, about +0.6 per year after 2019.
function newness(u) {
  const y = Number((u.release || '').match(/(\d{4})\s*$/)?.[1] || 0);
  return y ? Math.max(0, Math.min(8, y - 2019)) * 0.6 : 0;
}
// Ki a unit gives itself every turn from its passive (basic effects / start of each turn only).
function passiveKi(u) {
  if (u._pki != null) return u._pki;
  let ki = 0;
  for (const s of u.passive || []) {
    if (!/basic effect|start of each turn/i.test(s.cond) || /for every|when|after|turns? from/i.test(s.cond)) continue;
    for (const f of s.fx) { const m = f.text.match(/^Ki \+(\d+)/); if (m) ki += Number(m[1]); }
  }
  return (u._pki = ki);
}
// Ki a link gives at max level ("Prepared for Battle [Ki +2 and ATK & DEF +5%]").
const linkKi = text => Number((((text.match(/\[(.*)\]/) || [])[1] || '').match(/Ki \+(\d+)/) || [])[1] || 0);
// Shared links that give Ki: counted when choosing teammates (Ki makes the Super Attack happen).
function kiLinksWith(a, b) {
  const set = new Set(a.linkNames);
  return b.linkNames.reduce((n, name, i) => n + (set.has(name) && linkKi(b.linksMax[i] || '') ? 1 : 0), 0);
}

// ---------- passive conditions that depend on the team ----------
// Checks clauses like "3 or more Extreme Class allies are on the team", "another "X" Category ally on the team",
// "Per "X" Category ally on the team" or "... attacking in the same turn" against the real team.
// Clauses joined by ", or" / "or when" are alternatives (any one is enough). Sphere/turn/enemy clauses can't be
// decided from the team; they're kept as "other" so a section isn't wrongly marked as unmet when one of them applies.
const quoted = s => [...s.matchAll(/"([^"]+)"/g)].map(m => m[1]);
function clauseCheck(cl, allies, partners) {
  const sameTurn = /attacking in the same turn/i.test(cl);
  const pool = sameTurn ? partners : allies;
  const scope = sameTurn ? 'turn' : 'team';
  let m;
  if ((m = cl.match(/all allies are (Super|Extreme) Class/i)))
    return { scope, met: allies.length > 0 && allies.every(a => a.cls === cap(m[1])), need: `all allies ${m[1]} Class` };
  // (not "Per … Class ally" scaling: that word is checked at the start only, since "Super" also contains "per")
  if ((m = cl.match(/(?:(\d+) or more |there are (\d+) )?(Super|Extreme) Class all(?:y|ies)/i)) && !/^\s*(?:when\s+)?Per\b/i.test(cl)) {
    const n = Number(m[1] || m[2] || 1), have = pool.filter(a => a.cls === cap(m[3])).length;
    return { scope, met: have >= n, need: `${n}+ ${m[3]} Class`, have };
  }
  if ((m = cl.match(/(\d+) or more (AGL|TEQ|INT|STR|PHY) Type all/i))) {
    const n = Number(m[1]), have = pool.filter(a => a.type === m[2].toUpperCase()).length;
    return { scope, met: have >= n, need: `${n}+ ${m[2]} Type`, have };
  }
  if (/Category all(y|ies)/i.test(cl)) {
    const cats = quoted(cl.split(/Category all/i)[0]);
    if (!cats.length) return null;
    const have = pool.filter(a => cats.some(c => a.categories.includes(c))).length;
    if (/^\s*Per\b/i.test(cl)) return { scope, met: have > 0, need: `per ${cats.join('/')} ally`, have, per: true };
    const n = Number((cl.match(/(\d+) or more/) || [])[1] || 1);
    return { scope, met: have >= n, need: `${n > 1 ? n + '+ ' : ''}${cats.join(' or ')} ally`, have };
  }
  if ((m = cl.match(/ally whose name includes "([^"]+)"/i))) {
    const have = pool.filter(a => a.name.includes(m[1])).length;
    return { scope, met: have > 0, need: `an ally named ${m[1]}`, have };
  }
  return { scope: 'other' };   // Ki spheres, turn count, enemies...
}
const cap = w => w[0].toUpperCase() + w.slice(1).toLowerCase();
// One passive section's condition, checked for unit `u` with these allies (team) and same-turn partners.
function condCheck(cond, allies, partners) {
  if (!/all(y|ies)\b/i.test(cond)) return null;              // not about allies at all
  const clauses = cond.replace(/^Activates the Entrance Animation\s*/i, '').split(/,\s*or\s+|\s+or when\s+|\s+or starting\b|\s+or a "/i);
  const checks = clauses.map(cl => clauseCheck(cl, allies, partners)).filter(Boolean);
  const decidable = checks.filter(c => c.scope !== 'other');
  if (!decidable.length) return null;
  const met = decidable.some(c => c.met);
  return { cond, met, alt: checks.some(c => c.scope === 'other'), scope: decidable.some(c => c.scope === 'turn') ? 'turn' : 'team',
    need: decidable.map(c => c.need).join(' or '), have: decidable.find(c => c.have != null)?.have ?? null, per: decidable.some(c => c.per) };
}
// All ally-dependent sections of a unit's passive, checked against the team (and its same-turn partners).
function teamConds(u, allies, partners) {
  return (u.passive || []).map(s => condCheck(s.cond, allies, partners)).filter(Boolean);
}
// Score for met conditions: a met one is worth having, an unmet one costs a little (alternatives like spheres soften it).
const condValue = cs => cs.reduce((a, c) => a + (c.met ? 8 : (c.alt ? -1 : -3)), 0);

// ---------- Festival of Battles survival ----------
// Enemy stats per phase (DokkanInfo) + damage formula (DokkanStats guide; a second, independent damage-taken
// calculator, dokkan-battle-atk-calculator.netlify.app, uses the same one):
//   hit = enemy ATK x SA mult x type mult x (1 - damage reduction) x variance (1.00-1.03)
//   damage = hit - DEF, halved when guarding
// A unit takes 0 damage when DEF >= hit. Type mult: a neutral same-class match-up (1.00) at the worst variance
// (1.03); a unit that guards takes EVERY hit at 0.80 instead, so guard lowers the DEF it needs by a fifth (its x0.5
// only halves damage that gets through). Type advantage (which also guards) can't be counted: the event data has no
// enemy types.
const VARIANCE = 1.03, GUARD_TYPE = 0.8;
// Events with their enemies in fight order. Festival lists 56 enemies over 50 phases without phase numbers, so its
// phase is estimated; Meteor Survival's phases are pinned from its missions.
const EVENTS = {};
for (const [key, file, phases] of [['festival', 'festival-of-battles', 50], ['meteor', 'meteor-survival', 20]]) {
  try {
    const d = require(`../data/${file}.json`);
    // charges: [[fromPhase, toPhase, charges]] = clear each phase within that many charges or the run ends (null = no limit)
    EVENTS[key] = { name: d.event, phases, charges: d.charges || null, enemies: d.enemies.map((e, i, all) =>
      ({ ...e, phase: e.phase || Math.min(phases, Math.round(1 + i * (phases - 1) / (all.length - 1))) })) };
  } catch {}
}
const eventOf = key => (key && Object.hasOwn(EVENTS, key) ? EVENTS[key] : null);   // own keys only ("constructor" isn't an event)
// Real cleared teams per event (a bundled snapshot of a players' clear board): the strongest evidence of what works.
// A simulation of the game can't be trusted for that (damage depends on dozens of conditions the calculators
// themselves disagree on), so in event mode the builder leans on what players actually cleared with.
const CLEARS = {};
for (const [key, file] of [['festival', 'festival-of-battles-clears']]) {
  try {
    const d = require(`../data/${file}.json`);
    const usage = new Map(), asLeader = new Map();
    for (const t of d.teams) {
      for (const id of new Set([t.leader, ...t.subs])) usage.set(id, (usage.get(id) || 0) + 1);
      asLeader.set(t.leader, (asLeader.get(t.leader) || 0) + 1);
    }
    CLEARS[key] = { ...d, n: d.teams.length, usage, asLeader };
  } catch {}
}
const clearsOf = key => (key && Object.hasOwn(CLEARS, key) ? CLEARS[key] : null);
// Posted clears that used this card (either form of an exchange unit); its share of the clears, 0..1; as leader, likewise.
const clearCount = (cl, u) => (!cl ? 0 : Math.max(...forms(u).map(f => cl.usage.get(String(f.id)) || 0)));
const proven = (cl, u) => (!cl ? 0 : clearCount(cl, u) / cl.n);
const provenLeader = (cl, u) => (!cl ? 0 : (cl.asLeader.get(String(u.id)) || 0) / cl.n);
// Event rule: a unit the builder adds (leader, friend, open slot) must last the event: it stacks (permanent ATK / DEF
// raises) or players cleared the event with it. Checked against the 155 posted Festival clears: 87% of their units
// stack, and the rest are proven by the clears themselves. The 0-damage DEF estimate is NOT used for this: it marked
// 59% of those real units as hit before phase 30, so it can't tell a unit that lasts from one that doesn't.
const fitsEvent = (cl, u) => stackScore(u) > 0 || clearCount(cl, u) > 0;
const TIMED_RE = /for \d+ turns?|within the turn|for the turn|this turn|temporarily|turns? from the character/i;
// Super Attack raise sizes, read off DokkanStats card pages: Raises +20%, Greatly +50%, Massively +100%.
function saDefStack(u) {
  const sa = u.stacking?.superAttack || '';
  let pct = 0;
  for (const m of sa.matchAll(/(?:(slightly|greatly|massively|immensely|tremendously) )?raises ((?:ATK & )?DEF)(?: by (\d+)%)?\b/gi)) {
    const clause = sa.slice(m.index + m[0].length).split(/[,;]/)[0].split(/\bcauses\b/i)[0];
    if (TIMED_RE.test(clause)) continue;
    const word = (m[1] || '').toLowerCase();
    pct += m[3] ? Number(m[3]) : { slightly: 10, greatly: 50, massively: 100, immensely: 150, tremendously: 200 }[word] ?? 20;
  }
  return pct;
}
// The other kind of Super Attack DEF raise: "greatly raises DEF for 1 turn". It doesn't stack; it only helps on
// the turn it Supers, and only against hits that come after its attack. Shown as a note, not counted.
function saDefTurn(u) {
  const sa = u.stacking?.superAttack || '';
  let pct = 0;
  for (const m of sa.matchAll(/(?:(slightly|greatly|massively|immensely|tremendously) )?raises ((?:ATK & )?DEF)(?: by (\d+)%)?\b/gi)) {
    const clause = sa.slice(m.index + m[0].length).split(/[,;]/)[0].split(/\bcauses\b/i)[0];
    if (!TIMED_RE.test(clause)) continue;
    const word = (m[1] || '').toLowerCase();
    pct = Math.max(pct, m[3] ? Number(m[3]) : { slightly: 10, greatly: 50, massively: 100, immensely: 150, tremendously: 200 }[word] ?? 20);
  }
  return pct;
}
const leaderDef = (leader, u) => {
  let best = 0;
  for (const p of leader.leader.parts || []) {
    if (!partCovers(p, u)) continue;
    const add = p.add && p.add.def && p.add.categories.some(c => u.categories.includes(c)) ? p.add.pct : 0;
    best = Math.max(best, (p.def || 0) + add);
  }
  return best;
};
// Everything in a unit's kit that changes how much damage it takes, given which team conditions are met.
// "As the 1st attacker in a turn", "As the 2nd or 3rd attacker in a turn", "When the character is the 2nd attacker at
// the start of turn": true when the unit's slot matches.
// role: 'first' | 'second' | 'floater' (3rd slot); unknown role -> slot conditions don't count.
const SLOT_NO = { first: 1, second: 2, floater: 3 };
const SLOT_COND_RE = /^(?:as|when the character is) the ((?:1st|2nd|3rd)(?:(?:,| or| and|, or)\s*(?:1st|2nd|3rd))*) attacker (?:in a turn|at the start of (?:the )?turn)\s*$/i;
function slotCondMet(cond, role) {
  const m = cond.match(SLOT_COND_RE);
  if (!m || !SLOT_NO[role]) return false;
  return (m[1].match(/[123]/g) || []).map(Number).includes(SLOT_NO[role]);
}
const SLOT_TXT = { first: '1st', second: '2nd', floater: '3rd' };
const SLOT_RE = /as the ((?:1st|2nd|3rd)(?:(?:,| or| and|, or)\s*(?:1st|2nd|3rd))*) attacker in a turn/i;
const slotWhy = (slots, role) => `only as the ${slots} attacker in a turn; in this slot it attacks ${SLOT_TXT[role] || 'in another order'}`;
// What a passive section's condition means for EVERY hit of the run: counted (from the first turn, from turn N,
// for one kind of hit, as a stack...) or not, and why not.
function sectionRule(c, role, teamConds) {
  const slot = c.match(SLOT_COND_RE);
  if (slot) return slotCondMet(c, role) ? { on: true, bySlot: true } : { on: false, why: slotWhy(slot[1], role) };
  if (/^basic effect/i.test(c) || /^activates the entrance animation upon the character's entry\s*$/i.test(c)) return { on: true };
  if (/^at the start of each turn\s*$/i.test(c)) return { on: true, kind: 'turn' };
  let m;
  if ((m = c.match(/^starting from the (\d+)(?:st|nd|rd|th) turn from the (character's entry turn|start of battle)\s*$/i)))
    return { on: true, from: Number(m[1]), fromBattle: /battle/i.test(m[2]) };
  if (/^for every turn passed\s*$/i.test(c)) return { on: true, kind: 'passed' };
  // plain "when receiving an attack" only: not "... from an enemy who is hit by ..." and other extra conditions
  if (/^(when|after) (receiving|evading)( or (receiving|evading))? an attack\s*$/i.test(c)) return { on: true, onHit: true };
  if ((m = c.match(/^when receiving an? (Super Attack|normal attack)\s*$/i))) return { on: true, onHit: true, hit: /super/i.test(m[1]) ? 'superDamage' : 'atk' };
  if (/^after guard is activated\s*$/i.test(c)) return { on: true, afterGuard: true };
  if (/for every|with each|each time|every time/i.test(c) && !TIMED_RE.test(c)) return { on: true, stacky: true };
  const tc = teamConds.get(c);   // a team condition, checked against the real team
  if (tc) return tc.met ? { on: true, team: tc } : { on: false, why: `needs ${tc.need}${tc.scope === 'turn' ? ' attacking in the same turn' : ''}` };
  return { on: false, why: notWhy(c) };
}
// Why a condition can't be counted on for every hit of the run.
function notWhy(c) {
  let m;
  if ((m = c.match(/^for (\d+) turns?(?:\(s\))? from the character's entry turn/i))) return `first ${m[1] === '1' ? 'turn' : m[1] + ' turns'} only`;
  if ((m = c.match(/\bfor (\d+) turns?/i))) return m[1] === '1' ? 'one turn only' : `${m[1]} turns only`;
  if (/HP is \d+% or/i.test(c)) return 'depends on HP';
  if (/Ki Sphere/i.test(c)) return 'needs Ki Spheres';
  if (/\d+ or more Ki\b/i.test(c)) return 'needs Ki';
  if ((m = c.match(/before receiving (\d+) attacks? in battle/i))) return `only for the first ${m[1]} hits of the battle`;
  if (/before receiving an attack within the turn/i.test(c)) return 'only for the first hit of each turn';
  if (/before receiving/i.test(c)) return 'only before it gets hit';
  if (/attacking|attack (?:performed|launched)|Super Attack/i.test(c)) return 'only around its own attack';
  if (/revival/i.test(c)) return 'only after a Revival';
  if (/enem/i.test(c)) return 'depends on the enemy';
  return `only “${c}”`;
}
// A line can carry its own condition on top of its section's ("... as the 1st attacker in a turn", "for 4 turns").
function lineRule(t, role, sec) {
  const slot = t.match(SLOT_RE);
  if (slot && !slotCondMet(`As the ${slot[1]} attacker in a turn`, role)) return { on: false, why: slotWhy(slot[1], role) };
  let m;
  if ((m = t.match(/temporarily when receiving an? (normal attack|Super Attack|attack)\b/i)))
    return { on: true, onHit: true, hit: /super/i.test(m[1]) ? 'superDamage' : /normal/i.test(m[1]) ? 'atk' : null };
  if ((m = t.match(/\bfor (\d+) turns?/i))) return { on: false, why: m[1] === '1' ? 'one turn only' : `${m[1]} turns only` };
  if (/within the turn|for the turn|this turn/i.test(t)) return { on: false, why: 'resets every turn' };
  if (/temporarily/i.test(t) && !sec.onHit) return { on: false, why: 'for a moment only' };
  if (/when attacking|before attacking|after attacking|attacking turn/i.test(t)) return { on: false, why: 'only around its own attack' };
  if (/\d+ or more Ki\b|per Ki Sphere|Ki Spheres? obtained/i.test(t)) return { on: false, why: 'needs Ki' };
  if (/(?:if|when) HP is/i.test(t)) return { on: false, why: 'depends on HP' };
  return { on: true };
}
// A line's part for this unit: its own effects, plus a part for allies ('"Fusion" Category allies' DEF 40% ▲') only
// when it belongs to those allies (and isn't "(self excluded)").
function ownPart(t, u) {
  const i = t.search(/\ballies'?(?=[\s(]|$)/i);
  if (i < 0) return t;
  const before = t.slice(0, i);
  const q = before.match(/(?:(?:Super|Extreme) (?:Class|Type)\s+)?(?:"[^"]+"(?:\s*(?:,|or|, or)\s*"[^"]+")*\s+Category\s+)?(?:(?:AGL|TEQ|INT|STR|PHY) Type\s+)?(?:all\s+)?$/i);
  const qual = (q ? q[0] : '').trim(), own = before.slice(0, before.length - (q ? q[0].length : 0));
  return own + (belongsTo(qual, u) && !/self excluded/i.test(t.slice(i)) ? ' ' + t.slice(own.length) : '');
}
function belongsTo(qual, u) {
  if (!qual) return false;   // "for allies whose names include ...": not decided here
  if (/^all$/i.test(qual)) return true;
  // (older cards say "Extreme Type allies'" for the class)
  const cls = qual.match(/(Super|Extreme) (?:Class|Type)/i), type = qual.match(/(AGL|TEQ|INT|STR|PHY) Type/i), cats = quoted(qual);
  if (cls && u.cls !== cap(cls[1])) return false;
  if (type && u.type !== type[1].toUpperCase()) return false;
  if (cats.length && !cats.some(c => (u.categories || []).includes(c))) return false;
  return !!(cls || type || cats.length);
}
// Everything in a unit's passive that changes the damage it takes (DEF, damage reduction, guard), given which team
// conditions are met and its slot. Effects on from the first turn for every hit are summed (start, receiving, dr,
// guard, drHit for one kind of hit); DEF stacks go in stacks; the rest that starts later, grows or fades goes in
// later; what can't be counted on for every hit goes in notCounted, with the reason (the page shows both).
function defenseKit(u, conds, role) {
  const teamConds = new Map((conds || []).map(c => [c.cond, c]));
  let start = 0, receiving = 0, dr = 0, guard = false;
  const drHit = { atk: 0, superDamage: 0 };
  const stacks = [];      // passive DEF stacks: { per, cap, kind, onAttack } - 'attack' ones only grow when the unit attacks
  const later = [];       // { stat: 'def' | 'dr' | 'guard', pct | stack | fade, from, fromBattle, hit }
  const bySlot = [], notCounted = [], afterGuard = [];
  const skip = (text, why) => { if (!notCounted.some(x => x.text === text && x.why === why)) notCounted.push({ text, why }); };
  const take = (s, sec) => {
    const c = s.cond;
    for (const f of s.fx) {
      const t = ownPart(f.text, u);
      const defs = [...t.matchAll(/\bDEF \+?(\d+)%(?! ▼)/g)].map(m => Number(m[1]));
      // "damage reduction rate 40% ▲", also "Damage reduction rate & chance of performing a critical hit 18% ▲"
      const drs = [...t.matchAll(/damage reduction rate\b[^%▲▼]*?(\d+)%(?! ▼)/gi)].map(m => Number(m[1]));
      // a reduction that falls: "... 10% ▼ for every turn passed (no more than -60%)", or the same under a
      // "For every turn passed" section; any other falling one ("after receiving 7 or more attacks") is counted at
      // its worst from the start, even when its condition can't be checked: it only makes things worse
      const fade = /enem[^▲]*damage reduction rate \d+% ▼/i.test(t) ? null   // an enemy's reduction going down isn't its own
        : t.match(/damage reduction rate (\d+)% ▼( for every turn passed)?(?: \(no more than -(\d+)%\))?/i);
      const guards = /\bguards all attacks\b/i.test(t);
      const chance = (t.match(/(?:\b\w+ )?chance of (?:guarding all attacks|evading)/i) || [])[0];
      if (!defs.length && !drs.length && !fade && !guards && !chance) continue;   // nothing about the hits it takes
      if (fade && (sec.on || !SLOT_COND_RE.test(c))) {
        later.push({ stat: 'dr', fade: { per: Number(fade[1]), cap: Number(fade[3] || fade[1]), perTurn: !!sec.on && (!!fade[2] || sec.kind === 'passed') },
          from: (sec.on && sec.from) || 1, fromBattle: !!sec.fromBattle });
        if (!defs.length && !drs.length && !guards && !chance) continue;
      }
      if (!sec.on) { skip(f.text, sec.why); continue; }
      const line = lineRule(t, role, sec);
      if (!line.on) { skip(f.text, line.why); continue; }
      if (chance) skip(chance, 'a chance, not every hit');
      const hit = line.hit || sec.hit || null;   // 'atk' | 'superDamage' | null = every hit
      const onHit = line.onHit || sec.onHit || /when receiving an attack/i.test(t);
      const upTo = Number((t.match(/\(up to (\d+)%\)/) || [])[1] || 0);
      // "for every attack performed / Super Attack / when attacking" needs the unit to attack; "attack received", turns, Ki Spheres don't
      const kind = sec.stacky ? (upTo ? (/attack (performed|launched|made)|super attack|when attacking|performs|launch/i.test(c + ' ' + t) && !/received|receiving/i.test(c + ' ' + t) ? 'attack' : 'hit') : 'none')
        : (sec.kind && upTo ? sec.kind : null);
      const from = sec.from || 0, fromBattle = !!sec.fromBattle;
      if (kind === 'none') continue;   // a stack with no cap: not counted (as before)
      const per = pct => (sec.team?.per ? Math.min(upTo || Infinity, pct * (sec.team.have || 0)) : pct);   // "Per X ally on the team"
      for (const pct of defs) {
        if (kind) stacks.push({ per: pct, cap: upTo, kind, onAttack: kind === 'attack', from });
        else if (from > 1) later.push({ stat: 'def', pct: per(pct), from, fromBattle });
        else if (onHit) receiving += per(pct); else start += per(pct);
      }
      for (const pct of drs) {
        if (kind) later.push({ stat: 'dr', stack: { per: pct, cap: upTo, kind }, from, fromBattle, hit });
        else if (from > 1) later.push({ stat: 'dr', pct: per(pct), from, fromBattle, hit });
        else if (hit) drHit[hit] += per(pct); else dr += per(pct);
      }
      if (guards) { if (from > 1) later.push({ stat: 'guard', from, fromBattle }); else if (!hit) guard = true; }
    }
  };
  for (const s of u.passive || []) {
    const sec = sectionRule(s.cond, role, teamConds);
    if (sec.bySlot) bySlot.push(s.cond);
    if (sec.afterGuard) afterGuard.push(s); else take(s, sec);
  }
  // "After guard is activated": every hit, when the unit always guards
  for (const s of afterGuard) take(s, guard ? { on: true } : { on: false, why: 'only after it guards' });
  const notes = [...later.map(laterText),
    ...['superDamage', 'atk'].filter(h => drHit[h]).map(h => `damage reduction +${drHit[h]}%${HIT_TXT[h]}`)];
  return { start, receiving, stackCap: stacks.reduce((a, s) => a + s.cap, 0), stacks, dr: Math.min(dr, 90), drHit, guard, later, notes, notCounted,
    saStack: saDefStack(u), saDefTurn: saDefTurn(u), bySlot };
}
const KIND_TXT = { attack: 'per Super Attack', hit: 'per hit taken', turn: 'each turn', passed: 'per turn passed' };
const HIT_TXT = { atk: ' vs normal attacks', superDamage: ' vs Super Attacks' };
function laterText(e) {
  const when = e.from > 1 ? ` from turn ${e.from}${e.fromBattle ? ' of the battle' : ''}` : '';
  if (e.stat === 'guard') return `guards all attacks${when}`;
  if (e.fade) return e.fade.perTurn ? `damage reduction −${e.fade.per}% per turn passed (down to −${e.fade.cap}%)${when}` : `damage reduction −${e.fade.cap}% (counted at its worst)${when}`;
  const what = e.stat === 'def' ? 'DEF' : 'damage reduction';
  if (e.stack) return `${what} +${e.stack.per}% ${KIND_TXT[e.stack.kind]} (up to ${e.stack.cap}%)${HIT_TXT[e.hit] || ''}${when}`;
  return `${what} +${e.pct}%${HIT_TXT[e.hit] || ''}${when}`;
}
// Where a map position attacks: rotation units come out every other turn (slot 1 or 2 of the 3 on field),
// floaters show up about one turn in three (slot 3). r1a / r2a attack first.
const ROLE = { r1a: 'first', r2a: 'first', r1b: 'second', r2b: 'second', f1: 'floater', f2: 'floater', f3: 'floater' };
// Times a unit has been on the field before turn T (its DEF stacks come from earlier turns).
function outingsBefore(pos, T) {
  if (pos === 'r1a' || pos === 'r1b') return Math.ceil((T - 1) / 2);   // out on turns 1, 3, 5...
  if (pos === 'r2a' || pos === 'r2b') return Math.floor((T - 1) / 2);  // out on turns 2, 4, 6...
  return Math.floor((T - 1) / 3);                                      // a floater, on average
}
// When each map position first comes out (its "entry turn"): rotation 1 on turn 1, rotation 2 on turn 2, floaters
// about turn 2.
const ENTRY = { r1a: 1, r1b: 1, r2a: 2, r2b: 2, f1: 2, f2: 2, f3: 2 };
// The kit at enemy i (fought on turn i + 1, one enemy per turn): DEF % from stacks and effects that start later,
// damage reduction per kind of hit, and guard. attacks: it gets its Super in every time it's out. fresh: as on its
// first turn (nothing has started or grown yet; what fades still fades).
function kitAt(kit, i, pos, attacks, fresh) {
  const T = i + 1, entry = ENTRY[pos] || 1, out = outingsBefore(pos, T), since = Math.max(0, T - entry);
  const supers = attacks && !fresh ? out : 0;
  // steps a stack has taken: per Super Attack, per hit (full once it has been out 3 times), per turn out (as of its
  // next turn out), per turn passed since it came out
  const steps = kind => (fresh ? (kind === 'turn' ? 1 : 0) : { attack: supers, hit: out >= 3 ? Infinity : out, turn: out + 1, passed: since }[kind] || 0);
  const startTurn = e => (e.fromBattle ? e.from : entry + (e.from || 1) - 1);
  const on = e => !(e.from > 1) || (!fresh && T >= startTurn(e));
  let def = 0, guard = kit.guard;
  const dr = { atk: kit.dr + kit.drHit.atk, superDamage: kit.dr + kit.drHit.superDamage };
  const addDr = (hit, pct) => { if (hit !== 'superDamage') dr.atk += pct; if (hit !== 'atk') dr.superDamage += pct; };
  for (const s of kit.stacks) if (on(s)) def += Math.min(s.cap, s.per * steps(s.kind));
  for (const e of kit.later) {
    if (!on(e)) continue;
    if (e.fade) { addDr(null, -(e.fade.perTurn ? Math.min(e.fade.cap, e.fade.per * Math.max(0, T - startTurn(e))) : e.fade.cap)); continue; }
    const pct = e.stack ? Math.min(e.stack.cap, e.stack.per * steps(e.stack.kind)) : e.pct;
    if (e.stat === 'def') def += pct; else if (e.stat === 'guard') guard = true; else addDr(e.hit, pct);
  }
  const clamp = x => Math.max(0, Math.min(90, x));
  return { def, guard, dr: { atk: clamp(dr.atk), superDamage: clamp(dr.superDamage) } };
}
// DEF when hit: base x (1 + leader + friend) x (1 + passive) x (1 + links) x (1 + Super Attack stacks) x (1 + "when receiving" boosts).
const defOn = (base, lb, linkDef, kit, extra, supers) =>
  base * lb * (1 + (kit.start + extra) / 100) * (1 + linkDef / 100) * (1 + supers * kit.saStack / 100) * (1 + kit.receiving / 100);
const leaderMult = (lead, u) => 1 + (leaderDef(lead.L, u) + leaderDef(lead.F, u)) / 100;
// DEF when hit, enemy by enemy through the run. Assumes each enemy falls in one turn (the fastest run,
// so the fewest stacks: a slower run only stacks more). attacks=false: the unit never gets to attack
// (the unit before it kills), so it gains no Super Attack stacks and no "per attack" passive stacks.
function defTimeline(base, lead, u, linkDef, kit, pos, ev, attacks) {
  const lb = leaderMult(lead, u);
  return ev.enemies.map((e, i) => defOn(base, lb, linkDef, kit, kitAt(kit, i, pos, attacks, false).def, attacks ? outingsBefore(pos, i + 1) : 0));
}
// The 0-damage bar, enemy by enemy: the DEF it needs so that hit - DEF <= 0, against normal attacks (atk) and
// Super Attacks (superDamage), with its guard and damage reduction at that point of the run. Enemies that can crit
// are counted at their worst (x1.5).
function hitBars(kit, ev, pos, attacks, fresh) {
  const bars = { atk: [], superDamage: [] };
  ev.enemies.forEach((e, i) => {
    const k = kitAt(kit, i, pos, attacks, fresh);
    for (const key of ['atk', 'superDamage']) bars[key].push(e[key] * (e.crit ? 1.5 : 1) * (k.guard ? GUARD_TYPE : 1) * (1 - k.dr[key] / 100) * VARIANCE);
  });
  return bars;
}
// Like lastsUntil, but with a DEF that changes from enemy to enemy.
function lastsAlong(defs, bars, ev) {
  const E = ev.enemies;
  const safe = (i, key) => defs[i] >= bars[key][i];
  // A stacking unit can be hurt early (nothing stacked yet) and safe later: report the first safe stretch
  // ("safe from phase A up to phase B"), and from: null when it is safe from the first enemy.
  const run = key => {
    let s = 0;
    while (s < E.length && !safe(s, key)) s++;
    if (s === E.length) return { phase: 0, all: false, never: true, breaksAt: { phase: E[0].phase, enemy: E[0].name, def: Math.round(defs[0]) } };
    let i = s;
    while (i < E.length && safe(i, key)) i++;
    const breaker = E[i];
    // a stretch that starts after an enemy got through only counts as "all" if it then lasts to the end
    return { phase: breaker ? Math.max(0, breaker.phase - 1) : E[E.length - 1].phase, all: !breaker && s === 0,
      from: s > 0 ? E[s].phase : null, toEnd: !breaker,
      breaksAt: breaker ? { phase: breaker.phase, enemy: breaker.name, def: Math.round(defs[i]) } : null };
  };
  return { normal: run('atk'), super: run('superDamage') };
}
// How far into the run (enemies in fight order) this DEF takes 0 damage, for normal attacks and for Super Attacks.
// The run is one long fight, so it stops at the first enemy that gets through, even if a later one is weaker.
function lastsUntil(def, bars, ev) {
  const E = ev.enemies;
  const until = key => { let last = -1; for (let i = 0; i < E.length; i++) { if (def >= bars[key][i]) last = i; else break; } return last; };
  // phase = last phase fully cleared without damage (the phase where the breaking enemy appears doesn't count)
  const out = idx => {
    const breaker = E[idx + 1];
    return { phase: breaker ? Math.max(0, breaker.phase - 1) : E[E.length - 1].phase, all: !breaker,
      breaksAt: breaker ? { phase: breaker.phase, enemy: breaker.name } : null };
  };
  return { normal: out(until('atk')), super: out(until('superDamage')) };
}
// DEF this unit (with its guard / damage reduction) needs to take 0 damage from every enemy of the event,
// and the enemy that sets that bar.
function defNeeded(bars, ev) {
  const worst = key => ev.enemies.reduce((best, e, i) => {
    const need = Math.ceil(bars[key][i]);
    return need > best.need ? { need, phase: e.phase, enemy: e.name } : best;
  }, { need: 0 });
  return { normal: worst('atk'), super: worst('superDamage') };
}
// When a stacker has stacked enough to give up the 1st slot (rotations can be reordered mid-fight).
// defs: its DEF enemy by enemy while it attacks 1st. Its Super Attack stacks are permanent, so if it stops attacking
// before enemy i its DEF stays at defs[i]. "ready" = the first point where that frozen DEF already covers every enemy
// left; "marks" = what happens if you take it out of slot 1 at a few points of the run.
function handover(defs, bars, ev) {
  const E = ev.enemies;
  const need = (j, key) => bars[key][j];
  const lastsFrom = (i, key) => { let j = i; while (j < E.length && defs[i] >= need(j, key)) j++; return j; };
  const side = key => {
    const suf = new Array(E.length + 1).fill(0);
    for (let j = E.length - 1; j >= 0; j--) suf[j] = Math.max(suf[j + 1], need(j, key));
    const i = defs.findIndex((d, k) => d >= suf[k]);
    return i < 0 ? null : { phase: E[i].phase, enemy: E[i].name, def: Math.round(defs[i]) };
  };
  const marks = [];
  for (let q = 1; q <= 4; q++) {
    const i = E.findIndex(e => e.phase >= Math.round(ev.phases * q / 5));
    if (i <= 0 || marks.some(m => m.i === i)) continue;
    const res = key => { const j = lastsFrom(i, key); return j === i ? { now: true } : j === E.length ? { end: true } : { until: E[j].phase - 1, by: E[j].name }; };
    marks.push({ i, phase: E[i].phase, def: Math.round(defs[i]), normal: res('atk'), super: res('superDamage') });
  }
  return { normal: side('atk'), super: side('superDamage'), marks: marks.map(({ i, ...m }) => m) };
}
// pos: where it sits on the rotation map. Its DEF is followed turn by turn through the run, in two cases:
// "attacks" (it gets its Super in every time it's out) and "blocked" (the unit before it kills, so it never attacks).
// A 1st attacker always attacks; for 2nd-slot units and floaters the "blocked" case is the one shown as the result.
async function survival(lead, u, st, evKey, pos) {
  const ev = eventOf(evKey);
  if (!ev) return null;
  let stats = null;
  try { stats = await src.cardStats(u.id); } catch {}
  if (!stats?.def) return null;
  const role = ROLE[pos] || 'second';
  const kit = defenseKit(u, st.conds, role);   // slot-only passives ("as the 2nd or 3rd attacker: guards all attacks") count here
  const fresh = defOn(stats.def, leaderMult(lead, u), st.def, kit, kitAt(kit, 0, pos, false, true).def, 0);
  const attacks = defTimeline(stats.def, lead, u, st.def, kit, pos, ev, true), attacksBars = hitBars(kit, ev, pos, true, false);
  const blocked = role === 'first' ? attacks : defTimeline(stats.def, lead, u, st.def, kit, pos, ev, false);
  const bars = role === 'first' ? attacksBars : hitBars(kit, ev, pos, false, false);   // the result's bar
  const end = a => Math.round(a[a.length - 1]);
  const n = Math.min(10, ev.enemies.length), from = ev.enemies.length - n;
  // the hardest stretch, enemy by enemy, with what its kit counts there (guard, damage reduction)
  const lastEnemies = ev.enemies.slice(from).map((e, j) => {
    const i = from + j, k = kitAt(kit, i, pos, role === 'first', false);
    return { phase: e.phase, enemy: e.name, crit: !!e.crit, normal: Math.ceil(bars.atk[i]), super: Math.ceil(bars.superDamage[i]),
      def: Math.round(blocked[i]), defIfAttacks: Math.round(attacks[i]), guard: k.guard, dr: k.dr.atk, drSuper: k.dr.superDamage };
  });
  // does anything in its kit grow only by attacking? (else its slot doesn't matter for stacking)
  const attackStacker = kit.saStack > 0 || kit.stacks.some(s => s.onAttack) || kit.later.some(e => e.stack?.kind === 'attack');
  // hand-over plan, counted as if it attacks 1st every time it's out (a floater moved 1st joins a rotation: every other turn)
  const asFirst = role === 'floater' ? defTimeline(stats.def, lead, u, st.def, kit, 'r2a', ev, true) : attacks;
  const swap = attackStacker ? handover(asFirst, role === 'floater' ? hitBars(kit, ev, 'r2a', true, false) : attacksBars, ev) : null;
  return { event: evKey, swap, atkStacks: (u.stacking?.saStats || []).includes('ATK'), eventName: ev.name, phases: ev.phases, base: stats.def, state: stats.label, kit, role, pos, attackStacker,
    fresh: Math.round(fresh), freshLasts: lastsUntil(fresh, hitBars(kit, ev, pos, false, true), ev),
    // the result: what this slot can count on
    stacked: end(blocked), stackedLasts: lastsAlong(blocked, bars, ev),
    // the better case, when it does get to attack every time it's out
    ifAttacks: role === 'first' ? null : { stacked: end(attacks), lasts: lastsAlong(attacks, attacksBars, ev) },
    supersByEnd: outingsBefore(pos, ev.enemies.length),
    needed: defNeeded(bars, ev), lastEnemies };
}

// ---------- rotation map ----------
// Positions as drawn: two rotations (left/middle columns) and three floaters (right column).
// Only units drawn next to each other link: the rotation partners, and each rotation's middle unit with every floater.
// Leader sits at r1a, friend at f3; the 5 subs are placed to get the most shared links.
const POS = ['r1a', 'r1b', 'r2a', 'r2b', 'f1', 'f2', 'f3'];
const EDGES = [['r1a', 'r1b'], ['r2a', 'r2b'], ['r1b', 'f1'], ['r1b', 'f2'], ['r1b', 'f3'], ['r2b', 'f1'], ['r2b', 'f2'], ['r2b', 'f3']];

function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
}

// ATK / DEF a link gives at max level ("Fierce Battle [ATK +20%]", "Big Bad Bosses [ATK & DEF +25%]").
function linkStat(text) {
  const body = ((text.match(/\[(.*)\]/) || [])[1] || '').split(/ and |;/)
    .filter(part => !/enem/i.test(part));
  let atk = 0, def = 0;
  for (const part of body) {
    const n = Number((part.match(/\+(\d+)%/) || [])[1] || 0);
    if (/ATK & DEF/.test(part)) { atk += n; def += n; }
    else if (/\bATK\b/.test(part)) atk += n;
    else if (/\bDEF\b/.test(part)) def += n;
  }
  return { atk, def };
}

// Best order for the subs (most shared links), then each unit's link ATK/DEF/Ki and starting Ki.
// `lead` may be a plain unit (friend = same leader) or { L, F }.
// Who attacks in the same turn as `pos`: a rotation unit always attacks with its rotation partner;
// a floater joins either rotation, so it may attack with any of the four rotation units.
const PARTNERS = { r1a: ['r1b'], r1b: ['r1a'], r2a: ['r2b'], r2b: ['r2a'], f1: ['r1a', 'r1b', 'r2a', 'r2b'], f2: ['r1a', 'r1b', 'r2a', 'r2b'], f3: ['r1a', 'r1b', 'r2a', 'r2b'] };
const alliesOf = (slots, pos) => POS.filter(p => p !== pos && slots[p]).map(p => slots[p]);
const partnersOf = (slots, pos) => PARTNERS[pos].map(p => slots[p]).filter(Boolean);

// Attack-driven DEF stacking: Super Attack raises plus "per attack" passive stacks. Only counts if the unit gets to attack.
const attackStackPct = u => saDefStack(u) + defenseKit(u, []).stacks.filter(s => s.onAttack).reduce((a, s) => a + s.cap, 0);
// stackFirst (events): the 1st slot of a rotation always attacks, the 2nd and the floaters often don't (the unit before
// kills), so seat the strongest attack-stacker 1st in rotation 2 (rotation 1 starts with the leader).
function arrange(lead, subs, stackFirst = false) {
  if (!lead.L) lead = { L: lead, F: lead };
  let best = null;
  const stackPct = new Map(stackFirst ? subs.map(u => [u.id, attackStackPct(u)]) : []);
  for (const p of permutations(subs)) {
    const slots = { r1a: lead.L, r1b: p[0], r2a: p[1], r2b: p[2], f1: p[3], f2: p[4], f3: lead.F };
    let total = EDGES.reduce((a, [x, y]) => a + (slots[x] && slots[y] ? lk(slots[x], slots[y]) : 0), 0);
    // worth up to 4 shared links: a +20%-per-Super stacker that never attacks is worth very little in a long event
    if (stackFirst && slots.r2a) total += Math.min(4, (stackPct.get(slots.r2a.id) || 0) / 10);
    // seat units so their "… attacking in the same turn" conditions come true (worth about 2 shared links each)
    for (const pos of POS) if (slots[pos] && pos !== 'f3')
      for (const c of teamConds(slots[pos], alliesOf(slots, pos), partnersOf(slots, pos))) if (c.scope === 'turn' && c.met) total += 2;
    if (!best || total > best.total) best = { slots, total };
  }
  const slots = best ? best.slots : { r1a: lead.L, f3: lead.F };
  const edges = EDGES.filter(([x, y]) => slots[x] && slots[y]).map(([x, y]) => ({ a: x, b: y, links: sharedLinks(slots[x], slots[y]) }));
  // Each unit's link bonus: every link it shares with at least one neighbour, counted once.
  // `u` is who stands at `pos` (an exchange unit's other form gets the same treatment after the swap).
  const statsOf = (pos, u) => {
    const neighbours = EDGES.filter(([x, y]) => x === pos || y === pos).map(([x, y]) => slots[x === pos ? y : x]).filter(Boolean);
    const active = new Set(neighbours.flatMap(n => sharedLinks(u, n)));
    let atk = 0, def = 0, lki = 0;
    u.linkNames.forEach((name, i) => {
      if (!active.has(name)) return;
      const s = linkStat(u.linksMax[i] || ''); atk += s.atk; def += s.def; lki += linkKi(u.linksMax[i] || '');
    });
    const ki = leadKi(lead, u) + lki + passiveKi(u);
    const conds = teamConds(u, alliesOf(slots, pos), partnersOf(slots, pos));
    return { atk, def, active: active.size, ki, kiLeader: leadKi(lead, u), kiLinks: lki, kiPassive: passiveKi(u), lowKi: ki + KI_FROM_ORBS < KI_GOAL,
      conds, condsMet: conds.filter(c => c.met).length };
  };
  // Which form of an exchange unit suits this team better: team conditions met, then link ATK, then Ki.
  const formScore = s => s.condsMet * 30 + s.atk + s.def / 2 + Math.min(s.ki, KI_GOAL) * 2;
  const stats = {};
  for (const pos of POS) {
    const u = slots[pos];
    if (!u) continue;
    stats[pos] = statsOf(pos, u);
    if (u.xform) {
      stats[pos].ex = { ...statsOf(pos, u.xform), id: u.xform.id, name: u.xform.name,
        boost: lBoost(lead, u.xform), fboost: fBoost(lead, u.xform), covered: coveredBy(lead, u.xform), stacker: (u.xform.stacking?.score || 0) > 0 };
      const a = formScore(stats[pos]) + (lBoost(lead, u) + fBoost(lead, u)) / 10, b = formScore(stats[pos].ex) + (stats[pos].ex.boost + stats[pos].ex.fboost) / 10;
      stats[pos].bestForm = Math.abs(a - b) < 5 ? 'either' : a > b ? 'base' : 'ex';
    }
  }
  return { slots, edges, stats, total: best ? best.total : 0 };
}

// How good a finished team is, once arranged: real boosts, link bonuses, Ki, stacking (Festival), newer units.
// cl: the event's real cleared teams (or null): a unit players cleared with counts for a lot.
function teamValue(lead, subs, festival, cl = null) {
  const m = arrange(lead, subs, festival);
  let v = 0;
  for (const pos of ['r1b', 'r2a', 'r2b', 'f1', 'f2']) {
    const u = m.slots[pos]; if (!u) continue;
    // an exchange unit counts half in each form
    const sts = st => st.atk + st.def / 2 + Math.min(st.ki, KI_GOAL) * 2 - (st.lowKi ? 15 : 0) + condValue(st.conds);
    const st = m.stats[pos];
    v += boostAvg(lead, u) / 4 + (st.ex ? (sts(st) + sts(st.ex)) / 2 : sts(st)) + newness(u) * 4 + (festival ? stackScore(u) * 15 : 0)
      + proven(cl, u) * 120;
  }
  return v;
}

// ---------- filling a team ----------
function candidateScore(lead, u, anchors, owned, festival, cl = null) {
  // team conditions this unit would meet with the units already in (rotation ones are decided later, when arranging)
  const early = avg(forms(u).map(f => condValue(teamConds(f, [...anchors, lead.F], []).filter(c => c.scope === 'team')))) / 2;
  return anchors.reduce((a, x) => a + lk(x, u) * 2 + kiLinksWith(x, u), 0) + early
    + boostAvg(lead, u) / 50 + rarityBonus(u.rarity) + newness(u)
    + (owned.has(u.id) ? 2 : 0) + (festival ? stackScore(u) * 4 : 0) + proven(cl, u) * 40;
}

// Fill the open sub slots for one leader + friend. In Festival mode stackers are strongly preferred.
// The friend is borrowed and the game lets it be the same card as one of your units, so its name isn't blocked
// (the standard Festival of Battles team runs the TEQ Angel pair as a sub AND as the friend).
function fillTeam(lead, picks, pool, owned, festival, cl = null) {
  const subs = picks.filter(p => p.id !== lead.L.id);
  const names = [lead.L, ...subs].reduce(addNames, new Set());
  const ids = new Set([lead.L.id, ...subs.map(s => s.id)]);
  const anchors = [lead.L, ...subs];
  const scored = pool
    .filter(u => !ids.has(u.id) && !isFormCard(u) && coveredBy(lead, u))
    .map(u => ({ u, score: candidateScore(lead, u, anchors, owned, festival, cl) }))
    .sort((a, b) => b.score - a.score || String(a.u.id).localeCompare(String(b.u.id)));
  // Event: only units that last (they stack, or players cleared the event with them). One that doesn't is used only
  // when nothing that lasts fits the slot, and the team then ranks below teams without one (scoreTeam's unfit).
  const passes = festival ? [scored.filter(s => fitsEvent(cl, s.u)), scored.filter(s => !fitsEvent(cl, s.u))] : [scored];
  const fill = [];
  for (const pass of passes) {
    for (const s of pass) {
      if (subs.length + fill.length >= SUBS) break;
      if (takesName(names, s.u)) continue;          // the game forbids two cards with the same name (either form)
      addNames(names, s.u);
      fill.push(s.u);
    }
  }
  // Bench: the next best that fit (in an event, only units that last), one per name.
  const bench = [];
  const benchNames = new Set(names);
  for (const s of passes[0]) {
    if (bench.length >= 20) break;
    if (fill.includes(s.u) || takesName(benchNames, s.u)) continue;
    addNames(benchNames, s.u);
    bench.push(s.u);
  }
  return { subs, fill, bench };
}

// Upgrade the filled slots with the rotation in mind: try the best bench units in each filled slot,
// re-arrange, and keep a swap whenever the arranged team is worth more. Picks never move.
function improveFill(lead, r, festival, cl = null) {
  let fill = r.fill.slice(), bench = r.bench.slice(), cur = teamValue(lead, [...r.subs, ...fill], festival, cl);
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (let i = 0; i < fill.length; i++) {
      for (const c of bench.slice(0, 12)) {
        if (festival && fitsEvent(cl, fill[i]) && !fitsEvent(cl, c)) continue;   // never trade a unit that lasts for one that doesn't
        const others = [...r.subs, ...fill.filter((_, j) => j !== i)];
        if ([lead.L, ...others].some(o => clash(o, c) || o.id === c.id)) continue;   // the friend may share a name
        const v = teamValue(lead, [...others, c], festival, cl);
        if (v > cur + 0.5) { bench = [fill[i], ...bench.filter(b => b !== c)]; fill[i] = c; cur = v; changed = true; }
      }
    }
    if (!changed) break;
  }
  return { ...r, fill, bench };
}

// Teams are compared in a fixed order, never by one mixed-up sum (a big stacking bonus used to outvote
// "your pick gets no leader boost"): 1) picks boosted by a leader skill, 2) in an event, fewer units the builder added
// that won't last (a pick with no boost lasts even less, so boosting your picks comes first), 3) picks boosted by
// YOUR leader (the friend is borrowed and may change), 4) quality. Ties go to the lower leader / friend id, so the
// result never wobbles.
function compareTeams(a, b) {
  return (b.coveredPicks - a.coveredPicks) || ((a.unfit || 0) - (b.unfit || 0)) || (b.leaderCoveredPicks - a.leaderCoveredPicks)
    || (b.score - a.score)
    || String(a.lead.L.id).localeCompare(String(b.lead.L.id)) || String(a.lead.F.id).localeCompare(String(b.lead.F.id));
}
function scoreTeam(lead, picks, filled, owned, festival, cl = null) {
  const { subs, fill } = filled;
  const team = [lead.L, ...subs, ...fill, lead.F];
  const coveredPicks = picks.filter(p => coveredBy(lead, p)).length;
  const leaderCoveredPicks = picks.filter(p => covers(lead.L, p)).length;
  const covered = team.slice(0, -1).filter(u => coveredBy(lead, u)).length;
  // Total boost the whole team really gets from both leader skills (uncovered units get nothing).
  const boost = team.reduce((a, u) => a + boostAvg(lead, u), 0);
  const links = [...subs, ...fill].reduce((a, u) => a + picks.reduce((b, p) => b + (p.id === u.id ? 0 : lk(p, u)), 0), 0);
  const stackers = team.slice(0, -1).filter(u => stackScore(u) > 0).length;
  const stack = team.slice(0, -1).reduce((a, u) => a + stackScore(u), 0);
  const kiLinks = [...subs, ...fill].reduce((a, u) => a + [lead.L, ...subs, ...fill].reduce((b, x) => b + (x === u ? 0 : kiLinksWith(x, u)), 0), 0);
  // Quality, only compared between teams that boost the same number of your picks (see compareTeams): the boost
  // your picks get, the whole team's boost, stackers in event mode, links and Ki links, owning the leader.
  const pickBoost = picks.reduce((a, p) => a + boostAvg(lead, p), 0);
  // with the event's real clears: units and leaders players actually cleared with (a unit in every clear = +400)
  const provenTeam = team.slice(0, -1).reduce((a, u) => a + proven(cl, u), 0) + proven(cl, lead.F) / 2;
  const score = pickBoost * 1.5 + boost / 2 + (festival ? stackers * 150 + stack * 10 : 0)
    + links * 10 + kiLinks * 4 + (owned.has(lead.L.id) ? 40 : 0)
    + provenTeam * 400 + provenLeader(cl, lead.L) * 600;
  // event: units the builder added that won't last (the leader unless it's your pick, the filled slots, the friend)
  const pickIds = new Set(picks.map(p => p.id));
  const unfit = festival ? [lead.L, ...fill, lead.F].filter((u, i) => (i > 0 || !pickIds.has(u.id)) && !fitsEvent(cl, u)).length : 0;
  return { coveredPicks, leaderCoveredPicks, covered, size: team.length - 1, boost, score, provenTeam, unfit };
}

function rankLeaders(picks, candidates, pool, owned, festival, lockLeader, cl = null) {
  const seen = new Set();
  const pickIds = new Set(picks.map(p => p.id));
  const leaders = candidates.filter(l => l.leader.parts?.length && !seen.has(l.id) && seen.add(l.id)
    // the leader takes a slot: with 6 picks it has to be one of them (5 subs max)
    && picks.filter(p => p.id !== l.id).length <= SUBS
    // a transformed form can't lead (you only get it by exchanging), unless you picked it yourself
    && (pickIds.has(l.id) || !isFormCard(l))
    // and it can't share a name (either form) with one of your picks: the game allows one card per name
    && (pickIds.has(l.id) || !picks.some(p => clash(p, l))));
  // 1) every leader with itself as friend
  // (a leader that isn't one of your picks must get a leader boost itself, from its own skill or the friend's)
  const leaderOk = lead => pickIds.has(lead.L.id) || coveredBy(lead, lead.L);
  const solo = leaders.map(l => {
    const lead = { L: l, F: l };
    const filled = fillTeam(lead, picks, pool, owned, festival, cl);
    return { lead, ...filled, ...scoreTeam(lead, picks, filled, owned, festival, cl) };
  }).filter(r => leaderOk(r.lead)).sort(compareTeams);
  // 2) the best leaders paired with each other as friend (the friend is borrowed, so any leader can be it), plus
  //    leaders that boost a pick the best ones miss (that pair may be the only way to boost every pick)
  const top = solo.slice(0, PAIR_POOL).map(r => r.lead.L);
  const missed = picks.filter(p => !top.slice(0, 3).some(l => covers(l, p)));
  // (in an event, leaders that last are tried first)
  const byFit = festival ? [...leaders.filter(l => fitsEvent(cl, l)), ...leaders.filter(l => !fitsEvent(cl, l))] : leaders;
  for (const l of byFit) {
    if (top.length >= PAIR_POOL + 6) break;
    if (!top.includes(l) && missed.some(p => covers(l, p))) top.push(l);
  }
  const lockL = lockLeader && leaders.find(l => l.id === lockLeader);
  const mains = lockL ? [lockL] : top;
  const results = [...(lockL ? solo.filter(r => r.lead.L.id === lockLeader) : solo.slice(0, PAIR_POOL))];
  for (const L of mains) for (const F of top) {
    if (F.id === L.id) continue;
    const lead = { L, F };
    if (!leaderOk(lead)) continue;
    const filled = fillTeam(lead, picks, pool, owned, festival, cl);
    results.push({ lead, ...filled, ...scoreTeam(lead, picks, filled, owned, festival, cl) });
  }
  results.sort(compareTeams);
  // 3) keep the best pair per leader, so "other leaders" really are different leaders
  const out = [], usedL = new Set();
  for (const r of results) { if (usedL.has(r.lead.L.id)) continue; usedL.add(r.lead.L.id); out.push(r); }
  if (!lockL) {
    // the solo ranking can list leaders that never got paired: add them, then put everything in the strict order
    for (const r of solo) if (!usedL.has(r.lead.L.id)) { usedL.add(r.lead.L.id); out.push(r); }
  }
  return out.sort(compareTeams);
}

const slim = u => ({ id: u.id, title: u.title, name: u.name, rarity: u.rarity, cls: u.cls, type: u.type, img: u.img });

// stop(): throws when the page has replaced this build with a newer one, so it doesn't keep the fetch queue busy.
async function loadAll(ids, errors, tick, stop, opts = {}) {
  const out = [];
  for (const [i, id] of ids.entries()) {
    stop?.();
    tick?.(i, ids.length);
    try { out.push(await src.unit(id, false, opts)); } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  return out;
}

// Build steps, reported to the page while it waits (opts.progress gets { step, of, label, n, total }).
const STEPS = ['Loading your picks', 'Reading their link partners', 'Loading your box', 'Searching leader categories', 'Loading exchange forms', 'Ranking leaders', 'Arranging the rotation'];

// Attach the other form of every exchange unit (u.xform). A lookup that fails just leaves the unit single-form.
// ---------- real clears (event mode) ----------
// How long a unit takes 0 damage from normal attacks, in phases (a stretch that only starts later counts half).
const zeroReach = sv => {
  const l = sv?.stackedLasts?.normal;
  if (!l) return 0;
  if (l.all) return sv.phases + 1;
  if (l.never) return 0;
  return (l.toEnd ? sv.phases : l.phase) - (l.from ? (l.from - 1) / 2 : 0);
};
const baseIdOf = m => String(m.startsAs && m.exchange ? m.exchange.id : m.id);
// How much of a built team players cleared the event with: each unit's share of the posted clears, and whether this
// exact line-up (any order) was posted.
function provenSummary(cl, tm) {
  const ids = tm.members.map(baseIdOf), fid = baseIdOf(tm.friend);
  const units = ids.map(id => ({ id, n: cl.usage.get(id) || 0 }));
  const key = [...ids].sort().join(',') + '|' + fid;
  const exact = cl.teams.filter(t => [t.leader, ...t.subs].sort().join(',') + '|' + t.friend === key).length;
  const score = units.reduce((a, u) => a + u.n / cl.n, 0) + (cl.usage.get(fid) || 0) / cl.n / 2 + (exact ? 3 : 0);
  return { score: Math.round(score * 100) / 100, inClears: units.filter(u => u.n).length, of: ids.length, exact, total: cl.n,
    top: units.filter(u => u.n).sort((a, b) => b.n - a.n).slice(0, 3)
      .map(u => { const m = tm.members.find(x => baseIdOf(x) === u.id); return { id: u.id, name: m?.startsAs || m?.name || u.id, n: u.n }; }) };
}
// The real cleared teams closest to your picks: line-ups several players posted are grouped; ranked by how many of
// your picks they use, then how many of their units you have, then how often they were posted.
async function provenTeamList(cl, picks, owned, exclude) {
  const groups = new Map();
  for (const t of cl.teams) {
    const key = [t.leader, ...[...t.subs].sort()].join(',') + '|' + t.friend;
    const g = groups.get(key) || { leader: t.leader, subs: t.subs, friend: t.friend, count: 0, last: t.date };
    g.count++;
    if (t.date > g.last) g.last = t.date;
    groups.set(key, g);
  }
  const pickIds = new Set(picks.map(p => String(p.id)));
  const rows = [...groups.values()].map(g => {
    const six = [g.leader, ...g.subs];
    return { ...g, usesPicks: [...pickIds].filter(id => six.includes(id) || g.friend === id).length,
      have: six.filter(id => owned.has(id) && !exclude.has(id)).length };
  }).sort((a, b) => b.usesPicks - a.usesPicks || b.have - a.have || b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  const load = async id => {
    try { const u = await src.unit(id); return { ...slim(u), pick: pickIds.has(id), owned: owned.has(id) }; }
    catch { return { id, name: `card ${id}`, title: '', unknown: true, pick: pickIds.has(id), owned: owned.has(id) }; }
  };
  const teams = [];
  for (const g of rows.slice(0, 5)) {
    teams.push({ count: g.count, last: g.last, usesPicks: g.usesPicks, have: g.have,
      leader: await load(g.leader), subs: await Promise.all(g.subs.map(load)), friend: await load(g.friend) });
  }
  return { event: cl.event, source: cl.source, snapshot: cl.snapshot, total: cl.n, teams };
}

// The turn an exchange becomes possible ("Starting from the 4th turn from the start of battle: ... Reversible Exchange").
function exchangeTurn(u) {
  for (const p of u.passive || [])
    if (p.fx.some(f => /reversible exchange/i.test(f.text))) { const t = p.cond.match(/(\d+)(?:st|nd|rd|th) turn/i); if (t) return Number(t[1]); }
  return null;
}

async function attachForms(units, errors, tick, stop) {
  const todo = units.filter(u => u.exchangeWith && u.xform === undefined);
  for (const [i, u] of todo.entries()) {
    stop?.();
    tick?.(i, todo.length);
    try { u.xform = await src.exchangeForm(u); } catch (e) { u.xform = null; errors.push(`exchange form of ${u.name}: ${e.message}`); }
  }
}

async function build(pickIds, boxIds, festival = false, opts = {}) {
  const errors = [];
  const report = (step, n, total) => opts.progress?.({ step: step + 1, of: STEPS.length, label: STEPS[step], n, total });
  const exclude = new Set((opts.exclude || []).map(String));   // units you said you don't have
  let lockLeader = opts.leader ? String(opts.leader) : null;    // keep this leader (after a swap)
  const warnings = [];
  const stop = () => { if (opts.cancelled?.()) throw Object.assign(new Error('replaced by a newer build'), { status: 499 }); };
  pickIds = [...new Set(pickIds.map(String))].slice(0, MAX_PICKS);
  const pickErrors = [];
  const loaded = await loadAll(pickIds, pickErrors, (n, t) => report(0, n, t), stop, { retryMissing: true });
  errors.push(...pickErrors);
  for (const e of pickErrors) warnings.push(`One of your picks couldn't be loaded (${e}): the team is built without it.`);
  if (!loaded.length) throw Object.assign(new Error(errors.some(e => /not found/.test(e)) ? 'that unit was not found' : 'none of the picked units could be loaded'), { status: 404 });
  // one card per name in a team: keep the first pick of each name and say so
  const picks = [];
  for (const p of loaded) {
    const twin = picks.find(q => q.name === p.name || clash(q, p));
    if (twin) warnings.push(`"${p.title}" and "${twin.title}" are both named ${p.name}: the game allows one per team, so only "${twin.title}" was used.`);
    else picks.push(p);
  }
  const pickSet = new Set(picks.map(p => p.id));
  // A team loaded from a posted clear (opts.mine = the picks you made before loading it): its units sit in the tray
  // so the rules keep them, but only your own picks and your box count as yours for YOUR PICK / OWNED / MISSING.
  const mine = Array.isArray(opts.mine) ? new Set(opts.mine.map(String)) : null;
  const owned = new Set([...boxIds.map(String), ...(mine || pickSet)]);   // your picks count as owned
  // The event (if any) and its real cleared teams, which steer every choice below.
  const evKey = eventOf(opts.event) ? opts.event : (festival && eventOf('festival') ? 'festival' : null);
  const cl = clearsOf(evKey);
  // Candidates that don't load (ids the data site doesn't know) only matter when they're yours: picks and box.
  const quiet = [];

  // Best link partners of every pick (LR/UR real cards), interleaved so each pick gets a fair share.
  const lists = picks.map(p => p.partners.filter(x => !x.transformed && (x.rarity === 'LR' || x.rarity === 'UR')));
  const poolIds = [];
  const cap = festival ? FESTIVAL_POOL_CAP : POOL_CAP;
  for (let i = 0; poolIds.length < cap && lists.some(l => i < l.length); i++)
    for (const l of lists) if (l[i] && !pickSet.has(l[i].id) && !poolIds.includes(l[i].id) && poolIds.length < cap) poolIds.push(l[i].id);
  const partners = await loadAll(poolIds, quiet, (n, t) => report(1, n, t), stop);
  const box = await loadAll(boxIds.map(String).filter(id => !pickSet.has(id)), errors, (n, t) => report(2, n, t), stop);

  const pool = [...partners, ...box.filter(b => !poolIds.includes(b.id))];
  const first = rankLeaders(picks, [...picks, ...pool], pool, owned, festival, null, cl).slice(0, 3);

  // Widen: every LR/UR unit in the top leaders' categories is a candidate (the leader boosts it), ranked by
  // how many links it shares with your picks. Only the best of those are loaded, so a huge category stays cheap.
  const linkCount = new Map();
  for (const p of picks) for (const x of p.partners) linkCount.set(x.id, (linkCount.get(x.id) || 0) + x.shared);
  // Categories to search: the top leaders' categories, plus the categories most of your picks share
  // (that's where leaders covering all of them live, even if none showed up in the link partners).
  const catCount = new Map();
  for (const p of picks) for (const c of p.categories) catCount.set(c, (catCount.get(c) || 0) + 1);
  const shared = [...catCount].filter(([, n]) => n >= Math.max(2, Math.ceil(picks.length / 2)))
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c);
  // (including each leader's "additional" boost categories, e.g. "plus an additional ATK & DEF +50% for Fusion")
  const cats = [...new Set([...first.flatMap(r => [r.lead.L, r.lead.F].flatMap(l => l.leader.parts.flatMap(pt => [...pt.categories, ...(pt.add?.categories || [])]))), ...shared])];
  const have = new Set([...pickSet, ...pool.map(u => u.id)]);
  // Every LR/UR in those categories: links with your picks, how many of the leaders' categories it sits in
  // (more = boosted by more leaders and more team conditions), and page order (category pages list newest first).
  const extra = new Map();
  let order = 0;
  for (const c of cats) {
    stop();
    try {
      for (const m of await src.categoryMembers(c)) {
        if (have.has(m.id) || /^4\d{6}$/.test(m.id) || !(m.rarity === 'LR' || m.rarity === 'UR')) continue;
        const e = extra.get(m.id) || { links: linkCount.get(m.id) || 0, hits: 0, order: order++, lr: m.rarity === 'LR' };
        e.hits++; extra.set(m.id, e);
      }
    }
    catch (e) { errors.push(`category ${c}: ${e.message}`); }
  }
  // Links alone missed strong fits (SSJ4 Goku & Vegeta: 10 links but in 6 of the leaders' categories), so both count.
  const fit = e => e.links + e.hits * 5 + (e.lr ? 5 : 0);
  const extraIds = [...extra].sort((a, b) => fit(b[1]) - fit(a[1]) || a[1].order - b[1].order)
    .slice(0, festival ? 120 : 80).map(([id]) => id);
  // With an event's clear data: every unit at least 3 players cleared with is a candidate too (the leaders' rules
  // still decide whether it fits a team).
  if (cl) {
    const inPool = new Set([...have, ...extraIds]);
    for (const [id, n] of [...cl.usage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
      if (n >= 3 && !inPool.has(id) && !/^4\d{6}$/.test(id)) extraIds.push(id);
  }
  pool.push(...await loadAll(extraIds, quiet, (n, t) => report(3, n, t), stop));
  await attachForms([...picks, ...pool], errors, (n, t) => report(4, n, t), stop);
  report(5);

  // Drop units you said you don't have (your picks always stay).
  // An id of an exchanged form (the page shows units in that form) means the card itself.
  for (const u of [...picks, ...pool]) if (u.xform && exclude.has(u.xform.id)) exclude.add(u.id);
  if (lockLeader && /^4\d{6}$/.test(lockLeader)) {
    const base = [...picks, ...pool].find(u => u.xform?.id === lockLeader);
    if (base) lockLeader = base.id;
  }
  const usable = pool.filter(u => !exclude.has(u.id));
  let lockL = null;
  if (lockLeader && !exclude.has(lockLeader)) {
    lockL = [...picks, ...usable].find(u => u.id === lockLeader);
    if (!lockL) { try { lockL = await src.unit(lockLeader); await attachForms([lockL], errors); } catch (e) { errors.push(`${lockLeader}: ${e.message}`); } }
  }
  const cands = [...picks, ...usable, ...(lockL && !usable.includes(lockL) && !picks.includes(lockL) ? [lockL] : [])];
  let ranked = rankLeaders(picks, cands, usable, owned, festival, null, cl);
  if (lockL) {
    // Keep the leader you were working with on top (a swap shouldn't make the leader jump).
    const kept = rankLeaders(picks, cands, usable, owned, festival, lockL.id, cl)[0];
    // only when that leader really could be kept (no parsed leader skill -> it isn't a leader option at all)
    if (kept && kept.lead.L.id === lockL.id) ranked = [{ ...kept, kept: true }, ...ranked.filter(r => r.lead.L.id !== lockL.id)];
  }
  // A friend kept together with the leader (a team loaded from a posted clear): exactly that pair.
  // The friend is borrowed, so "I don't have it" doesn't apply to it; an exchanged form's id means the card itself.
  let lockFriend = opts.friend ? String(opts.friend) : null;
  if (lockFriend && /^4\d{6}$/.test(lockFriend)) {
    const base = [...picks, ...pool].find(u => u.xform?.id === lockFriend);
    if (base) lockFriend = base.id;
  }
  if (lockL && lockFriend && ranked[0]?.lead.L.id === lockL.id) {
    let F = lockFriend === lockL.id ? lockL : [...picks, ...pool].find(u => u.id === lockFriend);
    if (!F) { try { F = await src.unit(lockFriend); await attachForms([F], errors); } catch (e) { errors.push(`${lockFriend}: ${e.message}`); } }
    if (F?.leader?.parts?.length && !isFormCard(F)) {
      const lead = { L: lockL, F };
      const filled = fillTeam(lead, picks, usable, owned, festival, cl);
      ranked[0] = { lead, ...filled, ...scoreTeam(lead, picks, filled, owned, festival, cl), kept: true, keptFriend: true };
    }
  }
  report(6);
  ranked = ranked.slice(0, 3).map(r => improveFill(r.lead, r, festival, cl));

  // Stacking lines of every form (an exchange unit's other form is named in front of its lines).
  const stackInfo = u => forms(u).flatMap((f, i) => {
    const s = f.stacking || {};
    const pre = i ? `After exchange (${f.name}): ` : '';
    const out = [];
    if (s.saStats?.length) out.push(pre + `Super Attack raises ${s.saStats.join(' & ')} with no turn limit`);
    for (const p of s.passive || []) out.push(pre + p);
    return out;
  });
  const bestCover = Math.max(0, ...ranked.map(r => r.coveredPicks));
  const teams = ranked.map(r => {
    const lead = r.lead;
    const slot = (u, role) => ({ ...slim(u), role, pick: pickSet.has(u.id), mine: mine ? mine.has(u.id) : pickSet.has(u.id), owned: owned.has(u.id), release: u.release,
      covered: coveredBy(lead, u), boost: lBoost(lead, u), fboost: fBoost(lead, u), stacker: stackScore(u) > 0, stack: stackInfo(u),
      // event: does it last (it stacks, or players cleared the event with it)?
      fit: festival ? { ok: fitsEvent(cl, u), stacks: stackScore(u) > 0, clears: clearCount(cl, u) } : null,
      exchange: u.xform ? { ...slim(u.xform), boost: lBoost(lead, u.xform), fboost: fBoost(lead, u.xform), covered: coveredBy(lead, u.xform) } : null });
    const members = [slot(lead.L, 'Leader'), ...r.subs.map(u => slot(u, 'Sub')), ...r.fill.map(u => slot(u, 'Sub'))];
    const friend = slot(lead.F, 'Friend');

    // Missing units get a different owned stand-in each, covered by the same leaders.
    const used = new Set(members.filter(m => m.owned).map(m => m.id));
    const teamUnits = [lead.L, ...r.subs, ...r.fill];
    const altNames = new Set();   // names of the stand-ins already chosen
    for (const m of members) {
      if (m.owned) continue;
      // names taken by the OTHER units (a stand-in may be another card of the missing unit's own character)
      const otherNames = teamUnits.filter(u => u.id !== m.id).reduce(addNames, new Set(altNames));
      const alt = box
        .filter(u => !used.has(u.id) && !takesName(otherNames, u) && !isFormCard(u) && !exclude.has(u.id) && coveredBy(lead, u)
          && (!festival || fitsEvent(cl, u)))   // in an event, only a stand-in that lasts
        .map(u => ({ ...slim(u), links: picks.reduce((a, p) => a + sharedLinks(p, u).length, 0), stacker: stackScore(u) > 0,
          rank: picks.reduce((a, p) => a + sharedLinks(p, u).length, 0) + (festival ? stackScore(u) * 2 : 0) }))
        .sort((a, b) => b.rank - a.rank)[0];
      if (alt) { used.add(alt.id); addNames(altNames, box.find(b => b.id === alt.id) || alt); }
      m.alternative = alt || null;
    }
    const m = arrange(lead, [...r.subs, ...r.fill], festival);
    const all7 = [...members, friend];
    // Picks neither leader skill boosts: only ever shown with a reason (a leader you kept, or no leader covers them all).
    const uncoveredPicks = picks.filter(p => !coveredBy(lead, p)).map(p => p.name);
    // Event: units that may not last (they don't stack and no posted clear used them), each with the reason it's here.
    // The builder adds one only when no unit that lasts boosts all your picks (or fits a slot); your own picks and a
    // leader / friend you kept stay as they are. unfit = how many the builder added (it ranks the teams).
    const fitNotes = [];
    let unfit = 0;
    if (festival) {
      const why = cl ? "doesn't stack and no posted clear used it" : "doesn't stack";
      const said = new Set();
      for (const x of [...members, friend]) {
        if (x.fit.ok) continue;
        if (!x.pick || x.role === 'Friend') unfit++;   // the friend is always added (a copy of your pick too), as in scoreTeam
        if (said.has(x.id)) continue;
        said.add(x.id);
        const who = x.role === 'Leader' && friend.id === x.id ? `${x.name} (leader and friend)` : x.name;
        const kept = (x.role === 'Leader' && r.kept) || (x.role === 'Friend' && r.keptFriend);
        fitNotes.push(x.pick ? `${who}, one of your picks, ${why}: it may not last this event.`
          : kept ? `${who}, kept by you, ${why}: it may not last this event.`
          : x.role === 'Sub' ? `${who} ${why}, so it may not last: no unit that lasts fits this slot.`
          : `${who} ${why}, so it may not last: it's here only because no unit that lasts boosts all your picks.`);
      }
    }
    return {
      kept: !!r.kept,
      uncoveredPicks,
      fitNotes,
      unfit,
      coverNote: !uncoveredPicks.length ? null
        : r.kept ? `Your kept leader ${lead.L.name} doesn't boost ${uncoveredPicks.join(', ')}.${bestCover > r.coveredPicks ? ' Other teams below boost more of your picks.' : ''}`
        : bestCover > r.coveredPicks ? `These leaders don't boost ${uncoveredPicks.join(', ')}: a team above boosts more of your picks.`
        : `No leader found boosts all your picks: ${uncoveredPicks.join(', ')} get no leader boost here.`,
      simNotes: r.simNotes || [],
      leaderSkill: lead.L.leader.text,
      friendSkill: lead.F.id === lead.L.id ? null : lead.F.leader.text,
      coveredPicks: r.coveredPicks,
      picks: picks.length,
      covered: r.covered,
      size: r.size,
      stackers: [lead.L, ...r.subs, ...r.fill].filter(u => stackScore(u) > 0).length,
      members,
      friend,
      // Each leader skill summed over all 7 units (what DokkanStats shows as "Team +X%" under each).
      teamBoostL: all7.reduce((a, x) => a + x.boost, 0),
      teamBoostF: all7.reduce((a, x) => a + x.fboost, 0),
      lowKi: Object.entries(m.stats).filter(([p, s]) => s.lowKi && p !== 'f3').length,
      map: {
        slots: Object.fromEntries(Object.entries(m.slots).filter(([, u]) => u).map(([pos, u]) => [pos, u.id])),
        edges: m.edges,
        stats: m.stats,
      },
      _m: m, _lead: lead, _subs: [...r.subs, ...r.fill],   // used below for the event simulation, removed before sending
      bench: r.bench.map(u => ({ ...slot(u, 'Bench'), links: picks.reduce((a, p) => a + sharedLinks(p, u).length, 0) })),
      // Swap-in choices: your own units these leaders boost first, then the best other fits.
      swaps: (() => {
        const inTeam = new Set([lead.L.id, lead.F.id, ...r.subs.map(u => u.id), ...r.fill.map(u => u.id)]);
        const names = new Set([lead.L, ...r.subs, ...r.fill].map(u => u.name));
        const mine = box.filter(u => !inTeam.has(u.id) && !exclude.has(u.id) && coveredBy(lead, u));
        const seen = new Set();
        return [...mine, ...r.bench].filter(u => !seen.has(u.id) && seen.add(u.id)).slice(0, 24)
          .map(u => ({ ...slot(u, 'Swap'), links: picks.reduce((a, p) => a + sharedLinks(p, u).length, 0), sameName: names.has(u.name) }));
      })(),
    };
  });

  // Event mode: each unit's own DEF picture (how long it takes 0 damage) for the chips and Details, the form to show
  // for exchange units, and how much of the team players actually cleared the event with.
  for (const tm of teams) {
    const m = tm._m, lead = tm._lead;
    delete tm._m; delete tm._lead; delete tm._subs;
    if (!evKey) continue;
    for (const [pos, u] of Object.entries(m.slots)) {
      if (!u) continue;
      const st = tm.map.stats[pos];
      try {
        st.surv = await survival(lead, u, st, evKey, pos);
        if (u.xform && st.ex) st.ex.surv = await survival(lead, u.xform, st.ex, evKey, pos);
      } catch (e) { errors.push(`survival of ${u.name}: ${e.message}`); }
    }
    // an exchange unit is shown in the form that stays at 0 damage clearly longer (the friend copy of your leader follows)
    for (const [pos, u] of Object.entries(m.slots)) {
      const st = tm.map.stats[pos];
      if (!u || pos === 'f3' || !st?.surv || !st.ex?.surv) continue;
      if (zeroReach(st.ex.surv) < zeroReach(st.surv) + 2) continue;
      const mem = tm.members.find(x => x.id === tm.map.slots[pos]);
      if (!mem?.exchange || mem.exchange.covered !== mem.covered) continue;
      const X = mem.exchange, keys = ['id', 'name', 'title', 'rarity', 'cls', 'type', 'img', 'boost', 'fboost', 'covered'];
      const baseSlim = Object.fromEntries(keys.map(k => [k, mem[k]]));
      Object.assign(mem, Object.fromEntries(keys.map(k => [k, X[k]])), { exchange: baseSlim, startsAs: baseSlim.name, exchangeTurn: exchangeTurn(u) });
      tm.map.slots[pos] = X.id;
      const { ex, ...baseSt } = st;
      tm.map.stats[pos] = { ...ex, bestForm: 'shown', startsAs: baseSlim.name, exchangeTurn: exchangeTurn(u),
        ex: { ...baseSt, id: baseSlim.id, name: baseSlim.name, boost: baseSlim.boost, fboost: baseSlim.fboost, covered: baseSlim.covered, stacker: (u.stacking?.score || 0) > 0 } };
      const fr = tm.friend;
      if (pos === 'r1a' && fr && fr.id === baseSlim.id && fr.exchange?.id === X.id) {
        const frBase = Object.fromEntries(keys.map(k => [k, fr[k]]));
        Object.assign(fr, Object.fromEntries(keys.map(k => [k, fr.exchange[k]])), { exchange: frBase, startsAs: frBase.name, exchangeTurn: exchangeTurn(u) });
        tm.map.slots.f3 = X.id;
        const fst = tm.map.stats.f3;
        if (fst?.ex) {
          const { ex: fex, ...fBaseSt } = fst;
          tm.map.stats.f3 = { ...fex, bestForm: 'shown', startsAs: frBase.name, exchangeTurn: exchangeTurn(u),
            ex: { ...fBaseSt, id: frBase.id, name: frBase.name, boost: frBase.boost, fboost: frBase.fboost, covered: frBase.covered } };
        }
      }
    }
    if (cl) tm.proven = provenSummary(cl, tm);
  }
  // With an event: a leader you kept stays first; then the picks the leaders boost; then fewer added units that won't
  // last; then how much of the team players cleared the event with; then the builder's own order (leader skills, links).
  if (evKey) {
    const cov = t => t.members.filter(x => x.pick && (x.startsAs && x.exchange ? x.exchange.covered : x.covered)).length;
    teams.forEach((t, i) => { t._order = i; });
    teams.sort((x, y) => (y.kept - x.kept) || (cov(y) - cov(x)) || (x.unfit - y.unfit) || ((y.proven?.score || 0) - (x.proven?.score || 0)) || (x._order - y._order));
    teams.forEach(t => { delete t._order; });
  }
  const provenTeams = cl ? await provenTeamList(cl, mine ? [...mine].map(id => ({ id })) : picks, owned, exclude) : null;

  return { picks: picks.map(slim), teams, festival, event: evKey, eventName: evKey ? EVENTS[evKey].name : null, proven: provenTeams, hasClears: !!cl,
    boxSize: box.length, errors, warnings, liveRequests: src.stats().liveRequests };
}

// Full unit sheet; with a leader (and friend), also which categories they boost and by how much.
async function details(id, leaderId, friendId) {
  const u = await src.unit(id);
  const L = leaderId ? await src.unit(leaderId) : null;
  const F = friendId ? await src.unit(friendId) : L;
  let xf = null;
  try { xf = await src.exchangeForm(u); } catch {}
  const sa = u.stacking.superAttack || '';
  const dash = sa.indexOf(' - ');
  const boosted = c => [L, F].filter(Boolean).some(x => x.leader.parts.some(p => p.categories.includes(c) || p.add?.categories.includes(c)));
  return {
    ...slim(u), release: u.release,
    leaderSkill: u.leader.text,
    superAttack: { name: dash > -1 ? sa.slice(0, dash) : '', text: dash > -1 ? sa.slice(dash + 3) : sa, stacks: u.stacking.saStats },
    passive: u.passive,
    categories: u.categories,
    boostedCats: L ? u.categories.filter(boosted) : [],
    links: u.linkNames.map((name, i) => ({ name, effect: ((u.linksMax[i] || '').match(/\[(.*)\]/) || [])[1] || '' })),
    stacker: (u.stacking.score || 0) > 0,
    boost: L ? Math.max(0, boostFor(L, u)) : null,
    fboost: F ? Math.max(0, boostFor(F, u)) : null,
    passiveKi: passiveKi(u),
    exchangeWith: u.exchangeWith,
    exchange: xf ? { ...slim(xf), release: xf.release, stacker: (xf.stacking?.score || 0) > 0,
      boost: L ? Math.max(0, boostFor(L, xf)) : null, fboost: F ? Math.max(0, boostFor(F, xf)) : null,
      links: xf.linkNames.filter(n => !u.linkNames.includes(n)), lostLinks: u.linkNames.filter(n => !xf.linkNames.includes(n)) } : null,
  };
}

// What each candidate would get in the slot of `slotId`: leader + friend boost, link ATK/DEF and Ki after re-arranging.
// opts.picks: your picks (they must keep their boost first); opts.exclude: units you said you don't have;
// opts.event: the event (a unit that won't last it is never marked best, and comes after the ones that do).
async function swapPreview(leaderId, subIds, slotId, candIds, boxIds, festival, friendId, opts = {}) {
  const pickIds = new Set((opts.picks || []).map(String)), excluded = new Set((opts.exclude || []).map(String));
  const cl = festival ? clearsOf(opts.event) : null;
  const lasts = c => !festival || fitsEvent(cl, c);
  const L = await src.unit(leaderId);
  const F = friendId ? await src.unit(friendId) : L;
  const lead = { L, F };
  const subs = [];
  for (const id of subIds.slice(0, SUBS)) subs.push(await src.unit(id));   // never more than 5 subs (rotation search is n!)
  await attachForms([L, F, ...subs], []);
  const owned = new Set(boxIds.map(String));
  const out = [];
  // Replacing the leader: each candidate is scored AS the leader (its skill over the whole team), not as a 6th sub.
  if (slotId === leaderId) {
    for (const cid of candIds) {
      let c;
      try { c = await src.unit(cid); await attachForms([c], []); } catch { continue; }
      // not a unit already in the team (Make leader does that), not one you don't have, no name clash
      if (!c.leader.parts?.length || isFormCard(c) || subs.some(s => s.id === c.id || clash(s, c))) continue;
      if (c.id !== L.id && excluded.has(c.id) && !pickIds.has(c.id)) continue;
      const lead2 = { L: c, F: F.id === L.id ? c : F };   // a friend that copied the old leader copies the new one
      const m = arrange(lead2, subs, festival);
      const st = m.stats.r1a;
      const team = [c, ...subs];
      const teamBoost = team.reduce((a, u) => a + boostAvg(lead2, u), 0);
      const stacker = stackScore(c) > 0;
      // units of this team the new leader skills wouldn't boost (they would lose their whole leader boost)
      const uncovered = team.filter(u => !coveredBy(lead2, u)).map(u => u.name);
      const uncoveredPicks = team.filter(u => pickIds.has(u.id) && !coveredBy(lead2, u)).map(u => u.name);
      out.push({ ...slim(c), current: c.id === L.id, owned: owned.has(c.id), stacker, covered: true, uncovered, uncoveredPicks, fits: lasts(c),
        boost: lBoost(lead2, c), fboost: fBoost(lead2, c), atk: st.atk, def: st.def, ki: st.ki, lowKi: !!st.lowKi, exchange: null,
        teamBoost: Math.round(teamBoost),
        score: teamBoost / 2 + st.atk + newness(c) * 4 + (festival && stacker ? 60 : 0) });
    }
    // your picks keeping their boost come first, then (in an event) leaders that last, then the rest of the team's
    // boost, then quality
    out.sort((a, b) => (a.uncoveredPicks.length - b.uncoveredPicks.length) || (b.fits - a.fits) || (a.uncovered.length - b.uncovered.length) || (b.score - a.score));
    const best = out.find(x => !x.current && !x.uncovered.length && x.fits);
    if (best) best.best = true;
    return out;
  }
  for (const cid of candIds) {
    let c;
    try { c = await src.unit(cid); await attachForms([c], []); } catch { continue; }
    const others = subs.filter(s => s.id !== slotId);
    if (isFormCard(c) || [L, ...others].some(s => clash(s, c) || s.id === c.id)) continue;   // same name (either form) can't be on the team twice
    if (c.id !== slotId && excluded.has(c.id) && !pickIds.has(c.id)) continue;               // a unit you said you don't have
    const m = arrange(lead, [...others, c], festival);
    const pos = Object.keys(m.slots).find(p => p !== 'r1a' && p !== 'f3' && m.slots[p]?.id === c.id);
    const st = m.stats[pos] || { atk: 0, def: 0, ki: 0 };
    const stacker = stackScore(c) > 0;
    const lb = lBoost(lead, c), fb = fBoost(lead, c);
    // exchange units: score both forms half and half
    const val = s => s.atk * 2 + s.def + Math.min(s.ki, KI_GOAL) * 3;
    out.push({ ...slim(c), current: c.id === slotId, owned: owned.has(c.id), stacker, covered: coveredBy(lead, c), fits: lasts(c),
      boost: lb, fboost: fb, atk: st.atk, def: st.def, ki: st.ki, lowKi: !!st.lowKi,
      exchange: st.ex ? { name: st.ex.name, atk: st.ex.atk, def: st.ex.def, ki: st.ex.ki, boost: st.ex.boost, fboost: st.ex.fboost } : null,
      score: boostAvg(lead, c) / 2 + (st.ex ? (val(st) + val(st.ex)) / 2 : val(st)) + newness(c) * 4 + (festival && stacker ? 60 : 0) });
  }
  // a unit the leaders boost always ranks above one they don't; then (in an event) units that last
  out.sort((a, b) => (b.covered - a.covered) || (b.fits - a.fits) || (b.score - a.score));
  const best = out.find(x => !x.current && x.covered && x.fits);
  if (best) best.best = true;
  return out;
}

module.exports = { build, details, swapPreview, covers, sharedLinks, boostFor, arrange, teamConds, MAX_PICKS, KI_GOAL,
  // internals, for test/run.js and debugging only
  _t: { survival, defenseKit, hitBars, kitAt, eventOf, attackStackPct, slotCondMet, isFormCard, scoreTeam, zeroReach, provenSummary, proven, clearsOf, compareTeams, fitsEvent, clearCount } };
