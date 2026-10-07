# obsidian-almagest

The Obsidian plugin of Almagest (id `almagest`), in TypeScript. The binary, the agent
plugin, and the design live in `github.com/nathanaday/almagest`
(`~/projects/software/almagest`); read its `README.md` and `CLAUDE.md` first. The plugin
has a repository of its own because Obsidian's community directory reviews the whole
repository. This file holds what the code and the README do not say.

## Rules

- **Only the community directory installs and updates this plugin.** The directory's
  policies forbid a plugin to install or update itself or its dependencies. So the
  plugin never downloads, installs, or updates the binary, and the binary never writes
  the plugin into a vault. When the binary is missing, the plugin says what to install.
- **The plugin reads the JSON of the CLI.** Every read and write runs the binary:
  `vault --json`, `change apply|reject|start`, `vault trash`, `journal publish`,
  `checkout return`, `wikify start`, `vault snapshot`, `config`. That JSON
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
- **It touches only what it owns.** It adds one view (the palette) with one ribbon button,
  commands, in-document widgets (code block processors), and CSS for its own callouts and
  widgets. It patches no pane of Obsidian's own. Its one style there is the colors of its
  own top folders in the file explorer (`wiki-view`, `journals`, `ingest`, `tool`), behind
  the `colorFolders` setting, which puts the class `almagest-folder-colors` on the body;
  the end-to-end test checks that its rules reach nothing else, and nothing when it is off. A change note's
  `cssclasses` value (`almagest-change`) styles the note itself, so the widget's class
  is `almagest-change-card`.
- **The plugin acts only in a vault of its layout.** It reads `layout` from
  `Almagest.md` (`LAYOUT`, 8). In a vault of another layout it runs no sync and no
  snapshot, shows one notice, and the palette shows what the vault needs in place of its
  home: for layout 7 (11.0) a Migrate page, whose dry run (`vault migrate --dry-run`)
  counts what moves and whose button runs `vault migrate`; for any other, the update.
  It follows `Almagest.md`'s metadata, so a migration in a terminal clears the notice too.
  `vault migrate` came with protocol 2, so a binary of protocol 1 is named for update.
- **Duet hosts the agents when the user chooses it, and Almagest works without it.**
  Almagest does not copy Duet's code: two copies would bind two Yjs hubs to one editor
  and both wrap `Vault.modify`. With `conversations: "duet"` (the default) and Duet on,
  the plugin starts an agent through Duet's API for other plugins (Duet 0.3.0 or later:
  `app.plugins.getPlugin("duet")?.api`, with `newConversation`, `conversationStatus`, and
  `onTurnEnd`), and Start an agent runs Duet's command `duet:new-chat`, since the API
  needs a first message. Otherwise the agent starts in the user's terminal.
  `recommendDuet` (Duet chosen, not on) decides both tips: the one the plugin draws at
  the top of `Almagest.md` (`duettip.ts`, a state field in live preview and a post
  processor in reading view) and the one a new terminal prints. The tip in `Almagest.md`
  is never written: every agent reads the file as the vault's context, and git shares it
  between machines with and without Duet. Obsidian sends no event when a plugin turns on
  or off, so the plugin reads Duet's state every two seconds and redraws on a change.
- **A terminal launch fails where no one sees it** (osascript and `open` exit after the
  spawn), so `openTerminal` checks for the app first. `scripts/probe-launch.mjs` opens a
  real terminal with a probe; record each result in TESTED.md.

- **The settings are definitions.** `getSettingDefinitions` (Obsidian 1.13, the
  minimum) lists every setting, so Obsidian's settings search finds them. The binary's
  status and the agent preferences come from the binary: the tab reads them when it
  opens and calls `update()` when they arrive. A text field that the binary saves
  (`almagest config set`) saves on blur, not at every key.
- **The palette is a home and pages.** Its home lists the areas (`AREAS`), each with one
  line and a count (`areaLine`, pure and tested); an area's page holds its numbers, its
  actions, and its lists, in the same order on every page. One design language: a chip
  only counts or names a state (accent: the user's to do; warning: a problem; muted: a
  fact); a button only acts (one primary per page; the same small button for each item's
  action; a destructive one quiet, never the loudest); a link only opens a document. A
  disabled button says why in its tooltip and the page's empty state, not in a caption,
  and the palette never repeats the open note's path, which the editor shows.
- **One pane, one ribbon button.** A feature gets a page or an action in the palette, not
  a pane or a ribbon button of its own; a command may run it from the command palette.
- **A view's methods may be Obsidian's.** Obsidian's `View` calls `open(containerEl)`
  when a leaf opens it, so a method named `open` on a view replaces that and breaks the
  view. The palette names its own `show` (a page) and `draw` (the content).
- **It reads only its own folders** (`markdownFilesIn`): the documents, `sessions/`, and
  `changes/`, never the whole vault.

## Build and test

```bash
npm install
npm run build          # dist/main.js, dist/manifest.json, dist/styles.css
npm run lint           # Obsidian's review rules, as the community scan runs them, with no warning allowed
npm test               # the unit tests of the pure modules
npm run test:obsidian  # the end-to-end suite in a separate, hidden Obsidian (OBSIDIAN_SHOW=1 to watch it)
```

The lint has its own install in `scripts/lint` (typescript-eslint needs the TypeScript 5
API; the plugin builds with TypeScript 7). `tsconfig.json` sets
`noUncheckedIndexedAccess`, so an index read is checked rather than asserted.

The end-to-end suite (`test/obsidian/`, adapted from Duet's harness) builds the binary
from an almagest checkout, by default `../almagest` (set `ALMAGEST_SRC` for another),
makes a vault with `almagest vault init`, copies `dist/` into it as the plugin, and opens
it in a separate Obsidian with a temporary profile. It never touches the user's
Obsidian, `~/.almagest`, or vaults. TESTED.md lists what each test proves.

To try a build in a real vault, copy `dist/main.js`, `dist/manifest.json`, and
`dist/styles.css` into the vault's `.obsidian/plugins/almagest/` and reload Obsidian.

## Release

Work happens on `preview`. `main` takes changes only through a pull request from
`preview` whose checks pass (a ruleset on GitHub). To release X.Y.Z:

1. On `preview`, `npm run set-version X.Y.Z`. It sets the version in `manifest.json`,
   `package.json`, and `package-lock.json`, and adds X.Y.Z to `versions.json` with the
   current `minAppVersion`. A unit test holds the four files to one version.
2. Open a pull request into `main`; CI runs the lint, the build, and the unit tests. Run
   `npm run test:obsidian` before you merge: CI has no Obsidian to run it in.
3. Merge it. The release workflow checks the plugin again, tags the commit X.Y.Z (no v),
   and publishes `main.js`, `manifest.json`, and `styles.css`, which Obsidian's community
   plugins download. A merge whose version is released already publishes nothing.

Obsidian reads `manifest.json` from `main`. Until the release job ends, about a minute,
`main` names a version with no release, and an install then fails once.
