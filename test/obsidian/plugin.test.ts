import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AtlasBinary, buildAtlas, frontmatter, launchObsidian, type ObsidianInstance, until } from "./harness";

const TIMEOUT = 90_000;

describe("Atlas in Obsidian", () => {
	let bin: AtlasBinary;
	let obsidian: ObsidianInstance | undefined;

	beforeAll(async () => {
		bin = await buildAtlas();
	}, 120_000);

	afterAll(async () => {
		await bin?.remove();
	});

	afterEach(async () => {
		await obsidian?.close();
		obsidian = undefined;
	});

	async function launch(options?: Parameters<typeof launchObsidian>[1]): Promise<ObsidianInstance> {
		obsidian = await launchObsidian(bin, options);
		return obsidian;
	}

	/** Writes a plan and proposes it with the CLI; returns the change's id and document. */
	async function propose(o: ObsidianInstance, title: string, topic: string): Promise<{ id: string; note: string; topicPath: string }> {
		const plan = path.join(o.vault, "..", `${title}.json`);
		await writeFile(
			plan,
			JSON.stringify({
				title,
				writes: [
					{ op: "create", type: "topic", kind: "concept", title: topic, fields: { description: `The ${topic} test topic.` }, body: `## Definition\n\n${topic} is a test topic.\n` },
				],
			}),
		);
		const out = JSON.parse(await o.atlas(["change", "propose", plan, "--json"]));
		expect(out.status).toBe("proposed");
		return { id: out.ref.id, note: out.ref.path, topicPath: out.writes[0].path };
	}

	/** Opens a note once Obsidian knows the file, in live preview or in reading view. */
	async function open(o: ObsidianInstance, note: string, mode: "source" | "preview"): Promise<void> {
		await until(`Obsidian to see ${note}`, () => o.page.evaluate((file) => !!(window as any).app.vault.getFileByPath(file), note));
		await o.page.evaluate(
			async ({ file, mode }) => {
				const app = (window as any).app;
				const leaf = app.workspace.getLeaf(false);
				await leaf.openFile(app.vault.getFileByPath(file), { state: { mode, source: false } });
			},
			{ file: note, mode },
		);
	}

	async function status(o: ObsidianInstance, note: string): Promise<Record<string, string>> {
		return frontmatter(await o.read(note));
	}

	/** The texts of the notices that show now. */
	function notices(o: ObsidianInstance): Promise<string[]> {
		return o.page.$$eval(".notice", (els) => els.map((e) => e.textContent ?? ""));
	}

	it("loads in a 10.0 vault with no console error, and adds nothing to the file explorer", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		expect(await o.page.evaluate(() => (window as any).app.plugins.plugins.atlas.manifest.version)).toBe("10.1.0");

		// A topic and a change document: the files that 9.0 marked in the explorer.
		const change = await propose(o, "Add Alpha", "Alpha");
		await o.atlas(["change", "apply", change.id, "--json"]);

		// A manual sync runs the binary through the plugin; its notice tells that it ended.
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("atlas:sync"));
		await until("the sync notice", async () => (await notices(o)).some((t) => /^Atlas: (Synced .+|Generated files are up to date)\.$/.test(t)), {
			describe: async () => `notices: ${JSON.stringify(await notices(o))}`,
		});

		// Open every folder, so the explorer draws every note of the vault.
		await o.page.evaluate(async () => {
			const app = (window as any).app;
			const leaf = app.workspace.getLeavesOfType("file-explorer")[0];
			await app.workspace.revealLeaf(leaf);
			for (const item of Object.values<any>(leaf.view.fileItems)) item.setCollapsed?.(false);
		});
		const notes = await until(
			"the explorer to show every note",
			() =>
				o.page.evaluate(() => {
					const app = (window as any).app;
					const root: HTMLElement = app.workspace.getLeavesOfType("file-explorer")[0].view.containerEl;
					const paths: string[] = app.vault.getMarkdownFiles().map((f: any) => f.path);
					return paths.every((p) => root.querySelector(`.nav-file-title[data-path="${CSS.escape(p)}"]`)) && paths.length;
				}),
			{ describe: () => o.page.evaluate(() => (window as any).app.workspace.getLeavesOfType("file-explorer")[0].view.containerEl.innerText) },
		);
		expect(notes).toBeGreaterThanOrEqual(7);

		const explorer = await o.page.evaluate(async () => {
			const app = (window as any).app;
			const root: HTMLElement = app.workspace.getLeavesOfType("file-explorer")[0].view.containerEl;
			const elements = [root, ...root.querySelectorAll<HTMLElement>("*")];
			const marked = elements
				.filter((el) => [...el.classList].some((c) => c.startsWith("atlas-")) || [...el.attributes].some((a) => a.name.startsWith("data-atlas")))
				.map((el) => el.outerHTML.slice(0, 160));

			// The plugin's styles.css, as Obsidian put it in the page.
			const plugin = app.plugins.plugins.atlas;
			const css: string = await app.vault.adapter.read(`${plugin.manifest.dir}/styles.css`);
			const sheet = [...document.querySelectorAll("style")].find((el) => el.textContent === css)?.sheet;
			const rules: string[] = [];
			const walk = (list: CSSRuleList) => {
				for (const rule of list) {
					if (rule instanceof CSSStyleRule) rules.push(rule.selectorText);
					else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
				}
			};
			if (sheet) walk(sheet.cssRules);
			const styled = rules.filter((selector) => {
				const plain = selector.replace(/::?(before|after|placeholder|marker|selection|-webkit-[\w-]+)/g, "");
				return elements.some((el) => {
					try {
						return el.matches(plain);
					} catch {
						return false;
					}
				});
			});
			return { marked, sheet: !!sheet, rules: rules.length, styled };
		});
		expect(explorer.marked).toEqual([]);
		expect(explorer.sheet).toBe(true);
		expect(explorer.rules).toBeGreaterThan(10);
		expect(explorer.styled).toEqual([]);
		expect(o.errors).toEqual([]);
	});

	/** Sets the layout that Atlas.md records. */
	const layout = (n: number) => async (vault: string) => {
		const atlas = path.join(vault, "Atlas.md");
		await writeFile(atlas, (await readFile(atlas, "utf8")).replace(/^layout: \d+$/m, `layout: ${n}`));
	};

	/** Waits until Obsidian has read every file into its metadata cache. */
	function indexed(o: ObsidianInstance): Promise<unknown> {
		return o.page.waitForFunction(() => (window as any).app.metadataCache.inProgressTaskCount === 0, undefined, { timeout: 10_000 });
	}

	describe("reads the layout when it loads at Obsidian's start in a vault Obsidian has not indexed", () => {
		it("10.0: no notice", { timeout: TIMEOUT }, async () => {
			const o = await launch();
			await o.restart({ freshIndex: true });
			await indexed(o);
			expect(await notices(o)).toEqual([]);
			expect(o.errors).toEqual([]);
		});

		it("9.0: the migration notice", { timeout: TIMEOUT }, async () => {
			const o = await launch({ prepare: layout(5) });
			await o.restart({ freshIndex: true });
			await indexed(o);
			expect(await notices(o)).toEqual(["Atlas: this vault has the 9.0 layout. This plugin needs the 10.0 layout.Show the migration"]);
			expect(o.errors).toEqual([]);
		});
	});

	it("approves a change from its widget", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const change = await propose(o, "Add Alpha", "Alpha");
		await open(o, change.note, "source");

		const widget = o.page.locator(".atlas-change-card");
		await widget.locator("button", { hasText: "Approve" }).waitFor({ timeout: 10_000 });
		expect(await widget.getAttribute("data-state")).toBe("proposed");
		expect(await widget.locator("button", { hasText: "Cancel" }).isVisible()).toBe(true);

		await widget.locator("button", { hasText: "Approve" }).click();
		await until("the topic file", () => existsSync(path.join(o.vault, change.topicPath)));
		await until("status: applied", async () => (await status(o, change.note)).status === "applied", {
			describe: () => o.read(change.note),
		});
		await until("the widget to show the result", async () => (await widget.getAttribute("data-state")) === "applied", {
			describe: async () => `widget: ${await widget.innerHTML()}`,
		});
		expect(await widget.locator(".atlas-change-line").textContent()).toMatch(/^Applied \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
		expect(await widget.locator("button").count()).toBe(0);
		expect(await o.git(["log", "-1", "--format=%s"])).toBe("change: Add Alpha\n");
		expect(o.errors).toEqual([]);
	});

	it("cancels a change from its widget, with a reason", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const change = await propose(o, "Add Beta", "Beta");
		await open(o, change.note, "preview");

		const widget = o.page.locator(".markdown-reading-view .atlas-change-card");
		await widget.locator("button", { hasText: "Cancel" }).click({ timeout: 10_000 });
		const modal = o.page.locator(".modal", { hasText: "Cancel this change" });
		await modal.locator("input.atlas-reason-input").fill("Not needed now");
		await modal.locator("button", { hasText: "Cancel the change" }).click();

		await until("status: rejected", async () => (await status(o, change.note)).status === "rejected", {
			describe: () => o.read(change.note),
		});
		expect((await status(o, change.note)).reason).toBe("Not needed now");
		expect(existsSync(path.join(o.vault, change.topicPath))).toBe(false);
		await until("the widget to show the reason", async () => (await widget.getAttribute("data-state")) === "rejected", {
			describe: async () => `widget: ${await widget.innerHTML()}`,
		});
		expect(await widget.locator(".atlas-change-line").textContent()).toBe("Rejected: Not needed now");
		expect(o.errors).toEqual([]);
	});

	it("commits hand edits as one snapshot after the quiet period", { timeout: TIMEOUT }, async () => {
		const o = await launch({ pluginData: { snapshotQuietSeconds: 2 } });
		const note = "scratchpad/Hand edit.md";
		const snapshots = async () => (await o.git(["log", "--format=%H %s", "--", note])).split("\n").filter((line) => / snapshot: \d+ files? edited by hand$/.test(line));

		// Each edit starts the 2-second quiet period again: one second after each edit, nothing is committed yet.
		await o.page.evaluate(async (file) => {
			await (window as any).app.vault.create(file, "First line.\n");
		}, note);
		await o.page.waitForTimeout(1000);
		expect(await snapshots()).toEqual([]);
		await o.page.evaluate(async (file) => {
			const app = (window as any).app;
			await app.vault.modify(app.vault.getFileByPath(file), "First line.\nSecond line.\n");
		}, note);
		await o.page.waitForTimeout(1000);
		expect(await snapshots()).toEqual([]);

		const [commit] = await until("a snapshot commit that holds the note", async () => ((await snapshots()).length > 0 ? snapshots() : undefined), {
			describe: () => o.git(["log", "--stat", "-5"]),
		});
		expect(await o.git(["show", `${commit!.split(" ")[0]}:${note}`])).toBe("First line.\nSecond line.\n");
		expect(await snapshots()).toHaveLength(1);
		await until("a clean tree", async () => (await o.git(["status", "--porcelain"])) === "", {
			describe: () => o.git(["status", "--porcelain"]),
		});
		expect(o.errors).toEqual([]);
	});

	it("offers the migration in a vault with the 9.0 layout", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: layout(5) });
		const notice = o.page.locator(".notice", { hasText: "this vault has the 9.0 layout" });
		await notice.waitFor({ timeout: 10_000 });
		expect(await notice.textContent()).toContain("This plugin needs the 10.0 layout.");

		await notice.locator("button", { hasText: "Show the migration" }).click();
		const modal = o.page.locator(".modal", { hasText: "Migrate to the 10.0 layout" });
		await modal.waitFor({ timeout: 10_000 });
		expect(await modal.textContent()).toContain("from the 9.0 layout to the 10.0 layout in one commit");

		await modal.locator("button", { hasText: "Migrate" }).click();
		await until("layout: 6", async () => frontmatter(await o.read("Atlas.md")).layout === "6", { describe: () => o.read("Atlas.md") });
		await until("the migration commit", async () => (await o.git(["log", "-1", "--format=%s"])).startsWith("layout: migrate to 10.0"), {
			describe: () => o.git(["log", "--oneline", "-3"]),
		});
		expect(o.errors).toEqual([]);
	});

	/** Opens the palette from its command and waits for its first status. */
	async function openPalette(o: ObsidianInstance) {
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("atlas:open-palette"));
		const palette = o.page.locator(".atlas-palette");
		await until("the palette's status", async () => (await palette.locator('[data-row="ingest"]').count()) > 0, {
			describe: async () => `palette: ${(await palette.count()) ? await palette.innerText() : "none"}`,
		});
		return palette;
	}

	/** The palette's value in a status row. */
	function row(palette: ReturnType<ObsidianInstance["page"]["locator"]>, name: string): Promise<string | null> {
		return palette.locator(`[data-row="${name}"] .atlas-palette-value`).textContent();
	}

	/** Points the agent's terminal at a command that writes what it would run to a file, so no terminal opens. */
	async function stubTerminal(o: ObsidianInstance): Promise<string> {
		const out = path.join(o.vault, "..", "terminal.txt");
		await o.atlas(["config", "set", "terminal", "custom"]);
		await o.atlas(["config", "set", "terminal_command", `printf '%s\\n' {command} > '${out}'`]);
		return out;
	}

	it("opens the palette in the right sidebar and shows the files in ingest/", { timeout: TIMEOUT }, async () => {
		const o = await launch({
			prepare: async (vault) => {
				await writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n");
				await writeFile(path.join(vault, "ingest/notes.txt"), "Notes.\n");
			},
		});
		expect(await o.page.locator('.side-dock-ribbon-action[aria-label="Atlas"]').count()).toBe(1);
		const palette = await openPalette(o);
		await until("the ingest count", async () => (await row(palette, "ingest")) === "2 files", { describe: () => palette.innerText() });
		expect(await palette.locator(".atlas-palette-files li").allTextContents()).toEqual(["Paper one.md", "notes.txt"]);
		expect(await palette.locator('[data-action="ingest"] button').textContent()).toBe("Ingest 2 files");
		expect(await row(palette, "proposed")).toBe("0");
		expect(await row(palette, "trash")).toBe("0 files");
		expect(await o.page.evaluate(() => {
			const ws = (window as any).app.workspace;
			return ws.getLeavesOfType("atlas-palette")[0].getRoot() === ws.rightSplit;
		})).toBe(true);
		// The palette replaces the status bar item of 10.0.
		expect(await o.page.locator(".status-bar [class*=atlas-]").count()).toBe(0);
		expect(o.errors).toEqual([]);
	});

	it("starts an ingest without Duet: the work document opens, and the agent starts in the terminal", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: (vault) => writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n") });
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		const ingest = palette.locator('[data-action="ingest"] button', { hasText: "Ingest 1 file" });
		await ingest.waitFor({ timeout: 10_000 });
		await ingest.click();

		const command = await until("the terminal command", async () => (existsSync(out) ? (await readFile(out, "utf8")).trim() : undefined));
		const status = JSON.parse(await o.atlas(["vault", "--json"])).status;
		expect(status.changes.running).toHaveLength(1);
		const doc = status.changes.running[0];
		expect(doc.kind).toBe("ingest");
		expect(frontmatter(await o.read(doc.path)).files).toBe("[Paper one.md]");
		const message = `/atlas-obsidian:wiki-ingest Ingest the files of ingest/ into the wiki. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`;
		expect(command).toMatch(/^cd '.+' && claude '.+'$/);
		expect(command.endsWith(` && claude '${message}'`)).toBe(true);

		expect(await notices(o)).toContain("Atlas: Duet runs the agents in Obsidian. Duet 0.3.0 or later is not on, so Atlas starts the agent in a terminal.");
		expect(await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(doc.path);
		await until("the palette to list the running work", async () => (await row(palette, "running")) === "1", { describe: () => palette.innerText() });
		expect(await palette.locator(".atlas-palette-link", { hasText: doc.title }).count()).toBe(1);
		expect(o.errors).toEqual([]);
	});

	it("starts an ingest through Duet's API, and lists the conversation under Running until its turn ends", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: (vault) => writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n") });
		// A stand-in for Duet at the API boundary: it records each call and ends a turn when the test says so.
		await o.page.evaluate(() => {
			const w = window as any;
			const status = new Map<string, string>();
			const listeners = new Map<string, ((turn: unknown) => void)[]>();
			w.duetCalls = [];
			w.duetEnd = (path: string) => {
				status.set(path, "active");
				for (const cb of listeners.get(path) ?? []) cb({ path, status: "completed" });
			};
			w.app.plugins.plugins.duet = {
				api: {
					version: 1,
					newConversation: async (options: { title: string }) => {
						w.duetCalls.push(options);
						const path = `Duet/${options.title}.md`;
						status.set(path, "working");
						return { path };
					},
					conversationStatus: (path: string) => status.get(path) ?? "none",
					onTurnEnd: (path: string, cb: (turn: unknown) => void) => {
						listeners.set(path, [...(listeners.get(path) ?? []), cb]);
						return () => listeners.set(path, (listeners.get(path) ?? []).filter((x) => x !== cb));
					},
				},
			};
		});
		const palette = await openPalette(o);
		const ingest = palette.locator('[data-action="ingest"] button', { hasText: "Ingest 1 file" });
		await ingest.waitFor({ timeout: 10_000 });
		await ingest.click();

		const calls = await until("the conversation", async () => {
			const c = await o.page.evaluate(() => (window as any).duetCalls);
			return c.length > 0 ? c : undefined;
		});
		const doc = JSON.parse(await o.atlas(["vault", "--json"])).status.changes.running[0];
		expect(calls).toEqual([
			{
				message: `/atlas-obsidian:wiki-ingest Ingest the files of ingest/ into the wiki. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`,
				title: `Agent · ${doc.title}`,
				loadUserSetup: true,
			},
		]);
		const running = palette.locator(".atlas-palette-agent");
		await until("the Running list", async () => (await running.count()) === 1, { describe: () => palette.innerText() });
		expect(await running.textContent()).toBe(`ingestAgent · ${doc.title}`);

		await o.page.evaluate((title) => (window as any).duetEnd(`Duet/Agent · ${title}.md`), doc.title);
		await until("the turn's end to clear the list", async () => (await running.count()) === 0, { describe: () => palette.innerText() });
		expect(await notices(o)).not.toContain("Atlas: Duet runs the agents in Obsidian. Duet 0.3.0 or later is not on, so Atlas starts the agent in a terminal.");
		await o.page.evaluate(() => delete (window as any).app.plugins.plugins.duet);
		expect(o.errors).toEqual([]);
	});

	it("shows a running work document's last step, and Cancel rejects it", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const started = JSON.parse(await o.atlas(["change", "start", "--kind", "repair", "--title", "Fix the links", "--json"]));
		const { id, path: note } = started.ref;
		await open(o, note, "source");

		const widget = o.page.locator(".atlas-change-card");
		await until("the running widget", async () => (await widget.count()) === 1 && (await widget.getAttribute("data-state")) === "running", {
			describe: async () => ((await widget.count()) ? widget.innerHTML() : "no widget"),
		});
		expect(await widget.locator(".atlas-change-label").textContent()).toBe("Running");
		expect(await widget.locator(".atlas-change-kind").textContent()).toBe("repair");
		expect(await widget.locator(".atlas-change-line").textContent()).toMatch(/^The agent starts\./);
		expect(await widget.locator("button").allTextContents()).toEqual(["Cancel"]);
		// The note's cssclass styles the document; the lead callout gives way to the card.
		expect(await o.page.locator(".markdown-source-view.atlas-change").count()).toBe(1);
		expect(await o.page.locator('.markdown-source-view.atlas-change .callout[data-callout="change"]').isVisible()).toBe(false);

		await o.atlas(["change", "progress", id, "matched 3 subjects"]);
		await o.atlas(["change", "progress", id, "drafted the repairs"]);
		await until("the last step in the widget", async () => /^\d{2}:\d{2} drafted the repairs$/.test((await widget.locator(".atlas-change-line").textContent()) ?? ""), {
			describe: async () => `widget: ${await widget.innerHTML()}`,
		});

		await widget.locator("button", { hasText: "Cancel" }).click();
		const modal = o.page.locator(".modal", { hasText: "Cancel this change" });
		expect(await modal.textContent()).toContain("The agent stops when it reports its next step");
		await modal.locator("button", { hasText: "Cancel the change" }).click();
		await until("status: rejected", async () => (await status(o, note)).status === "rejected", { describe: () => o.read(note) });
		expect((await status(o, note)).reason).toBe("cancelled in Obsidian");
		await until("the widget to show the result", async () => (await widget.getAttribute("data-state")) === "rejected", {
			describe: async () => `widget: ${await widget.innerHTML()}`,
		});
		expect(await widget.locator(".atlas-change-line").textContent()).toBe("Rejected: cancelled in Obsidian");
		expect(await widget.locator("button").count()).toBe(0);
		expect(o.errors).toEqual([]);
	});

	it("safe delete moves a note that nothing links to trash/", { timeout: TIMEOUT }, async () => {
		const note = "scratchpad/Loose note.md";
		const o = await launch({
			prepare: async (vault) => {
				await mkdir(path.join(vault, "scratchpad"), { recursive: true });
				await writeFile(path.join(vault, note), "A note nothing links.\n");
			},
		});
		await open(o, note, "source");
		const palette = await openPalette(o);
		const button = palette.locator('[data-action="trash"] button');
		expect(await palette.locator('[data-action="trash"] .atlas-palette-path').textContent()).toBe(note);
		await button.click();

		await until("the note to leave", () => !existsSync(path.join(o.vault, note)));
		const [day] = await readdir(path.join(o.vault, "trash"));
		const moved = `trash/${day}/${note}`;
		expect(await o.read(moved)).toBe("A note nothing links.\n");
		// The views sync that the move starts may commit a snapshot after it; the move is a commit of its own.
		await until("the trash commit", async () => (await o.git(["log", "-1", "--format=%s", "--", moved])) === `trash: ${note}\n`, {
			describe: () => o.git(["log", "--stat", "-3"]),
		});
		await until("the notice", async () => (await notices(o)).includes(`Atlas: Moved ${note} to ${moved}.`), { describe: async () => JSON.stringify(await notices(o)) });
		await until("the trash count", async () => (await row(palette, "trash")) === "1 file", { describe: () => palette.innerText() });
		expect(o.errors).toEqual([]);
	});

	it("safe delete keeps a linked topic and shows its backlinks; Resolve starts an agent", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const plan = path.join(o.vault, "..", "plan.json");
		await writeFile(
			plan,
			JSON.stringify({
				title: "Add Alpha and Beta",
				writes: [
					{ op: "create", type: "topic", kind: "concept", title: "Alpha", fields: { description: "Alpha." }, body: "## Definition\n\nAlpha rests on [[Beta]].\n" },
					{ op: "create", type: "topic", kind: "concept", title: "Beta", fields: { description: "Beta." }, body: "## Definition\n\nBeta.\n" },
				],
			}),
		);
		const change = JSON.parse(await o.atlas(["change", "propose", plan, "--json"]));
		await o.atlas(["change", "apply", change.ref.id, "--json"]);
		const beta = "source-core/documents/Beta.md";
		const out = await stubTerminal(o);
		await open(o, beta, "preview");

		const palette = await openPalette(o);
		await palette.locator('[data-action="trash"] button').click();
		const modal = o.page.locator(".modal", { hasText: "Beta stays" });
		await modal.waitFor({ timeout: 10_000 });
		const links = await modal.locator("li a").allTextContents();
		expect(links).toContain("Alpha");
		expect(await modal.textContent()).toContain(`${links.length === 1 ? "1 document links" : `${links.length} documents link`} ${beta}, so safe delete moved nothing.`);
		expect(existsSync(path.join(o.vault, beta))).toBe(true);
		expect(existsSync(path.join(o.vault, "trash"))).toBe(false);

		await modal.locator("button", { hasText: "Resolve with an agent" }).click();
		const command = await until("the terminal command", async () => (existsSync(out) ? (await readFile(out, "utf8")).trim() : undefined));
		expect(command).toContain(`claude '/atlas-obsidian:wiki-edit Remove [[Beta]] (${beta}), which `);
		expect(command).toContain("[[Alpha]]");
		expect(command).toMatch(/then propose a remove\.'$/);
		expect(o.errors).toEqual([]);
	});
});
