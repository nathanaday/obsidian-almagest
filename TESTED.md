# Tested setups

This file records which setups we tested, how, and when. It is not code coverage. Add a
row or change a level each time you test a setup.

## Levels

- **Live**: we ran the full action on a real machine, from Obsidian or the binary, with a
  real agent.
- **Probe**: we opened the real terminal with the real agent command through
  `scripts/probe-launch.mjs`. The probe runs `<agent> --version` in place of a
  session. It proves that the terminal opens, that the login shell finds the command
  (shell functions too), and that the command runs in the vault folder.
- **Unit**: only unit tests check the command that Almagest builds. Nobody opened the
  terminal.
- **None**: not tested.

## Machine of record

| Date       | OS                     | Obsidian | Claude Code | Codex   | Almagest |
| ---------- | ---------------------- | -------- | ----------- | ------- | ----- |
| 2026-10-07 | macOS (Darwin 25.6.0)  | 1.14.4   | 2.1.287     | —       | 11.0 (the end-to-end suite) |

## Start agent: agent × terminal (macOS)

| Agent command                   | Terminal.app | iTerm2 | WezTerm | Ghostty | Custom |
| ------------------------------- | ------------ | ------ | ------- | ------- | ------ |
| `claude`                        | Probe        | Unit   | Probe   | Unit    | Probe  |
| A shell function (`claude-work`) | Probe        | Unit   | Live¹   | Unit    | None   |
| `codex`                         | Probe        | Unit   | Probe   | Unit    | None   |

¹ Start agent from the plugin in a scratch Obsidian, with the vault's command set
through the settings tab, and WezTerm from the global file. A probe stood in for the
session.

The Custom column used WezTerm as the custom program:
`/Applications/WezTerm.app/Contents/MacOS/wezterm start -- /bin/zsh -lic {command}`.

iTerm2 and Ghostty were not installed on the machine of record. When the chosen app is
missing, the plugin shows a notice and copies the command.

Off macOS, the plugin copies the command to the clipboard and opens no terminal. Linux
and Windows: **None**.

## Resume

| Session                                     | Level | Notes                                                    |
| ------------------------------------------- | ----- | -------------------------------------------------------- |
| Claude Code, default account (`~/.claude`)  | Live  | The resume command ran and opened the conversation.      |
| Claude Code, second account (`CLAUDE_CONFIG_DIR`) | Unit | The command is built; nobody ran it.                     |
| Codex                                       | Unit  | `codex resume <id>` is built; nobody ran it.             |

## Obsidian end-to-end tests

Date: 2026-10-07. Obsidian 1.14.4 (the app update, over the 1.8.7 installer), macOS
(Darwin 25.6.0), Go 1.24.2, Node 22.14.0. Almagest for Obsidian, with the almagest
binary built from the checkout beside it.

`npm run test:obsidian` builds the plugin, builds `almagest` from the checkout in
`ALMAGEST_SRC` (default `../almagest`) into a temporary folder, and runs
`test/obsidian/plugin.test.ts`. Each test makes its own vault with `vault init`, with
`ALMAGEST_HOME` in a temporary folder. The harness copies `dist/` into the vault as the
plugin, as the community directory installs it, and sets `binaryPath` to the built
binary. Then it starts a separate Obsidian with a temporary
profile (`--user-data-dir`) and drives it with Playwright over the DevTools protocol.
Obsidian brings itself to the front when its window opens, so the harness hides it at
once, with no throttle on the hidden window: the focus goes back to your app after a
fraction of a second, and you can keep working while the suite runs. `OBSIDIAN_SHOW=1`
leaves the window on screen, to watch a run. The user's Obsidian, `~/.almagest`, and vaults stay as they are. `npm test` does not need
Obsidian. The suite takes about 95 seconds, and has 23 tests.

