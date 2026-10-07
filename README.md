# Almagest for Obsidian

The Obsidian interface of [Almagest](https://github.com/nathanaday/almagest): one Obsidian
vault for the wiki, the sessions, and the changes of your work with coding agents. This
plugin adds a tool palette, the Approve and Cancel widget of each change document, and
quiet snapshots of your edits.

Almagest works without this plugin. The agent plugin for Claude Code or Codex does the
work; this plugin is the interface for it in Obsidian.

## Requirements

- Obsidian 1.13 or later, on the desktop. The agent actions know the macOS terminals
  (Terminal, iTerm2, WezTerm, Ghostty); elsewhere, set a custom terminal command.
- The Almagest agent plugin and its `almagest` binary. Install the agent plugin in
  Claude Code:

  ```bash
  claude plugin marketplace add nathanaday/almagest
  claude plugin install almagest@nathanaday-almagest
  ```

  Its first session installs the binary at `~/.almagest/bin/almagest`. For Codex and
  the details, see the
  [Almagest guide](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#install-and-update).
- A vault that Almagest made (`almagest vault init`, or the `almagest-onboard` skill).

This plugin never downloads, installs, or updates the binary, and never installs or
updates itself: Obsidian's community plugins do that.

## Disclosures

- **A program outside the vault.** The plugin runs the `almagest` binary for every read
  and write: the status it shows, Approve and Cancel, Safe delete, Publish, Return,
  Wikify, and the quiet snapshots. It runs `~/.almagest/bin/almagest`, or the path in its
  settings. It never searches `PATH`. The binary reads and writes the vault and its git
  history, and reads `~/.almagest/config.json`.
- **Files outside the vault.** Through the binary, the plugin reads `~/.almagest/` and the
  repositories that your repository documents link, for their branch and status.
- **Other programs.** Start agent, Ingest, and the other agent actions open your agent
  (Claude Code or Codex) in your terminal, with the command and the terminal in your
  Almagest settings, or in the Duet plugin when Duet is on.
- **Clipboard.** Off macOS, or when no terminal opens, the plugin copies the agent's
  command to the clipboard for you to paste. It never reads the clipboard.
- **Vault files.** The plugin reads the folders Almagest keeps (`tool/source-core/documents/`,
  `tool/sessions/`, and `changes/`) to show the documents, sessions, and changes. It lists
  no other folder.
- **Network.** The plugin makes no network request. The agents you start use their own.
- **Telemetry, accounts, payment.** None.

## What it adds

With the plugin, Obsidian adds:

- **The Almagest palette** in the right sidebar (the Almagest ribbon button, or the command
  "Open the tool palette"). Its home lists the areas of Almagest, each with one line on
  where it stands and a count when something waits for you. Select an area to open its
  page: what it is, its numbers, its actions, and its lists.
  - **Changes**: the changes to review, and the running work documents with their last
    step.
  - **Ingest**: the files in `ingest/`. **Ingest** starts a work document for them, opens
    it, and starts an agent that reports into it.
  - **Wiki health**: **Run wiki lint** lists the first findings, and **Repair with an
    agent** starts a repair work document and an agent that proposes the repairs into it.
    **Sync the vault** writes the views and the statuses again (the command "Sync the
    vault" does the same).
  - **Journals**: each volume, marked "changed" when it has writing to publish.
    **Publish** runs `almagest journal publish`, then starts a work document and an agent
    that absorbs the edition. See [Journals](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#journals).
  - **Library**: **Check out material** asks for your request and starts the librarian.
    It lists the checkouts that are out. **Return** next to one returns it in one click:
    it proposes the edits of the copies as one change, when there are any, and moves the
    checkout to `tool/returned/`, and a notice says how it went. The ledger lists every
    checkout. See
    [Checkouts](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#checkouts).
  - **Agents**: **Start an agent**, the agents Almagest started that still work, and the
    agent sessions of the vault as message threads: the open ones, each with its state
    and its last progress line, then the ones that closed in the last two hours, folded
    away, with **Resume**. A thread opens the session's Duet conversation when it runs in
    one, else the session's document. A session that needs you counts on the home row.
  - **This note**: **Wikify this note** (experimental) copies the open note to
    `scratchpad/`, opens the copy, and starts an agent that marks it (see
    [Wikify a note](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#wikify-a-note-experimental)). **Safe delete this note**
    runs `almagest vault trash` on it. When nothing links it, it moves to `tool/trash/`; a
    topic, a source, or a repository leaves through a change that applies at once, so
    `change undo` in a terminal brings it back, and no agent can undo it. When files link
    it, nothing moves, and a list names the links. For a knowledge document that
    documents link, the list offers **Resolve with an agent**: the agent points each link
    in a document elsewhere and proposes the remove. A link in your own notes (the
    scratchpad, `journals/`, `checkout/`, and the like) is yours to fix; while one stays,
    the agent proposes no remove, and you run Safe delete again after you fix it.

  The setting **Agent conversations** chooses where an agent works: **Duet
  (recommended)**, in a conversation note of the vault through the Duet plugin, or
  **Terminal (configurable)**, in a new terminal with the agent and terminal settings of
  Almagest. Every feature works with either. While Duet is the choice but is not installed
  or not on, agents start in a terminal, the settings name what Duet needs, and a tip
  recommends Duet at the top of `Almagest.md` and in each new terminal. The plugin draws
  the tip in `Almagest.md` and never writes it into the file. Choose Terminal, and the tip
  goes away. Resume of a closed terminal session always opens a terminal.
- **Wikify bubbles** in a wikified copy: Accept, Ignore, Create, and Link on each mark.
- **Approve and Cancel** in each change document. Approve applies the change, as
  `almagest change apply` does in a terminal. Cancel asks for an optional reason
  and rejects the change. After the decision, the document shows the result. A running
  work document shows its kind, its last progress line, and Cancel.
- **Quiet snapshots.** After two minutes with no file change, the plugin commits your
  edits to the vault's git history. Set the period in the Almagest settings; 0 turns it
  off. Every Almagest write also commits your edits first, so you need not commit by hand.
- **The repository panel** in each repository document: the branch, the head, and the
  uncommitted files of the linked repository.
- Colors and icons for the callouts of Almagest documents.
- **Folder colors** in the file explorer: what you read (`wiki-view/`) in cyan, what you
  write and add (`journals/`, `ingest/`) in purple, and what Almagest keeps for itself
  (`tool/`) dimmed. The setting "Color Almagest's folders" turns them off.
- **Migrate an 11.0 vault.** In a vault that keeps `sessions/`, `source-core/`, and
  `trash/` at its root, a notice and the palette offer the migration: the palette shows
  how many files move and change, and **Migrate the vault** runs `almagest vault migrate`,
  which moves them into `tool/` in one commit. See the
  [guide](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#update).
- A sync of the views a few seconds after you edit a note.

## License

MIT. See [LICENSE](LICENSE).
