# Almagest for Obsidian

The Obsidian interface of [Almagest](https://github.com/nathanaday/almagest): one Obsidian
vault for the wiki, the sessions, and the changes of your work with coding agents. This
plugin adds a tool palette, the Approve and Cancel widget of each change document, a tag
navigator, a sessions pane, and quiet snapshots of your edits.

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
- **Vault files.** The plugin reads the folders Almagest keeps (`source-core/documents/`,
  `sessions/`, and `changes/`) to show the documents, sessions, and changes. It lists no
  other folder.
- **Network.** The plugin makes no network request. The agents you start use their own.
- **Telemetry, accounts, payment.** None.

## What it adds

With the plugin, Obsidian adds:

- **The Almagest palette** in the right sidebar (the Almagest ribbon button, or the command
  "Open the tool palette"). It shows the proposed changes, the running work documents,
  the files in `ingest/`, the pending sources, the live sessions, the files in `trash/`,
  the journal volumes, the checkouts, and the lint problems. Its actions:
  - **Ingest** starts a work document for the files in `ingest/`, opens it, and starts
    an agent that reports into it.
  - **Wiki lint** runs `lint` and lists the first findings. **Repair with an agent**
    starts a repair work document and an agent that proposes the repairs into it.
  - **Safe delete this file** runs `almagest vault trash` on the open file. When
    no file links it, the file moves to `trash/`; a topic, a source, or a repository
    leaves through a change that applies at once, so `change undo` in a terminal brings
    it back; an agent cannot undo it. When files link it, nothing moves, and a list
    names the links. For a knowledge document that documents link, the list offers
    **Resolve with an agent**: the agent points each link in a document elsewhere and
    proposes the remove. A link in your own notes (the scratchpad, `journals/`,
    `checkout/`, `threads/`, and the like) is yours to fix; while one stays, the agent
    proposes no remove, and you run Safe delete again after you fix it.
  - **Publish** next to a journal volume (marked when the volume has changes) runs
    `almagest journal publish`, then starts a work document and an agent that
    absorbs the edition. See [Journals](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#journals).
  - **Checkout** asks for your request and starts an agent that checks out the
    material on it.
  - **Return** next to a checkout runs `almagest checkout return` and opens the
    change. It is on when a copy is edited and the checkout is not returned. See [Checkouts](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#checkouts).
  - **Wikify this note** (experimental) copies the open note to `scratchpad/`, opens
    the copy, and starts an agent that marks it. See [Wikify a note](https://github.com/nathanaday/almagest/blob/main/docs/guide.md#wikify-a-note-experimental).

  The palette starts an agent through the Duet plugin. Without Duet, it starts your
  agent in a terminal (the agent and terminal settings of Almagest) with the same
  message.
- **Wikify bubbles** in a wikified copy: Accept, Ignore, Create, and Link on each mark.
- **Approve and Cancel** in each change document. Approve applies the change, as
  `almagest change apply` does in a terminal. Cancel asks for an optional reason
  and rejects the change. After the decision, the document shows the result. A running
  work document shows its kind, its last progress line, and Cancel.
- **Quiet snapshots.** After two minutes with no file change, the plugin commits your
  edits to the vault's git history. Set the period in the Almagest settings; 0 turns it
  off. Every Almagest write also commits your edits first, so you need not commit by hand.
- **The tag navigator** in the left sidebar (the command "Open the tag navigator"), which narrows the documents one tag at a
  time.
- **The sessions pane** in the right sidebar, with Resume, and the **Start agent**
  command.
- **The repository panel** in each repository document: the branch, the head, and the
  uncommitted files of the linked repository.
- Colors and icons for the callouts of Almagest documents.
- A sync of the views a few seconds after you edit a note.

## License

MIT. See [LICENSE](LICENSE).
