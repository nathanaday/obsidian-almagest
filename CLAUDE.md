# obsidian-almagest

The Obsidian plugin of Almagest (id `almagest`), in TypeScript. The binary, the agent
plugin, and the design live in `github.com/nathanaday/almagest`
(`~/projects/software/almagest`); read its `README.md` and `CLAUDE.md` first. This
repository held `obsidian/` of that one until 11.0, when the plugin moved here with its
history, so that Obsidian's community directory reviews a repository that holds the
plugin and nothing else. This file holds what the code and the README do not say.

## Rules

- **Only the community directory installs and updates this plugin.** The directory's
  policies forbid a plugin to install or update itself or its dependencies. So the
  plugin never downloads, installs, or updates the binary, and the binary never writes
  the plugin into a vault. When the binary is missing, the plugin says what to install.
- **The plugin reads the JSON of the CLI.** Every read and write runs the binary:
  `vault --json`, `change apply|reject|start`, `vault trash`, `journal publish`,
  `checkout return`, `wikify start`, `vault snapshot`, `vault migrate`, `config`. That JSON
  and those flags are the contract with the binary; a change on either side is a change
  of both.
- **It never searches `PATH` or the system folders for the binary**, so another
  program's binary never runs in its place. It runs its `binaryPath` setting as given
  when it is set (`findBinary`, `helpers.ts`), else `~/.almagest/bin/almagest`, the link
  to the binary that the agent plugin's launcher installed last. It reads neither
  `ALMAGEST_BIN` nor `ALMAGEST_HOME`.
- **It checks the protocol of the binary at load.** `almagest version --json` prints the
  binary's version and `protocol`, the version of the commands, flags, and JSON that the
  plugin reads (`cli.Protocol` there). The plugin reads the protocols in `PROTOCOLS`;
  `binaryProblem` names the update for a missing binary, an older one, and a newer one.
  Raise the protocol on both sides when a change would make an older plugin misread.
- **It touches only what it owns.** It adds custom views, ribbon buttons, commands,
  in-document widgets (code block processors), and CSS for its own callouts and
  widgets. It patches no pane of Obsidian's own and styles none. A change note's
  `cssclasses` value (`almagest-change`) styles the note itself, so the widget's class
  is `almagest-change-card`.
- **The vault document is `Almagest.md`, or `Atlas.md` before 11.0.** The plugin reads
  the layout from whichever exists (`VAULT_DOCUMENTS`), so in a vault of an earlier
  release it offers the migration and nothing else.
- **Duet hosts the agents when it is on.** Almagest does not copy Duet's code: two copies
  would bind two Yjs hubs to one editor and both wrap `Vault.modify`. The plugin starts
  an agent through Duet's API for other plugins (Duet 0.3.0 or later:
  `app.plugins.getPlugin("duet")?.api`, with `newConversation`, `conversationStatus`, and
  `onTurnEnd`), else in the user's terminal.
- **A terminal launch fails where no one sees it** (osascript and `open` exit after the
  spawn), so `openTerminal` checks for the app first. `scripts/probe-launch.mjs` opens a
  real terminal with a probe; record each result in TESTED.md.

## Build and test

```bash
npm install
npm run build          # dist/main.js, dist/manifest.json, dist/styles.css
npm test               # the unit tests of the pure modules
npm run test:obsidian  # the end-to-end suite in a separate Obsidian
```

The end-to-end suite (`test/obsidian/`, adapted from Duet's harness) builds the binary
from an almagest checkout, by default `../almagest` (set `ALMAGEST_SRC` for another),
makes a vault with `almagest vault init`, copies `dist/` into it as the plugin, and opens
it in a separate Obsidian with a temporary profile. It never touches the user's
Obsidian, `~/.almagest`, or vaults. TESTED.md lists what each test proves.

To try a build in a real vault, copy `dist/main.js`, `dist/manifest.json`, and
`dist/styles.css` into the vault's `.obsidian/plugins/almagest/` and reload Obsidian.