| Test | What it proves |
| ---- | -------------- |
| Loads in a vault | The plugin loads with the version of `manifest.json` and no console error. A manual sync runs the binary and shows its notice. With every folder open, no element in the file explorer has an `almagest-` class or a `data-almagest` attribute. The rules of the plugin's `styles.css` reach only the rows of `ingest`, `journals`, `tool`, and `wiki-view`, whose computed colors are `--color-purple`, `--color-purple`, `--text-faint`, and `--color-cyan`. With `colorFolders` off, no rule reaches the explorer, and the rows keep Obsidian's colors. |
| Settings from definitions | The settings open at the plugin's tab (a separate window in Obsidian 1.14) and show the binary's status, the snapshot and views settings, and the groups "All vaults" and "This vault". "Custom terminal command" is hidden. Choosing Custom as the terminal for all vaults saves `terminal: custom` through the binary (`almagest config`), and the custom command field appears. |
| A binary it cannot run | With `binaryPath` set to a missing file, the plugin shows one notice that says it cannot run the binary and how to install the agent plugin (`claude plugin install almagest@nathanaday-almagest`), and logs no error. |
| Reads the layout at Obsidian's start | Obsidian quits and starts again with its metadata index deleted, so the plugin loads at start, as it does for a user. It shows no notice and logs no error. |
| Another layout | The same start in a vault whose `Almagest.md` records `layout: 9`. The plugin shows one notice: the vault's layout, the one it reads, and the updates to make. |
| The layout of 11.0 | The same start with `layout: 7`. The plugin shows one notice, which offers the migration in the palette. |
| Migrate from the palette | A vault as 11.0 left it: `sessions/` (with a session) and `source-core/` at the root, `layout: 7`, the old Sessions Base filter and `app.json` paths, and a scratchpad note that links the session by path. The notice offers the migration. The palette shows the Migrate page in place of its home: "2" files move, "4" files change. Migrate the vault moves the session into `tool/sessions/`, removes `sessions/`, points the note's link into `tool/`, sets `layout: 8`, and commits "layout: move sessions/, source-core/, and trash/ into tool/". The palette then shows its home, the notice of the migration replaces the first, and no error is logged. |
| Approves a change | `change propose` from the CLI writes a change document. In live preview, the widget shows Approve and Cancel. A click on Approve writes the topic file, sets `status: applied`, and commits `change: Add Alpha`. The widget then shows "Applied <time>." with no buttons. |
| Cancels a change | In reading view, Cancel opens the modal. The reason typed there goes into `reason`, the status becomes `rejected`, and no topic file is written. The widget shows "Rejected: <reason>". |
| Quiet snapshots | With `snapshotQuietSeconds: 2`, a note is created and then changed through `app.vault`. One second after each edit, git holds no snapshot, so each edit starts the quiet period again. Then one commit "snapshot: N files edited by hand" holds the last text, and the tree is clean. In some runs the `vault sync --views` that the same edit starts holds the lock; the snapshot then runs again after the next quiet period, as designed. |
| Opens the palette | The plugin's one ribbon button is "Almagest": no ribbon button syncs, opens sessions, or opens a tag navigator. The command "Open the tool palette" opens the palette in the right sidebar, at its home. With two files in `ingest/`, the home's Ingest row says "2 files waiting" with the chip "2", and Changes says "Nothing to review" with no chip. The Ingest page lists both files, counts them in a tile, and its button says "Ingest 2 files". The This note page counts "0" files in trash. The status bar holds no Almagest item. |
| Ingest without Duet | The terminal setting is `custom`, with a command that writes the command it gets to a file, so no terminal opens. Ingest runs `change start`: one running work document of kind `ingest` with the file in `files`. Obsidian opens that document. The notice says that Duet runs the agents in Obsidian. The command is `cd '<vault>' && claude '<message>'`, with the ingest message that names the document's title and id. The home's Changes row says "1 running", and the Changes page links the work document. |
| Ingest through Duet's API | A stand-in for Duet's API (version 1) records each call. Ingest calls `newConversation` once, with the ingest message, the title "Agent · <document title>", and `loadUserSetup: true`, and shows no notice about Duet. The home's Agents row says "1 working", and the Agents page lists the conversation, with the chip "ingest"; the end of its turn takes it off. |
| Agent sessions | Two session documents: one `waiting` with no process, updated 2 minutes ago, with a `## Progress` list; one `ended` 20 minutes ago. The home's Agents row says "1 needs you · 1 live session" with an accent chip "1". The Agents page counts "1" in the tile "needs you". The waiting session shows its description with plain links ("Plan the Alpha study"), the chip "needs you", "2 min ago · <its last progress line>", and no button. The ended one shows "ended 20 min ago" and Resume; with no saved conversation, Resume says so in a notice and runs nothing. The title opens the session document. |
| Sync from the palette | With `wiki-view/View · Home.md` deleted, Sync the vault on the Wiki health page writes it again and shows the sync's notice. |
| Running work document | `change start --kind repair` from the CLI. In live preview, the widget shows Running, the kind, "The agent starts.", and Cancel only. The note has the cssclass `almagest-change`, and the lead callout is hidden. After two `change progress` calls, the widget shows the last one with its time. Cancel with no reason sets `status: rejected` and `reason: cancelled in Obsidian`, and the widget shows the result. |
| Safe delete, no backlinks | Safe delete of the open `scratchpad/` note moves it to `tool/trash/<date>/scratchpad/`, in the commit `trash: <path>`. The This note page shows no file path (the editor names the note). The notice names both paths, and the page's tile counts "1" file in trash. |
| Safe delete, backlinks | A topic that another topic and a scratchpad note link stays where it is, and no `tool/trash/` folder appears. The modal "Beta stays" says "2 files link" and lists both; the note is marked "yours to fix", and a line says links in your own notes are yours. "Resolve with an agent" (Duet absent) starts the agent in the terminal stand-in with the wiki-edit message, which names the topic, its path, and `[[Alpha]]`, names `[[Plan]]` as the user's, and says to propose no remove. |
| Publish a journal volume | The terminal stand-in of Ingest without Duet. With `journals/cs566-notes/Week 1.md`, the home's Journals row says "1 to publish". The Journals page shows "CS566 Notes" with the chip "changed", "1 note · never published", an enabled Publish, and the tile "to publish" at 1. Publish opens a modal that names "User Journal CS566 Notes - <today> Edition". Its Publish writes that source in `source-core/documents/` (`origin: journal`, `volume`, `locator`, `status: pending`) in the commit `capture: <title>`, and `Journal · cs566-notes.md`, which opens with the `[!almagest]` callout. It starts the work document "<date> Ingest <title>" of kind `ingest`, opens it, and sends the wiki-sync message that names the edition and the work document. The volume then shows "1 note · last edition <title>", Publish is off with "No change since <title>.", and the tile is at 0. In reading view the history's callout has the plugin's icon. A change to the note turns Publish on again. The command "Publish this journal volume" in that note opens the modal, which says the edition takes a number, and publishes "<title> (2)" with its own work document and message. |
| Publish needs a note | A volume with no note shows "0 notes · never published" and a Publish that is off with "The volume holds no note.". The command "Publish this journal volume" is not available in a note outside `journals/`. |
| Checkout and Return | Three topics (Alpha links Beta and Gamma), and `checkout make` from the CLI with Beta and Alpha. The home's Library row says "1 checkout". The Library page shows the request, "<date> · 2 documents · 0 edited", a Return that is off with "No copy is edited.", and the tile "to return" at 0. The request opens the reading list, `Checkout · <folder>.md`. In reading view, the reading list and a copy open with the `[!almagest]` callout and the plugin's icon. An edit of the Alpha copy through `app.vault.modify` turns Return on after the palette reads the status again: "1 edited", and the tile at 1. Return proposes one change, "<date> Return <folder>", opens it, and shows no notice of left-out copies. The checkout then shows "returned <date>", Return is off with "Returned <date>.", the tile is at 0, and the reading list has `returned`. Approve in the change's widget applies it: Alpha holds the added line, its links name `[[Beta]]` and `[[Gamma]]` with no copy, and the commit is `change: Return <folder>`. |
| Checkout without Duet | With no checkout, the home's Library row says "Gather the pages on a subject", and the Library page says "No checkout yet.". Check out material opens the modal "Check out material", whose Check out button is off while the request is empty or only spaces. Enter in the request field closes the modal and starts the agent in the terminal stand-in with `/almagest:wiki-checkout Check out the material on: reinforcement learning`. The notice says that Duet runs the agents in Obsidian. |
| Wikify: bubbles, Accept, Ignore | Two topics from the CLI, then `wikify start notes/Lecture.md` and `wikify mark` with a marks file: two link marks and two new marks. A note that is no wikified copy (`scratchpad/Plain.md`) shows a mark's text as text. In live preview the copy shows four bubbles, each with its phrase, the pill (`→ Title` or `+ Title`), and Accept and Ignore, or Create and Ignore; a mark in a code span stays text, and a bubble is no taller than the line. The cursor inside a mark shows the mark's text, and the bubble comes back when the cursor leaves. Accept writes `[[Learning Rate Schedule\|learning rate]]` through the editor, and undo takes it back. Ignore writes the phrase. In reading view the two marks left show as bubbles, the code span stays text, Accept writes `[[Gradient Descent]]` (the phrase is the title in another case) through the vault, and Ignore writes the phrase. The original note stays as it was. |
| Wikify: accept every link mark | The command "Accept every link mark in this note" is not available in the original note. In the copy, in live preview, it accepts both link marks in one editor transaction, leaves the new marks and the code span, and says "accepted 2 link marks"; one undo takes both back. In reading view it writes the file; a second run says the note holds no link mark. |
| Wikify: a link mark whose document is gone | A link mark to "Gone Topic", which no note holds, shows the state `gone`, "no note" with the title "No note is titled Gone Topic now.", and Ignore only. The bulk Accept accepts the two other link marks, leaves this one, and says "accepted 2 link marks. 1 names no note now; Ignore it or fix the title." Ignore turns it into its phrase. |
| Wikify: Create and Link | The terminal stand-in of Ingest without Duet. Create on the new mark "Momentum" starts the work document "<date> Draft Momentum" of kind `draft` and sends the wiki-edit draft message, which names `[[Lecture · wikified]]` and the work document. The bubble shows "drafting" and only Ignore, while the other new mark still offers Create. It still shows "drafting" after `change propose --id` into the work document. After `change apply`, the bubble offers Link and Ignore, and Link writes `[[Momentum]]`. |
| Wikify this note | The terminal stand-in. With `Almagest.md` open, "Wikify this note" on the palette's This note page is off with "Wikify takes a note of yours, not Almagest.md.". With `notes/Lecture.md` open, it copies the note to `scratchpad/Lecture · wikified.md` (the original stays), opens the copy, and sends `/almagest:wiki-wikify Wikify [[Lecture · wikified]]: mark what the wiki knows and the subjects worth a topic, with wikify mark.`. |

