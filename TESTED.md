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
| 2026-10-01 | macOS (Darwin 25.6.0)  | 1.13.7   | 2.1.287     | 0.155.1 | 8.1.1 |
| 2026-10-04 | macOS (Darwin 25.6.0)  | 1.13.7   | 2.1.287     | 0.155.1, 0.160.0 | 8.1.1 at `a623068` |

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
| Claude Code, default account (`~/.claude`)  | Live  | 8.0.2. The resume command ran and opened the conversation. |
| Claude Code, second account (`CLAUDE_CONFIG_DIR`) | Unit | The command is built; nobody ran it.                     |
| Codex                                       | Unit  | `codex resume <id>` is built; nobody ran it.             |

## Obsidian end-to-end tests

Date: 2026-10-07. Obsidian 1.14.4 (the app update, over the 1.8.7 installer), macOS
(Darwin 25.6.0), Go 1.24.2, Node 22.14.0. Almagest for Obsidian 11.0.1, with the
almagest binary of the 11.0.0 release.

`npm run test:obsidian` builds the plugin, builds `almagest` from the checkout in
`ALMAGEST_SRC` (default `../almagest`) into a temporary folder, and runs
`test/obsidian/plugin.test.ts`. Each test makes its own vault with `vault init`, with
`ALMAGEST_HOME` in a temporary folder. The harness copies `dist/` into the vault as the
plugin, as the community directory installs it, and sets `binaryPath` to the built
binary. Then it starts a separate Obsidian with a temporary
profile (`--user-data-dir`) and drives it with Playwright over the DevTools protocol. The
user's Obsidian, `~/.almagest`, and vaults stay as they are. `npm test` does not need
Obsidian. The suite takes about 95 seconds, and has 24 tests.

