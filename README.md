# Dokkan Team Builder

A small local app for Dragon Ball Z Dokkan Battle: pick the units you want to play, and it builds the team
around them. It finds the leader, the friend, the subs and the rotation, and for events it shows the teams
real players cleared with.

## What it does

- **Builds a team around your picks.** It chooses the leader skill that boosts every pick first, then the
  subs (links, Ki, stacking, team conditions), then lays out the rotation map.
- **Hard rules come first:** every pick in the team, a leader boost for each of them, one card per name
  (both forms of an exchange unit count), no exchanged-form cards, nothing you marked "I don't have it".
  A team that has to break a rule says so.
- **Your box:** units you own come first, and missing units get a stand-in from your box.
- **Events (Festival of Battles, Meteor Survival):**
  - real cleared teams closest to your picks, with a "Use this team" button;
  - stackers in the open slots;
  - how long each unit takes 0 damage.
- **Details for any unit:** leader skill, Super Attacks, passive, links, exchange form, when it stacks enough
  to give up the first slot.

## Run it

Needs [Node.js](https://nodejs.org/) (no packages to install).

```
node server.js
```

Then open <http://localhost:5177>. On Windows, `start.cmd` does both.

Your box and your saved choices are written next to `server.js` (`box.json`, `state.json`). The desktop app
keeps them in `%LOCALAPPDATA%\DokkanTeamBuilder` instead.

## Desktop app (Windows)

`desktop/` is a small WinForms + WebView2 window that starts the server on a free port and shows the page.
`desktop/build.ps1` publishes it as a single exe next to a bundled `node.exe`, and zips it for sharing
(see `desktop/README-friend.txt`). The ready-made zip is attached to the GitHub releases.

## Tests

```
node test/run.js           # every scenario in every event mode, plus the unit tests
node test/run.js --quick   # a short subset
```

The suite builds real teams for a dozen pick sets and checks the rules on every team, the event data, the
"Use this team" flow and the API edge cases. It exits with code 1 when anything breaks.

## Data and credits

- Unit data: [web-api.eu](https://www.web-api.eu/dokkan/) and [dokkanbattle.net](https://dokkanbattle.net/),
  fetched when needed and cached locally.
- Card art: [DokkanInfo](https://dokkaninfo.com/) assets, proxied and cached locally.
- Event enemies: DokkanInfo event pages (`data/festival-of-battles.json`, `data/meteor-survival.json`).
- Festival of Battles clears: a one-time snapshot of the players' clear board on
  [dokkan.game-db.org](https://dokkan.game-db.org/db/battle_festival/) (`data/festival-of-battles-clears.json`).
  The app never contacts that site.
- Damage and DEF formulas: the [DokkanStats](https://dokkanstats.com/en/guides/) guides.

Dragon Ball Z Dokkan Battle and its art belong to Bandai Namco and their owners. This is an unofficial fan tool.