Found with these tests (harness only, not Almagest): Obsidian ignores SIGTERM for about one
second after it starts, so the harness kills Obsidian when it deletes the profile. It uses
SIGTERM only for a restart, which must keep the profile. A `vault sync --views` that the
plugin started can still write in the vault after Obsidian stops, so the harness retries
the delete of the test folder. The same sync may commit a snapshot after a trash commit,
so the safe delete test reads the commit of the moved path, not the last commit. A large vault (6,000 notes still
in the index queue at load) still gave the right layout notice.

Seen by hand in a scripted Obsidian, not tested: a mark in a callout shows its bubble in
both views. A mark in a table cell broke the table, since the mark's `|` splits the
cell; `wikify mark` now skips table rows, and a Go test covers it.

## How to test a setup

1. Install the plugin's dependencies: `cd obsidian && npm install`. That is enough for the
   probe, which bundles `src/agents.ts` itself. To build the plugin, run `npm run build`
   there, or `make obsidian` at the root, which also copies it into the binary.
2. Run the probe: `node scripts/probe-launch.mjs wezterm claude-work`. The first
   argument is the terminal (`terminal`, `iterm`, `wezterm`, `ghostty`, or `custom`). The
   second is the agent command. For `custom`, the third is the template.
3. The script prints `PASS` or `FAIL`. On `PASS`, change the cell to **Probe** and update
   the machine of record.
4. For **Live**, start a real session from Obsidian with Start agent, and resume it from
   the palette's Agents page.