| Test | What it proves |
| ---- | -------------- |
| Loads in an 11.0 vault | The plugin loads with version 11.0.0 and no console error. A manual sync runs the binary and shows its notice. With every folder open, no element in the file explorer has an `almagest-` class or a `data-almagest` attribute, and no rule of the plugin's `styles.css` matches an element there. |
| Settings from definitions | The settings open at the plugin's tab (a separate window in Obsidian 1.14) and show the binary's status, the snapshot and views settings, and the groups "All vaults" and "This vault". "Custom terminal command" is hidden. Choosing Custom as the terminal for all vaults saves `terminal: custom` through the binary (`almagest config`), and the custom command field appears. |
| A binary it cannot run | With `binaryPath` set to a missing file, the plugin shows one notice that says it cannot run the binary and how to install the agent plugin (`claude plugin install almagest@nathanaday-almagest`), and logs no error. |
| Reads the layout at Obsidian's start, 11.0 | Obsidian quits and starts again with its metadata index deleted, so the plugin loads at start, as it does for a user. It shows no notice and logs no error. |
| Reads the layout at Obsidian's start, 9.0 | The same start in a vault whose vault document is `Atlas.md` with `layout: 5`, as 9.0 left it. The plugin shows one notice, which names the 9.0 layout and the 11.0 layout it needs. |
| Approves a change | `change propose` from the CLI writes a change document. In live preview, the widget shows Approve and Cancel. A click on Approve writes the topic file, sets `status: applied`, and commits `change: Add Alpha`. The widget then shows "Applied <time>." with no buttons. |
| Cancels a change | In reading view, Cancel opens the modal. The reason typed there goes into `reason`, the status becomes `rejected`, and no topic file is written. The widget shows "Rejected: <reason>". |
| Quiet snapshots | With `snapshotQuietSeconds: 2`, a note is created and then changed through `app.vault`. One second after each edit, git holds no snapshot, so each edit starts the quiet period again. Then one commit "snapshot: N files edited by hand" holds the last text, and the tree is clean. In some runs the `vault sync --views` that the same edit starts holds the lock; the snapshot then runs again after the next quiet period, as designed. |
| Offers the migration | In a vault of Atlas 10.0 (`Atlas.md` with `layout: 6`), the notice names the 10.0 layout. "Show the migration" opens the dry run in the modal, which names the rename of `Atlas.md` to `Almagest.md`. Migrate writes `Almagest.md` with `layout: 7`, removes `Atlas.md`, and commits `layout: migrate to 11.0`. |
| Opens the palette | The ribbon has one button named "Almagest". The command "Open the Almagest palette" opens the palette in the right sidebar. With two files in `ingest/`, the Ingest row says "2 files", the list names both files, and the button says "Ingest 2 files". The status bar holds no Almagest item. |
| Ingest without Duet | The terminal setting is `custom`, with a command that writes the command it gets to a file, so no terminal opens. Ingest runs `change start`: one running work document of kind `ingest` with the file in `files`. Obsidian opens that document. The notice says that Duet runs the agents in Obsidian. The command is `cd '<vault>' && claude '<message>'`, with the ingest message that names the document's title and id. The palette lists the running work. |
| Ingest through Duet's API | A stand-in for Duet's API (version 1) records each call. Ingest calls `newConversation` once, with the ingest message, the title "Agent · <document title>", and `loadUserSetup: true`, and shows no notice about Duet. The palette lists the conversation under Running; the end of its turn takes it off. |
| Running work document | `change start --kind repair` from the CLI. In live preview, the widget shows Running, the kind, "The agent starts.", and Cancel only. The note has the cssclass `almagest-change`, and the lead callout is hidden. After two `change progress` calls, the widget shows the last one with its time. Cancel with no reason sets `status: rejected` and `reason: cancelled in Obsidian`, and the widget shows the result. |
| Safe delete, no backlinks | Safe delete of the open `scratchpad/` note moves it to `trash/<date>/scratchpad/`, in the commit `trash: <path>`. The notice names both paths, and the palette's Trash row says "1 file". |
| Safe delete, backlinks | A topic that another topic and a scratchpad note link stays where it is, and no `trash/` folder appears. The modal "Beta stays" says "2 files link" and lists both; the note is marked "yours to fix", and a line says links in your own notes are yours. "Resolve with an agent" (Duet absent) starts the agent in the terminal stand-in with the wiki-edit message, which names the topic, its path, and `[[Alpha]]`, names `[[Plan]]` as the user's, and says to propose no remove. |
| Publish a journal volume | The terminal stand-in of Ingest without Duet. With `journals/cs566-notes/Week 1.md`, the Journals section shows "CS566 Notes", "1 note", "Never published", the mark "changed", and an enabled Publish; the Journals row says "1 to publish". Publish opens a modal that names "User Journal CS566 Notes - <today> Edition". Its Publish writes that source in `source-core/documents/` (`origin: journal`, `volume`, `locator`, `status: pending`) in the commit `capture: <title>`, and `Journal · cs566-notes.md`, which opens with the `[!almagest]` callout. It starts the work document "<date> Ingest <title>" of kind `ingest`, opens it, and sends the wiki-sync message that names the edition and the work document. The volume then shows its edition, Publish is off with "No change since <title>.", and the row says "0 to publish". In reading view the history's callout has the plugin's icon. A change to the note turns Publish on again. The command "Publish this journal volume" in that note opens the modal, which says the edition takes a number, and publishes "<title> (2)" with its own work document and message. |
| Publish needs a note | A volume with no note shows "0 notes" and a Publish that is off with "The volume holds no note.". The command "Publish this journal volume" is not available in a note outside `journals/`. |
| Checkout and Return | Three topics (Alpha links Beta and Gamma), and `checkout make` from the CLI with Beta and Alpha. The Checkouts section shows the request, "2 documents", "<date> · 0 edited", and a Return that is off with "No copy is edited."; the Checkouts row says "0 to return". The request opens the reading list, `Checkout · <folder>.md`. In reading view, the reading list and a copy open with the `[!almagest]` callout and the plugin's icon. An edit of the Alpha copy through `app.vault.modify` turns Return on after the palette reads the status again: "1 edited", "1 to return". Return proposes one change, "<date> Return <folder>", opens it, and shows no notice of left-out copies. The checkout then shows "returned <date>", Return is off with "Returned <date>.", the row says "0 to return", and the reading list has `returned`. Approve in the change's widget applies it: Alpha holds the added line, its links name `[[Beta]]` and `[[Gamma]]` with no copy, and the commit is `change: Return <folder>`. |
| Checkout without Duet | With no checkout, the Checkouts section says "No checkout yet". Checkout opens the modal "Check out material", whose Check out button is off while the request is empty or only spaces. Enter in the request field closes the modal and starts the agent in the terminal stand-in with `/almagest:wiki-checkout Check out the material on: reinforcement learning`. The notice says that Duet runs the agents in Obsidian. |
| Wikify: bubbles, Accept, Ignore | Two topics from the CLI, then `wikify start notes/Lecture.md` and `wikify mark` with a marks file: two link marks and two new marks. A note that is no wikified copy (`scratchpad/Plain.md`) shows a mark's text as text. In live preview the copy shows four bubbles, each with its phrase, the pill (`→ Title` or `+ Title`), and Accept and Ignore, or Create and Ignore; a mark in a code span stays text, and a bubble is no taller than the line. The cursor inside a mark shows the mark's text, and the bubble comes back when the cursor leaves. Accept writes `[[Learning Rate Schedule\|learning rate]]` through the editor, and undo takes it back. Ignore writes the phrase. In reading view the two marks left show as bubbles, the code span stays text, Accept writes `[[Gradient Descent]]` (the phrase is the title in another case) through the vault, and Ignore writes the phrase. The original note stays as it was. |
| Wikify: accept every link mark | The command "Accept every link mark in this note" is not available in the original note. In the copy, in live preview, it accepts both link marks in one editor transaction, leaves the new marks and the code span, and says "accepted 2 link marks"; one undo takes both back. In reading view it writes the file; a second run says the note holds no link mark. |
| Wikify: a link mark whose document is gone | A link mark to "Gone Topic", which no note holds, shows the state `gone`, "no note" with the title "No note is titled Gone Topic now.", and Ignore only. The bulk Accept accepts the two other link marks, leaves this one, and says "accepted 2 link marks. 1 names no note now; Ignore it or fix the title." Ignore turns it into its phrase. |
| Wikify: Create and Link | The terminal stand-in of Ingest without Duet. Create on the new mark "Momentum" starts the work document "<date> Draft Momentum" of kind `draft` and sends the wiki-edit draft message, which names `[[Lecture · wikified]]` and the work document. The bubble shows "drafting" and only Ignore, while the other new mark still offers Create. It still shows "drafting" after `change propose --id` into the work document. After `change apply`, the bubble offers Link and Ignore, and Link writes `[[Momentum]]`. |
| Wikify this note | The terminal stand-in. With `Almagest.md` open, the palette's "Wikify this note" is off with "Wikify takes a note of yours, not Almagest.md.". With `notes/Lecture.md` open, it copies the note to `scratchpad/Lecture · wikified.md` (the original stays), opens the copy, and sends `/almagest:wiki-wikify Wikify [[Lecture · wikified]]: mark what the wiki knows and the subjects worth a topic, with wikify mark.`. |

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
   the sessions pane.
