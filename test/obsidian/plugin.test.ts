import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AlmagestBinary, buildAlmagest, frontmatter, launchObsidian, type ObsidianInstance, until } from "./harness";

const TIMEOUT = 90_000;

/** A terminal command while Duet is the choice and does not run: the tip, then the agent in the vault. */
const TIP_THEN_AGENT = /^printf '.+' '.+Almagest works best with the Duet community plugin.+' 'obsidian:\/\/show-plugin\?id=duet' && cd '.+' && claude '.+'$/s;

describe("Almagest in Obsidian", () => {
	let bin: AlmagestBinary;
	let obsidian: ObsidianInstance | undefined;

	beforeAll(async () => {
		bin = await buildAlmagest();
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
		const out = JSON.parse(await o.almagest(["change", "propose", plan, "--json"]));
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

	it("loads in a vault with no console error, and adds nothing to the file explorer but the colors of its folders", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		expect(await o.page.evaluate(() => (window as any).app.plugins.plugins.almagest.manifest.version)).toBe(JSON.parse(await readFile(new URL("../../manifest.json", import.meta.url), "utf8")).version);

		// A topic and a change document: Almagest's own files, which the explorer shows as Obsidian does.
		const change = await propose(o, "Add Alpha", "Alpha");
		await o.almagest(["change", "apply", change.id, "--json"]);

		// A manual sync runs the binary through the plugin; its notice tells that it ended.
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:sync"));
		await until("the sync notice", async () => (await notices(o)).some((t) => /^Almagest: (Synced .+|Generated files are up to date)\.$/.test(t)), {
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

		// What the plugin adds to the explorer: elements it marks, and the folder rows its
		// styles reach (each element's closest folder row, by path).
		const explorer = () =>
			o.page.evaluate(async () => {
				const app = (window as any).app;
				const root: HTMLElement = app.workspace.getLeavesOfType("file-explorer")[0].view.containerEl;
				const elements = [root, ...root.querySelectorAll<HTMLElement>("*")];
				const marked = elements
					.filter((el) => [...el.classList].some((c) => c.startsWith("almagest-")) || [...el.attributes].some((a) => a.name.startsWith("data-almagest")))
					.map((el) => el.outerHTML.slice(0, 160));

				// The plugin's styles.css, as Obsidian put it in the page.
				const plugin = app.plugins.plugins.almagest;
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
				const styled = new Set<string>();
				for (const selector of rules) {
					const plain = selector.replace(/::?(before|after|placeholder|marker|selection|-webkit-[\w-]+)/g, "");
					for (const el of elements) {
						try {
							if (el.matches(plain)) styled.add(el.closest<HTMLElement>(".nav-folder-title")?.dataset.path ?? el.outerHTML.slice(0, 80));
						} catch {
							// A selector the page cannot match, such as a vendor one.
						}
					}
				}
				const color = (folder: string) => getComputedStyle(root.querySelector(`.nav-folder-title[data-path="${folder}"]`)!).color;
				const swatch = (variable: string) => {
					const probe = document.body.createDiv();
					probe.style.color = `var(${variable})`;
					const out = getComputedStyle(probe).color;
					probe.remove();
					return out;
				};
				return {
					marked,
					sheet: !!sheet,
					rules: rules.length,
					styled: [...styled].sort(),
					colors: { "wiki-view": color("wiki-view") === swatch("--color-cyan"), journals: color("journals") === swatch("--color-purple"), ingest: color("ingest") === swatch("--color-purple"), tool: color("tool") === swatch("--text-faint") },
				};
			});
		const on = await explorer();
		expect(on.marked).toEqual([]);
		expect(on.sheet).toBe(true);
		expect(on.rules).toBeGreaterThan(10);
		expect(on.styled).toEqual(["ingest", "journals", "tool", "wiki-view"]);
		expect(on.colors).toEqual({ "wiki-view": true, journals: true, ingest: true, tool: true });

		// The setting turns the colors off, and then no rule of the plugin reaches the explorer.
		await o.page.evaluate(async () => {
			const plugin = (window as any).app.plugins.plugins.almagest;
			plugin.settings.colorFolders = false;
			plugin.colorFolders();
		});
		const off = await explorer();
		expect(off.styled).toEqual([]);
		expect(off.colors).toEqual({ "wiki-view": false, journals: false, ingest: false, tool: false });
		expect(o.errors).toEqual([]);
	});

	it("shows the settings from definitions, and saves an agent preference through the binary", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const settings = await o.settings("almagest");
		const tab = settings.locator(".vertical-tab-content");
		await until("the binary's status", async () => (await tab.textContent())?.includes("(almagest dev)") === true, { describe: async () => (await tab.textContent()) ?? "" });
		const text = (await tab.textContent()) ?? "";
		for (const name of ["Path to the almagest binary", "Keep the views fresh", "Snapshot after a quiet period", "All vaults", "This vault"]) expect(text).toContain(name);
		// A setting that is not visible stays in the page, hidden.
		// A row is the nearest .setting-item around its name; a group wraps its rows in one too.
		const row = (name: RegExp) => tab.locator(".setting-item-name", { hasText: name }).first().locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' setting-item ')][1]");
		const customCommand = row(/^Custom terminal command$/);
		expect(await customCommand.isVisible()).toBe(false);

		const terminal = row(/^Terminal$/);
		// Obsidian adds a hidden select that measures the dropdown's width.
		await terminal.locator("select:not(.is-measuring)").selectOption("custom");
		await until("the binary's config", async () => JSON.parse(await o.almagest(["config", "--json"])).global.terminal === "custom", {
			describe: () => o.almagest(["config"]),
		});
		await until("the custom command field", async () => await customCommand.isVisible());
		expect(o.errors).toEqual([]);
	});

	it("says how to get the binary when it cannot run one, and nothing more", { timeout: TIMEOUT }, async () => {
		const o = await launch({ pluginData: { binaryPath: "/nowhere/almagest" } });
		await until("the notice", async () => (await notices(o)).some((n) => n.includes("Almagest cannot run its binary at /nowhere/almagest.")), {
			describe: async () => JSON.stringify(await notices(o)),
		});
		const notice = (await notices(o)).find((n) => n.includes("/nowhere/almagest"))!;
		expect(notice).toContain("claude plugin install almagest@nathanaday-almagest");
		expect(o.errors).toEqual([]);
	});

	/** Sets the layout that the vault document records. */
	const layout = (n: number) => async (vault: string) => {
		const almagest = path.join(vault, "Almagest.md");
		await writeFile(almagest, (await readFile(almagest, "utf8")).replace(/^layout: \d+$/m, `layout: ${n}`));
	};

	/** Waits until Obsidian has read every file into its metadata cache. */
	function indexed(o: ObsidianInstance): Promise<unknown> {
		return o.page.waitForFunction(() => (window as any).app.metadataCache.inProgressTaskCount === 0, undefined, { timeout: 10_000 });
	}

	describe("reads the layout when it loads at Obsidian's start in a vault Obsidian has not indexed", () => {
		it("this layout: no notice", { timeout: TIMEOUT }, async () => {
			const o = await launch();
			await o.restart({ freshIndex: true });
			await indexed(o);
			expect(await notices(o)).toEqual([]);
			expect(o.errors).toEqual([]);
		});

		it("another layout: one notice that names the update", { timeout: TIMEOUT }, async () => {
			const o = await launch({ prepare: layout(9) });
			await o.restart({ freshIndex: true });
			await indexed(o);
			expect(await notices(o)).toEqual([
				"Almagest: this vault has layout 9, and this plugin reads layout 8. Update Almagest in Obsidian's community plugins, and the agent plugin (claude plugin update almagest@nathanaday-almagest).",
			]);
			expect(o.errors).toEqual([]);
		});

		it("the layout of 11.0: one notice that offers the migration", { timeout: TIMEOUT }, async () => {
			const o = await launch({ prepare: layout(7) });
			await o.restart({ freshIndex: true });
			await indexed(o);
			expect(await notices(o)).toEqual([
				"Almagest: this vault keeps sessions/, source-core/, and trash/ at its root, and this version keeps them in tool/. Open the Almagest palette to migrate the vault.",
			]);
			expect(o.errors).toEqual([]);
		});
	});

	it("approves a change from its widget", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const change = await propose(o, "Add Alpha", "Alpha");
		await open(o, change.note, "source");

		const widget = o.page.locator(".almagest-change-card");
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
		expect(await widget.locator(".almagest-change-line").textContent()).toMatch(/^Applied \d{4}-\d{2}-\d{2} \d{2}:\d{2}\.$/);
		expect(await widget.locator("button").count()).toBe(0);
		expect(await o.git(["log", "-1", "--format=%s"])).toBe("change: Add Alpha\n");
		expect(o.errors).toEqual([]);
	});

	it("cancels a change from its widget, with a reason", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const change = await propose(o, "Add Beta", "Beta");
		await open(o, change.note, "preview");

		const widget = o.page.locator(".markdown-reading-view .almagest-change-card");
		await widget.locator("button", { hasText: "Cancel" }).click({ timeout: 10_000 });
		const modal = o.page.locator(".modal", { hasText: "Cancel this change" });
		await modal.locator("input.almagest-reason-input").fill("Not needed now");
		await modal.locator("button", { hasText: "Cancel the change" }).click();

		await until("status: rejected", async () => (await status(o, change.note)).status === "rejected", {
			describe: () => o.read(change.note),
		});
		expect((await status(o, change.note)).reason).toBe("Not needed now");
		expect(existsSync(path.join(o.vault, change.topicPath))).toBe(false);
		await until("the widget to show the reason", async () => (await widget.getAttribute("data-state")) === "rejected", {
			describe: async () => `widget: ${await widget.innerHTML()}`,
		});
		expect(await widget.locator(".almagest-change-line").textContent()).toBe("Rejected: Not needed now");
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

	type Palette = ReturnType<ObsidianInstance["page"]["locator"]>;

	/** Opens the palette from its command and waits for its home. */
	async function openPalette(o: ObsidianInstance): Promise<Palette> {
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:open-palette"));
		const palette = o.page.locator(".almagest-palette");
		await until("the palette's home", async () => (await palette.locator('[data-area="ingest"]').count()) > 0, {
			describe: async () => `palette: ${(await palette.count()) ? await palette.innerText() : "none"}`,
		});
		return palette;
	}

	/** Goes back to the palette's home. */
	async function home(palette: Palette): Promise<void> {
		// A notice that the test already read would cover the palette's rows and its way back.
		await palette.page().evaluate(() => document.querySelectorAll(".notice-container .notice").forEach((n) => n.remove()));
		if ((await palette.getAttribute("data-page")) === "home") return;
		await palette.locator(".almagest-back").click();
		await until("the palette's home", async () => (await palette.getAttribute("data-page")) === "home");
	}

	/** Opens an area's page from the palette's home. */
	async function goTo(palette: Palette, area: string): Promise<void> {
		await home(palette);
		await palette.locator(`[data-area="${area}"]`).click();
		await until(`the ${area} page`, async () => (await palette.getAttribute("data-page")) === area);
	}

	/** The line under an area's row on the palette's home. */
	async function line(palette: Palette, area: string): Promise<string | null> {
		await home(palette);
		return palette.locator(`[data-area="${area}"] .almagest-nav-line`).textContent();
	}

	/** The number of a page's tile, by its label. */
	function tile(palette: Palette, label: string): Promise<string | null> {
		return palette.locator(".almagest-tile", { has: palette.page().locator(".almagest-tile-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".almagest-tile-number").textContent();
	}

	/** Points the agent's terminal at a command that writes what it would run to a file, so no terminal opens. */
	async function stubTerminal(o: ObsidianInstance): Promise<string> {
		const out = path.join(o.vault, "..", "terminal.txt");
		await o.almagest(["config", "set", "terminal", "custom"]);
		await o.almagest(["config", "set", "terminal_command", `printf '%s\\n' {command} > '${out}'`]);
		return out;
	}

	it("opens the palette in the right sidebar and shows the files in ingest/", { timeout: TIMEOUT }, async () => {
		const o = await launch({
			prepare: async (vault) => {
				await writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n");
				await writeFile(path.join(vault, "ingest/notes.txt"), "Notes.\n");
			},
		});
		// The palette is the plugin's one ribbon button: sync and the sessions live in it.
		const ribbon = await o.page.locator(".side-dock-ribbon-action").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
		expect(ribbon.filter((l) => /almagest|tag navigator|sessions/i.test(l ?? ""))).toEqual(["Almagest"]);
		const palette = await openPalette(o);
		await until("the ingest line", async () => (await line(palette, "ingest")) === "2 files waiting", { describe: () => palette.innerText() });
		expect(await palette.locator('[data-area="ingest"] .almagest-chip').textContent()).toBe("2");
		expect(await line(palette, "changes")).toBe("Nothing to review");
		expect(await palette.locator('[data-area="changes"] .almagest-chip').count()).toBe(0);
		await goTo(palette, "ingest");
		expect(await palette.locator(".almagest-item-title").allTextContents()).toEqual(["Paper one.md", "notes.txt"]);
		expect(await palette.locator('button[data-action="ingest"]').textContent()).toBe("Ingest 2 files");
		expect(await tile(palette, "files waiting")).toBe("2");
		await goTo(palette, "note");
		expect(await tile(palette, "files in trash")).toBe("0");
		expect(await o.page.evaluate(() => {
			const ws = (window as any).app.workspace;
			return ws.getLeavesOfType("almagest-palette")[0].getRoot() === ws.rightSplit;
		})).toBe(true);
		// Almagest adds nothing to the status bar.
		expect(await o.page.locator(".status-bar [class*=almagest-]").count()).toBe(0);
		expect(o.errors).toEqual([]);
	});

	it("starts an ingest without Duet: the work document opens, and the agent starts in the terminal", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: (vault) => writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n") });
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		await goTo(palette, "ingest");
		const ingest = palette.locator('button[data-action="ingest"]', { hasText: "Ingest 1 file" });
		await ingest.waitFor({ timeout: 10_000 });
		await ingest.click();

		const command = await until("the terminal command", async () => (existsSync(out) ? (await readFile(out, "utf8")).trim() : undefined));
		const status = JSON.parse(await o.almagest(["vault", "--json"])).status;
		expect(status.changes.running).toHaveLength(1);
		const doc = status.changes.running[0];
		expect(doc.kind).toBe("ingest");
		expect(frontmatter(await o.read(doc.path)).files).toBe("[Paper one.md]");
		const message = `/almagest:wiki-ingest Ingest the files of ingest/ into the wiki. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`;
		expect(command).toMatch(TIP_THEN_AGENT);
		expect(command.endsWith(` && claude '${message}'`)).toBe(true);

		expect(await notices(o)).toContain("Almagest: Duet is not on, so the agent starts in a terminal. The Almagest settings say what Duet needs, or choose the terminal there.");
		expect(await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(doc.path);
		await until("the palette to count the running work", async () => (await line(palette, "changes")) === "1 running", { describe: () => palette.innerText() });
		await goTo(palette, "changes");
		expect(await palette.locator(".almagest-link", { hasText: doc.title }).count()).toBe(1);
		expect(o.errors).toEqual([]);
	});

	/**
	 * A stand-in for Duet at its boundaries: the API, which records each call and ends a turn
	 * when the test says so, and the command "New conversation", which counts its runs.
	 */
	async function fakeDuet(o: ObsidianInstance): Promise<void> {
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
			w.duetNewChats = 0;
			w.app.commands.commands["duet:new-chat"] = { id: "duet:new-chat", name: "Duet: New conversation", callback: () => w.duetNewChats++ };
		});
	}

	/** Takes the stand-in Duet away, as the user does by turning Duet off. */
	async function removeDuet(o: ObsidianInstance): Promise<void> {
		await o.page.evaluate(() => {
			const w = window as any;
			delete w.app.plugins.plugins.duet;
			delete w.app.commands.commands["duet:new-chat"];
		});
	}

	it("starts an ingest through Duet's API, and lists the conversation under Running until its turn ends", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: (vault) => writeFile(path.join(vault, "ingest/Paper one.md"), "# Paper one\n") });
		await fakeDuet(o);
		const palette = await openPalette(o);
		await goTo(palette, "ingest");
		const ingest = palette.locator('button[data-action="ingest"]', { hasText: "Ingest 1 file" });
		await ingest.waitFor({ timeout: 10_000 });
		await ingest.click();

		const calls = await until("the conversation", async () => {
			const c = await o.page.evaluate(() => (window as any).duetCalls);
			return c.length > 0 ? c : undefined;
		});
		const doc = JSON.parse(await o.almagest(["vault", "--json"])).status.changes.running[0];
		expect(calls).toEqual([
			{
				message: `/almagest:wiki-ingest Ingest the files of ingest/ into the wiki. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`,
				title: `Agent · ${doc.title}`,
				loadUserSetup: true,
			},
		]);
		await until("the agents line", async () => (await line(palette, "agents"))?.startsWith("1 working") === true, { describe: () => palette.innerText() });
		await goTo(palette, "agents");
		const running = palette.locator(".almagest-agent");
		await until("the Working list", async () => (await running.count()) === 1, { describe: () => palette.innerText() });
		expect(await running.locator(".almagest-thread-title").textContent()).toBe(`Agent · ${doc.title}`);
		expect(await running.locator(".almagest-thread-preview").textContent()).toBe("ingest · working in Duet");
		expect(await running.getAttribute("data-state")).toBe("working");

		await o.page.evaluate((title) => (window as any).duetEnd(`Duet/Agent · ${title}.md`), doc.title);
		await until("the turn's end to clear the list", async () => (await running.count()) === 0, { describe: () => palette.innerText() });
		expect(await notices(o)).not.toContain("Almagest: Duet is not on, so the agent starts in a terminal. The Almagest settings say what Duet needs, or choose the terminal there.");
		await removeDuet(o);
		expect(o.errors).toEqual([]);
	});

	it("the settings choose where agents work: Duet names what it needs, and the terminal's settings show while a terminal starts the agents", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const settings = await o.settings("almagest");
		const tab = settings.locator(".vertical-tab-content");
		const row = (name: RegExp) => tab.locator(".setting-item-name", { hasText: name }).first().locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' setting-item ')][1]");
		const choice = row(/^Agent conversations$/).locator("select:not(.is-measuring)");
		const duet = tab.locator(".almagest-duet-state");
		const terminalSettings = tab.locator(".setting-item-heading, .setting-group-heading, h3, .setting-item-name", { hasText: /^All vaults$/ });
		await until("the Duet line", async () => (await duet.count()) === 1, { describe: async () => (await tab.textContent()) ?? "" });

		// Duet is the default; without it, the settings name the install and keep the terminal's settings.
		expect(await choice.inputValue()).toBe("duet");
		expect(await choice.locator("option").allTextContents()).toEqual(["Duet (recommended)", "Terminal (configurable)"]);
		expect(await duet.getAttribute("data-state")).toBe("missing");
		expect(await duet.textContent()).toContain("Duet is not installed. Install it from Obsidian's community plugins.");
		expect(await duet.locator("button", { hasText: "Install Duet" }).count()).toBe(1);
		expect(await terminalSettings.count()).toBeGreaterThan(0);

		// With Duet on, Duet runs the conversations, and the terminal's settings leave.
		await fakeDuet(o);
		await until("Duet on", async () => (await duet.getAttribute("data-state")) === "on", { describe: async () => (await tab.textContent()) ?? "" });
		expect(await duet.textContent()).toContain("Duet runs each agent conversation in a note of this vault");
		expect(await terminalSettings.count()).toBe(0);

		// The terminal: no Duet line, and the terminal's settings.
		await choice.selectOption("terminal");
		await until("the terminal's settings", async () => (await duet.count()) === 0 && (await terminalSettings.count()) > 0, { describe: async () => (await tab.textContent()) ?? "" });
		expect(await o.page.evaluate(() => (window as any).app.plugins.plugins.almagest.settings.conversations)).toBe("terminal");
		await removeDuet(o);
		expect(o.errors).toEqual([]);
	});

	it("shows the Duet tip above Almagest.md's text while Duet is the choice and does not run, and writes nothing into the file", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		// A note keeps both views in the page; each check looks in the one the leaf shows.
		const view = { source: ".markdown-source-view", preview: ".markdown-reading-view" } as const;
		const tipIn = (mode: keyof typeof view) => o.page.locator(`.workspace-leaf.mod-active ${view[mode]} .almagest-duet-tip`);
		let tip = tipIn("source");
		const shows = async (mode: string) => {
			await until(`the tip in ${mode}`, async () => (await tip.count()) === 1 && (await tip.isVisible()), { describe: () => o.page.locator(".workspace-leaf.mod-active").innerText() });
			expect(await tip.locator(".callout-title-inner").textContent()).toBe("Tip");
			expect(await tip.textContent()).toContain("Almagest works best with the Duet community plugin.");
			expect(await tip.locator("a.almagest-duet-link").getAttribute("href")).toBe("obsidian://show-plugin?id=duet");
		};
		// A vault with no description has no text after the properties; the tip follows them.
		for (const mode of ["source", "preview"] as const) {
			await open(o, "Almagest.md", mode);
			tip = tipIn(mode);
			await shows(`${mode}, with no text`);
		}
		// With text, the tip comes before it.
		await o.page.evaluate(async () => {
			const app = (window as any).app;
			const file = app.vault.getFileByPath("Almagest.md");
			await app.vault.modify(file, (await app.vault.read(file)) + "\nThe vault's own context.\n");
		});
		const before = await o.read("Almagest.md");
		for (const mode of ["source", "preview"] as const) {
			await open(o, "Almagest.md", mode);
			tip = tipIn(mode);
			await shows(`${mode}, with text`);
			// The text follows the tip, in the same view.
			const follows = await tip.evaluate((el, scope) => {
				const text = [...document.querySelectorAll(`.workspace-leaf.mod-active ${scope} *`)].find((x) => x.childElementCount === 0 && x.textContent === "The vault's own context.");
				return !!text && (el.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
			}, view[mode]);
			expect(follows).toBe(true);
		}
		// The tip stays out of other notes.
		await o.page.evaluate(async () => {
			await (window as any).app.vault.create("scratchpad/Plain.md", "Text.\n");
		});
		await open(o, "scratchpad/Plain.md", "source");
		expect(await o.page.locator(".workspace-leaf.mod-active .almagest-duet-tip").count()).toBe(0);

		// Duet on: no tip. Duet off again: the tip. The terminal chosen: no tip.
		await open(o, "Almagest.md", "source");
		tip = tipIn("source");
		await until("the tip", async () => (await tip.count()) === 1);
		await fakeDuet(o);
		await until("the tip to leave with Duet on", async () => (await tip.count()) === 0);
		await removeDuet(o);
		await until("the tip to come back", async () => (await tip.count()) === 1);
		await o.page.evaluate(async () => {
			const plugin = (window as any).app.plugins.plugins.almagest;
			plugin.settings.conversations = "terminal";
			plugin.duetChanged();
		});
		await until("the tip to leave with the terminal chosen", async () => (await tip.count()) === 0);
		await open(o, "Almagest.md", "preview");
		expect(await tipIn("preview").count()).toBe(0);
		expect(await o.read("Almagest.md")).toBe(before);
		expect(o.errors).toEqual([]);
	});

	it("with the terminal chosen, an agent starts in a terminal with no tip and no notice", { timeout: TIMEOUT }, async () => {
		const o = await launch({ pluginData: { conversations: "terminal" } });
		const out = await stubTerminal(o);
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:start-agent"));
		const command = await terminalCommand(out);
		expect(command).toMatch(/^cd '.+' && claude$/);
		expect((await notices(o)).filter((t) => t.includes("Duet"))).toEqual([]);
		expect(o.errors).toEqual([]);
	});

	it("Start an agent opens a new Duet conversation when Duet runs, and a terminal with the tip when it does not", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const out = await stubTerminal(o);
		await fakeDuet(o);
		const palette = await openPalette(o);
		await goTo(palette, "agents");
		await palette.locator('button[data-action="start"]').click();
		await until("the Duet conversation", async () => (await o.page.evaluate(() => (window as any).duetNewChats)) === 1);
		expect(existsSync(out)).toBe(false);

		await removeDuet(o);
		await goTo(palette, "agents");
		await palette.locator('button[data-action="start"]').click();
		const command = await terminalCommand(out);
		expect(command).toMatch(/^printf '.+' 'obsidian:\/\/show-plugin\?id=duet' && cd '.+' && claude$/s);
		expect(o.errors).toEqual([]);
	});

	it("shows a running work document's last step, and Cancel rejects it", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const started = JSON.parse(await o.almagest(["change", "start", "--kind", "repair", "--title", "Fix the links", "--json"]));
		const { id, path: note } = started.ref;
		await open(o, note, "source");

		const widget = o.page.locator(".almagest-change-card");
		await until("the running widget", async () => (await widget.count()) === 1 && (await widget.getAttribute("data-state")) === "running", {
			describe: async () => ((await widget.count()) ? widget.innerHTML() : "no widget"),
		});
		expect(await widget.locator(".almagest-change-label").textContent()).toBe("Running");
		expect(await widget.locator(".almagest-change-kind").textContent()).toBe("repair");
		expect(await widget.locator(".almagest-change-line").textContent()).toMatch(/^The agent starts\./);
		expect(await widget.locator("button").allTextContents()).toEqual(["Cancel"]);
		// The note's cssclass styles the document; the lead callout gives way to the card.
		expect(await o.page.locator(".markdown-source-view.almagest-change").count()).toBe(1);
		expect(await o.page.locator('.markdown-source-view.almagest-change .callout[data-callout="change"]').isVisible()).toBe(false);

		await o.almagest(["change", "progress", id, "matched 3 subjects"]);
		await o.almagest(["change", "progress", id, "drafted the repairs"]);
		await until("the last step in the widget", async () => /^\d{2}:\d{2} drafted the repairs$/.test((await widget.locator(".almagest-change-line").textContent()) ?? ""), {
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
		expect(await widget.locator(".almagest-change-line").textContent()).toBe("Rejected: cancelled in Obsidian");
		expect(await widget.locator("button").count()).toBe(0);
		expect(o.errors).toEqual([]);
	});

	/** Today in an edition's title: "6 October 2026". */
	function today(): string {
		const d = new Date();
		return `${d.getDate()} ${d.toLocaleString("en-US", { month: "long" })} ${d.getFullYear()}`;
	}

	/** The command the terminal stand-in got, once it differs from before. */
	function terminalCommand(out: string, before = ""): Promise<string> {
		return until("the terminal command", async () => {
			const text = existsSync(out) ? (await readFile(out, "utf8")).trim() : "";
			return text !== "" && text !== before ? text : undefined;
		});
	}

	/** The running work document whose title ends with title. */
	async function workDoc(o: ObsidianInstance, title: string): Promise<{ id: string; title: string; path: string; kind: string }> {
		const running = JSON.parse(await o.almagest(["vault", "--json"])).status.changes.running as { id: string; title: string; path: string; kind: string }[];
		const doc = running.find((r) => r.title.endsWith(` ${title}`));
		if (!doc) throw new Error(`No running work document for ${title}: ${JSON.stringify(running)}`);
		return doc;
	}

	it("publishes a journal volume from the palette and from the command, without Duet", { timeout: 120_000 }, async () => {
		const note = "journals/cs566-notes/Week 1.md";
		const history = "journals/cs566-notes/Journal · cs566-notes.md";
		const o = await launch({
			prepare: async (vault) => {
				await mkdir(path.join(vault, "journals/cs566-notes"), { recursive: true });
				await writeFile(path.join(vault, note), "Gradient descent finally clicked.\n");
			},
		});
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		await until("the journals line", async () => (await line(palette, "journals")) === "1 to publish", { describe: () => palette.innerText() });
		await goTo(palette, "journals");
		const volume = palette.locator('.almagest-item[data-volume="cs566-notes"]');
		const publish = volume.locator('button[data-action="publish"]');
		const meta = volume.locator(".almagest-item-meta");
		await until("the volume in the palette", async () => (await volume.count()) === 1, { describe: () => palette.innerText() });
		expect(await volume.locator(".almagest-item-title").textContent()).toBe("CS566 Notes");
		expect(await meta.textContent()).toBe("1 note · never published");
		expect(await volume.locator(".almagest-chip").textContent()).toBe("changed");
		expect(await tile(palette, "to publish")).toBe("1");
		expect(await publish.textContent()).toBe("Publish");
		expect(await publish.isEnabled()).toBe(true);

		// Publish asks first, and names the edition it makes.
		const title = `User Journal CS566 Notes - ${today()} Edition`;
		await publish.click();
		const modal = o.page.locator(".modal", { hasText: "Publish CS566 Notes" });
		await modal.waitFor({ timeout: 10_000 });
		expect(await modal.locator(".almagest-publish-title").textContent()).toBe(title);
		expect(await modal.textContent()).toContain("Publish captures the 1 note of journals/cs566-notes/ as one source:");
		await modal.locator("button.mod-cta", { hasText: "Publish" }).click();

		const command = await terminalCommand(out);
		const edition = `tool/source-core/documents/${title}.md`;
		const fields = frontmatter(await o.read(edition));
		expect([fields.origin, fields.volume, fields.locator, fields.status]).toEqual(["journal", "cs566-notes", "journals/cs566-notes", "pending"]);
		expect(await o.git(["log", "-1", "--format=%s", "--", edition])).toBe(`capture: ${title}\n`);
		expect(await o.read(history)).toMatch(/^> \[!almagest\] Written by Almagest at each publish\./);
		const doc = await workDoc(o, `Ingest ${title}`);
		expect(doc.kind).toBe("ingest");
		const message = `/almagest:wiki-sync Absorb the source [[${title}]] (${fields.id}), the user's journal edition. Cite it where its ideas land. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`;
		expect(command).toMatch(TIP_THEN_AGENT);
		expect(command.endsWith(` && claude '${message.replace(/'/g, "'\\''")}'`)).toBe(true);
		expect(await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(doc.path);
		expect(await notices(o)).toContain(`Almagest: published ${title}.`);

		// The volume now shows its edition, and Publish waits for a change.
		await until("the edition in the palette", async () => (await meta.textContent()) === `1 note · last edition ${title}`, { describe: () => palette.innerText() });
		expect(await publish.isDisabled()).toBe(true);
		expect(await publish.getAttribute("title")).toBe(`No change since ${title}.`);
		expect(await volume.locator(".almagest-chip").count()).toBe(0);
		expect(await tile(palette, "to publish")).toBe("0");

		// The publication history opens with the almagest callout, which the plugin styles.
		await open(o, history, "preview");
		const callout = o.page.locator('.markdown-reading-view .callout[data-callout="almagest"]');
		await callout.waitFor({ timeout: 10_000 });
		expect(await callout.evaluate((el) => getComputedStyle(el).getPropertyValue("--callout-icon").trim())).toBe("lucide-map");

		// A change to a note turns Publish on again; the command publishes the volume of the open note.
		await o.page.evaluate(async (file) => {
			const app = (window as any).app;
			await app.vault.modify(app.vault.getFileByPath(file), "Gradient descent finally clicked.\nMomentum too.\n");
		}, note);
		await until("Publish to turn on", async () => (await publish.isEnabled()) && (await tile(palette, "to publish")) === "1", { describe: () => palette.innerText() });
		await open(o, note, "source");
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:publish-journal"));
		await modal.waitFor({ timeout: 10_000 });
		expect(await modal.textContent()).toContain("An edition of this day exists, so this one takes a number.");
		await modal.locator("button.mod-cta", { hasText: "Publish" }).click();

		const second = await terminalCommand(out, command);
		const numbered = `${title} (2)`;
		expect(frontmatter(await o.read(`tool/source-core/documents/${numbered}.md`)).volume).toBe("cs566-notes");
		const doc2 = await workDoc(o, `Ingest ${numbered}`);
		expect(second).toContain(`Absorb the source [[${numbered}]]`);
		expect(second).toContain(`Your work document is [[${doc2.title}]] (${doc2.id})`);
		await until("the second edition in the palette", async () => (await meta.textContent()) === `1 note · last edition ${numbered}`, { describe: () => palette.innerText() });
		expect(await publish.isDisabled()).toBe(true);
		expect(o.errors).toEqual([]);
	});

	it("publish needs a note in a journal volume", { timeout: TIMEOUT }, async () => {
		const o = await launch({
			prepare: async (vault) => {
				await mkdir(path.join(vault, "journals/garden"), { recursive: true });
				await writeFile(path.join(vault, "journals/garden/.keep"), "");
				await mkdir(path.join(vault, "scratchpad"), { recursive: true });
				await writeFile(path.join(vault, "scratchpad/Loose note.md"), "Not a journal.\n");
			},
		});
		const palette = await openPalette(o);
		await goTo(palette, "journals");
		const volume = palette.locator('.almagest-item[data-volume="garden"]');
		await until("the empty volume", async () => (await volume.count()) === 1, { describe: () => palette.innerText() });
		expect(await volume.locator(".almagest-item-meta").textContent()).toBe("0 notes · never published");
		expect(await volume.locator('button[data-action="publish"]').isDisabled()).toBe(true);
		expect(await volume.locator('button[data-action="publish"]').getAttribute("title")).toBe("The volume holds no note.");
		expect(await tile(palette, "to publish")).toBe("0");

		// The command offers itself only inside journals/<volume>/.
		await open(o, "scratchpad/Loose note.md", "source");
		const available = () => o.page.evaluate(() => (window as any).app.commands.findCommand("almagest:publish-journal").checkCallback(true));
		expect(await available()).toBe(false);
		expect(o.errors).toEqual([]);
	});

	it("safe delete moves a note that nothing links to tool/trash/", { timeout: TIMEOUT }, async () => {
		const note = "scratchpad/Loose note.md";
		const o = await launch({
			prepare: async (vault) => {
				await mkdir(path.join(vault, "scratchpad"), { recursive: true });
				await writeFile(path.join(vault, note), "A note nothing links.\n");
			},
		});
		await open(o, note, "source");
		const palette = await openPalette(o);
		await goTo(palette, "note");
		// The editor names the open note; the palette does not repeat its path.
		expect(await palette.innerText()).not.toContain(note);
		await palette.locator('button[data-action="trash"]').click();

		await until("the note to leave", () => !existsSync(path.join(o.vault, note)));
		const [day] = await readdir(path.join(o.vault, "tool/trash"));
		const moved = `tool/trash/${day}/${note}`;
		expect(await o.read(moved)).toBe("A note nothing links.\n");
		// The views sync that the move starts may commit a snapshot after it; the move is a commit of its own.
		await until("the trash commit", async () => (await o.git(["log", "-1", "--format=%s", "--", moved])) === `trash: ${note}\n`, {
			describe: () => o.git(["log", "--stat", "-3"]),
		});
		await until("the notice", async () => (await notices(o)).includes(`Almagest: Moved ${note} to ${moved}.`), { describe: async () => JSON.stringify(await notices(o)) });
		await until("the trash count", async () => (await tile(palette, "file in trash")) === "1", { describe: () => palette.innerText() });
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
		const change = JSON.parse(await o.almagest(["change", "propose", plan, "--json"]));
		await o.almagest(["change", "apply", change.ref.id, "--json"]);
		const beta = "tool/source-core/documents/Beta.md";
		const mine = "scratchpad/Plan.md";
		await mkdir(path.join(o.vault, "scratchpad"), { recursive: true });
		await writeFile(path.join(o.vault, mine), "Read [[Beta]] first.\n");
		const out = await stubTerminal(o);
		await open(o, beta, "preview");

		const palette = await openPalette(o);
		await goTo(palette, "note");
		await palette.locator('button[data-action="trash"]').click();
		const modal = o.page.locator(".modal", { hasText: "Beta stays" });
		await modal.waitFor({ timeout: 10_000 });
		const links = await modal.locator("li a").allTextContents();
		expect(links).toEqual(expect.arrayContaining(["Alpha", "Plan"]));
		expect(await modal.textContent()).toContain(`${links.length} files link ${beta}, so safe delete moved nothing.`);
		expect(await modal.locator("li", { hasText: "Plan" }).textContent()).toContain("yours to fix");
		expect(await modal.textContent()).toContain("The links in your own notes are yours to fix");
		expect(existsSync(path.join(o.vault, beta))).toBe(true);
		expect(existsSync(path.join(o.vault, "trash"))).toBe(false);

		await modal.locator("button", { hasText: "Resolve with an agent" }).click();
		const command = await until("the terminal command", async () => (existsSync(out) ? (await readFile(out, "utf8")).trim() : undefined));
		expect(command).toContain(`claude '/almagest:wiki-edit Remove [[Beta]] (${beta}), which `);
		expect(command).toContain("[[Alpha]]");
		expect(command).toContain("[[Plan]] is the user");
		expect(command).toContain("propose no remove");
		expect(o.errors).toEqual([]);
	});

	/** Applies three linked topics, and checks out Beta and Alpha with the CLI, as the librarian would. */
	async function checkOut(o: ObsidianInstance): Promise<{ folder: string; readingList: string; alphaCopy: string; date: string }> {
		const plan = path.join(o.vault, "..", "topics.json");
		await writeFile(
			plan,
			JSON.stringify({
				title: "Add three topics",
				writes: [
					{ op: "create", type: "topic", kind: "concept", title: "Alpha", fields: { description: "Alpha." }, body: "## Definition\n\nAlpha rests on [[Beta]] and [[Gamma]].\n" },
					{ op: "create", type: "topic", kind: "concept", title: "Beta", fields: { description: "Beta." }, body: "## Definition\n\nBeta is the base.\n" },
					{ op: "create", type: "topic", kind: "concept", title: "Gamma", fields: { description: "Gamma." }, body: "## Definition\n\nGamma links [[Alpha]].\n" },
				],
			}),
		);
		const change = JSON.parse(await o.almagest(["change", "propose", plan, "--json"]));
		await o.almagest(["change", "apply", change.ref.id, "--json"]);
		const order = path.join(o.vault, "..", "order.json");
		await writeFile(
			order,
			JSON.stringify({
				request: "everything on alpha",
				name: "Alpha study",
				documents: [
					{ id: "Beta", why: "the base" },
					{ id: "Alpha", why: "the subject" },
				],
			}),
		);
		const { made } = JSON.parse(await o.almagest(["checkout", "make", order, "--json"]));
		const alphaCopy = made.copies.find((p: string) => p.endsWith("/Alpha (checkout).md"));
		return { folder: made.folder, readingList: made.reading_list, alphaCopy, date: frontmatter(await o.read(made.reading_list)).checked_out!.slice(0, 10) };
	}

	it("lists a checkout; an edited copy turns Return on, and Return proposes the edit that Approve applies", { timeout: 120_000 }, async () => {
		const o = await launch();
		const { folder, readingList, alphaCopy, date } = await checkOut(o);
		const palette = await openPalette(o);
		expect(await line(palette, "library")).toBe("1 checkout");
		await goTo(palette, "library");
		const checkout = palette.locator(`.almagest-item[data-folder="${folder}"]`);
		const ret = checkout.locator('button[data-action="return"]');
		const meta = checkout.locator(".almagest-item-meta");
		await until("the checkout in the palette", async () => (await checkout.count()) === 1, { describe: () => palette.innerText() });
		expect(await checkout.locator(".almagest-item-title").textContent()).toBe("everything on alpha");
		expect(await meta.textContent()).toBe(`${date} · 2 documents · 0 edited`);
		expect(await ret.textContent()).toBe("Return");
		expect(await ret.isDisabled()).toBe(true);
		expect(await ret.getAttribute("title")).toBe("No copy is edited.");
		expect(await tile(palette, "to return")).toBe("0");

		// The request opens the reading list; it and each copy open with the almagest callout.
		await checkout.locator(".almagest-item-title a").click();
		await until("the reading list", async () => (await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)) === readingList);
		for (const note of [readingList, alphaCopy]) {
			await open(o, note, "preview");
			const callout = o.page.locator('.workspace-leaf.mod-active .markdown-reading-view .callout[data-callout="almagest"]');
			await callout.waitFor({ timeout: 10_000 });
			expect(await callout.evaluate((el) => getComputedStyle(el).getPropertyValue("--callout-icon").trim())).toBe("lucide-map");
		}

		// An edit of a copy, as Obsidian saves it, turns Return on after the palette reads the status again.
		await o.page.evaluate(async (file) => {
			const app = (window as any).app;
			const copy = app.vault.getFileByPath(file);
			await app.vault.modify(copy, `${await app.vault.read(copy)}\nA line the reader added.\n`);
		}, alphaCopy);
		await until("Return to turn on", async () => (await ret.isEnabled()) && (await meta.textContent()) === `${date} · 2 documents · 1 edited`, { describe: () => palette.innerText() });
		expect(await tile(palette, "to return")).toBe("1");

		// Return proposes the change and opens it.
		await ret.click();
		const proposed = await until("the proposed change", async () => {
			const list = JSON.parse(await o.almagest(["vault", "--json"])).status.changes.proposed as { id: string; title: string; path: string }[];
			return list.length === 1 ? list[0] : undefined;
		});
		expect(proposed.title).toBe(`${date} Return ${folder.slice("checkout/".length + 11)}`);
		await until("the change to open", async () => (await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)) === proposed.path, {
			describe: () => o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path),
		});
		expect((await notices(o)).filter((t) => t.includes("left out"))).toEqual([]);
		await until("the checkout to show its return", async () => (await meta.textContent())?.startsWith(`${date} · 2 documents · 1 edited · returned `), { describe: () => palette.innerText() });
		expect(await ret.isDisabled()).toBe(true);
		expect(await ret.getAttribute("title")).toMatch(/^Returned \d{4}-\d{2}-\d{2}\.$/);
		expect(await tile(palette, "to return")).toBe("0");
		expect(frontmatter(await o.read(readingList)).returned).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// Approve writes the edit into the original, with the links pointed back at the wiki.
		const widget = o.page.locator(".workspace-leaf.mod-active .almagest-change-card");
		await widget.locator("button", { hasText: "Approve" }).click({ timeout: 10_000 });
		await until("the change to apply", async () => (await status(o, proposed.path)).status === "applied", { describe: () => o.read(proposed.path) });
		const alpha = await o.read("tool/source-core/documents/Alpha.md");
		expect(alpha).toContain("Alpha rests on [[Beta]] and [[Gamma]].\n\nA line the reader added.\n");
		expect(alpha).not.toContain("(checkout)");
		await until("the change's commit", async () => (await o.git(["log", "-1", "--format=%s", "--", "tool/source-core/documents/Alpha.md"])) === `change: Return ${folder.slice("checkout/".length + 11)}\n`, {
			describe: () => o.git(["log", "--oneline", "-5"]),
		});
		expect(o.errors).toEqual([]);
	});

	it("Checkout asks for the request and starts the librarian in the terminal without Duet", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		expect(await line(palette, "library")).toBe("Gather the pages on a subject");
		await goTo(palette, "library");
		expect(await palette.locator(".almagest-empty").textContent()).toBe("No checkout yet.");
		await palette.locator('button[data-action="checkout"]').click();

		const modal = o.page.locator(".modal", { hasText: "Check out material" });
		await modal.waitFor({ timeout: 10_000 });
		const go = modal.locator("button.mod-cta", { hasText: "Check out" });
		expect(await go.isDisabled()).toBe(true);
		await modal.locator("input.almagest-checkout-input").fill("   ");
		expect(await go.isDisabled()).toBe(true);
		await modal.locator("input.almagest-checkout-input").fill("reinforcement learning");
		expect(await go.isEnabled()).toBe(true);
		await modal.locator("input.almagest-checkout-input").press("Enter");
		await until("the modal to close", async () => (await modal.count()) === 0);

		const command = await terminalCommand(out);
		expect(command).toMatch(TIP_THEN_AGENT);
		expect(command.endsWith(" && claude '/almagest:wiki-checkout Check out the material on: reinforcement learning'")).toBe(true);
		expect(await notices(o)).toContain("Almagest: Duet is not on, so the agent starts in a terminal. The Almagest settings say what Duet needs, or choose the terminal there.");
		expect(o.errors).toEqual([]);
	});

	// Wikify

	const LECTURE = "notes/Lecture.md";
	const LECTURE_TEXT = "# Lecture\n\nGradient descent takes a step size. Momentum speeds it up, and the learning rate matters.\n\nCode such as `{{link:Gradient Descent|gradient descent}}` stays text.\n";

	/** Applies two topics, copies notes/Lecture.md with wikify start, and marks the copy with the CLI, as the agent would. */
	async function wikified(o: ObsidianInstance): Promise<string> {
		const plan = path.join(o.vault, "..", "topics.json");
		await writeFile(
			plan,
			JSON.stringify({
				title: "Add two topics",
				writes: [
					{ op: "create", type: "topic", kind: "concept", title: "Gradient Descent", fields: { description: "Gradient descent." }, body: "## Definition\n\nGradient descent.\n" },
					{ op: "create", type: "topic", kind: "concept", title: "Learning Rate Schedule", fields: { description: "A schedule." }, body: "## Definition\n\nA schedule.\n" },
				],
			}),
		);
		const change = JSON.parse(await o.almagest(["change", "propose", plan, "--json"]));
		await o.almagest(["change", "apply", change.ref.id, "--json"]);
		const { copy } = JSON.parse(await o.almagest(["wikify", "start", LECTURE, "--json"]));
		const marks = path.join(o.vault, "..", "marks.json");
		await writeFile(
			marks,
			JSON.stringify([
				{ phrase: "gradient descent", link: "Gradient Descent" },
				{ phrase: "learning rate", link: "Learning Rate Schedule" },
				{ phrase: "step size", new: "Step Size" },
				{ phrase: "momentum", new: "Momentum" },
			]),
		);
		const { marked } = JSON.parse(await o.almagest(["wikify", "mark", copy, marks, "--json"]));
		expect(marked.missing).toEqual([]);
		expect(await o.read(copy)).toBe(
			"# Lecture\n\n{{link:Gradient Descent|Gradient descent}} takes a {{new:Step Size|step size}}. {{new:Momentum|Momentum}} speeds it up, and the {{link:Learning Rate Schedule|learning rate}} matters.\n\nCode such as `{{link:Gradient Descent|gradient descent}}` stays text.\n",
		);
		return copy;
	}

	const lecture = async (vault: string) => {
		await mkdir(path.join(vault, "notes"), { recursive: true });
		await writeFile(path.join(vault, LECTURE), LECTURE_TEXT);
	};

	/** The bubbles of the active note in live preview, or in reading view. */
	function bubbles(o: ObsidianInstance, mode: "source" | "preview") {
		const view = mode === "source" ? ".markdown-source-view.is-live-preview .cm-content" : ".markdown-reading-view";
		return o.page.locator(`.workspace-leaf.mod-active ${view} .almagest-mark`);
	}

	/** What each bubble shows: its phrase, pill, and buttons. */
	function shown(list: ReturnType<typeof bubbles>) {
		return list.evaluateAll((els) =>
			els.map((el) => ({
				phrase: el.querySelector(".almagest-mark-phrase")?.textContent,
				pill: el.querySelector(".almagest-mark-pill")?.textContent,
				buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
			})),
		);
	}

	const MARKED = [
		{ phrase: "Gradient descent", pill: "→ Gradient Descent", buttons: ["Accept", "Ignore"] },
		{ phrase: "step size", pill: "+ Step Size", buttons: ["Create", "Ignore"] },
		{ phrase: "Momentum", pill: "+ Momentum", buttons: ["Create", "Ignore"] },
		{ phrase: "learning rate", pill: "→ Learning Rate Schedule", buttons: ["Accept", "Ignore"] },
	];

	/** Waits until the file holds text, as the editor saves it. */
	async function saved(o: ObsidianInstance, file: string, text: string): Promise<void> {
		await until(`${file} to hold ${text}`, async () => (await o.read(file)).includes(text), { describe: () => o.read(file) });
	}

	it("shows a bubble for each mark of a wikified copy in live preview and reading view; Accept and Ignore replace the mark", { timeout: 120_000 }, async () => {
		const o = await launch({
			prepare: async (vault) => {
				await lecture(vault);
				await mkdir(path.join(vault, "scratchpad"), { recursive: true });
				await writeFile(path.join(vault, "scratchpad/Plain.md"), "# Plain\n\nA note that is no copy: {{link:Gradient Descent|gradient descent}} stays text.\n");
			},
		});
		const copy = await wikified(o);
		expect(copy).toBe("scratchpad/Lecture · wikified.md");

		// A note that is no wikified copy looks as it always did.
		await open(o, "scratchpad/Plain.md", "source");
		await o.page.locator(".workspace-leaf.mod-active .markdown-source-view .cm-line", { hasText: "stays text" }).waitFor({ timeout: 10_000 });
		expect(await o.page.locator(".almagest-mark").count()).toBe(0);

		await open(o, copy, "source");
		const live = bubbles(o, "source");
		await until("the bubbles in live preview", async () => (await live.count()) === 4, { describe: async () => `bubbles: ${await live.count()}` });
		expect(await shown(live)).toEqual(MARKED);
		expect(await live.evaluateAll((els) => els.map((el) => el.className))).toEqual(["almagest-mark almagest-mark-link", "almagest-mark almagest-mark-new", "almagest-mark almagest-mark-new", "almagest-mark almagest-mark-link"]);
		// A mark in code is text.
		expect(await o.page.locator(".workspace-leaf.mod-active .cm-content .cm-line", { hasText: "Code such as" }).textContent()).toContain("{{link:Gradient Descent|gradient descent}}");
		// The bubble keeps the line's height.
		const heights = await o.page.evaluate(() => {
			const lines = [...document.querySelectorAll<HTMLElement>(".workspace-leaf.mod-active .cm-content .cm-line")];
			const marked = lines.find((l) => l.querySelector(".almagest-mark"))!;
			const plain = lines.find((l) => l.textContent?.startsWith("Code such as"))!;
			const lineHeight = parseFloat(getComputedStyle(plain).lineHeight);
			return { mark: marked.querySelector<HTMLElement>(".almagest-mark")!.getBoundingClientRect().height, lineHeight };
		});
		expect(heights.mark).toBeLessThanOrEqual(heights.lineHeight + 1);

		// The cursor in a mark shows its text, to edit.
		await o.page.evaluate(() => {
			const editor = (window as any).app.workspace.activeEditor.editor;
			editor.focus();
			editor.setCursor(editor.offsetToPos(editor.getValue().indexOf("{{new:Momentum") + 3));
		});
		await until("the raw mark at the cursor", async () => (await live.count()) === 3, { describe: async () => `bubbles: ${await live.count()}` });
		expect(await o.page.locator(".workspace-leaf.mod-active .cm-content").textContent()).toContain("{{new:Momentum|Momentum}}");
		await o.page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setCursor({ line: 0, ch: 0 }));
		await until("the bubble again", async () => (await live.count()) === 4);

		// Accept in live preview: the editor writes the link, and undo takes it back.
		await live.filter({ hasText: "learning rate" }).locator("button", { hasText: "Accept" }).click();
		await saved(o, copy, "the [[Learning Rate Schedule|learning rate]] matters.");
		await until("three bubbles", async () => (await live.count()) === 3);
		await o.page.evaluate(() => (window as any).app.workspace.activeEditor.editor.undo());
		await saved(o, copy, "the {{link:Learning Rate Schedule|learning rate}} matters.");
		await live.filter({ hasText: "learning rate" }).locator("button", { hasText: "Accept" }).click();
		await saved(o, copy, "the [[Learning Rate Schedule|learning rate]] matters.");

		// Ignore: the mark becomes its phrase.
		await live.filter({ hasText: "step size" }).locator("button", { hasText: "Ignore" }).click();
		await saved(o, copy, "takes a step size. ");
		await until("two bubbles", async () => (await live.count()) === 2);

		// Reading view: the same bubbles; Accept writes through the vault.
		await open(o, copy, "preview");
		const read = bubbles(o, "preview");
		await until("the bubbles in reading view", async () => (await read.count()) === 2, { describe: async () => `bubbles: ${await read.count()}` });
		expect(await shown(read)).toEqual([MARKED[0], MARKED[2]]);
		expect(await o.page.locator(".workspace-leaf.mod-active .markdown-reading-view code").textContent()).toBe("{{link:Gradient Descent|gradient descent}}");
		await read.filter({ hasText: "Gradient descent" }).locator("button", { hasText: "Accept" }).click();
		await saved(o, copy, "# Lecture\n\n[[Gradient Descent|Gradient descent]] takes a step size.");
		await until("one bubble in reading view", async () => (await read.count()) === 1, { describe: async () => `bubbles: ${await read.count()}` });
		await read.locator("button", { hasText: "Ignore" }).click();
		await saved(o, copy, "step size. Momentum speeds it up");
		expect(await o.read(copy)).toBe(
			"# Lecture\n\n[[Gradient Descent|Gradient descent]] takes a step size. Momentum speeds it up, and the [[Learning Rate Schedule|learning rate]] matters.\n\nCode such as `{{link:Gradient Descent|gradient descent}}` stays text.\n",
		);
		// The original stays as it was.
		expect(await o.read(LECTURE)).toBe(LECTURE_TEXT);
		expect(o.errors).toEqual([]);
	});

	it("accepts every link mark of a wikified copy with one command, in the editor and on disk", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: lecture });
		const copy = await wikified(o);
		const command = () => o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:accept-link-marks"));
		const available = () => o.page.evaluate(() => (window as any).app.commands.findCommand("almagest:accept-link-marks").checkCallback(true));

		await open(o, LECTURE, "source");
		expect(await available()).toBe(false);

		await open(o, copy, "source");
		await until("the bubbles", async () => (await bubbles(o, "source").count()) === 4);
		expect(await available()).toBe(true);
		await command();
		await saved(o, copy, "[[Gradient Descent|Gradient descent]] takes a {{new:Step Size|step size}}. {{new:Momentum|Momentum}} speeds it up, and the [[Learning Rate Schedule|learning rate]] matters.");
		expect(await notices(o)).toContain("Almagest: accepted 2 link marks.");
		expect(await o.read(copy)).toContain("Code such as `{{link:Gradient Descent|gradient descent}}` stays text.");
		// One step of undo takes both back.
		await o.page.evaluate(() => (window as any).app.workspace.activeEditor.editor.undo());
		await saved(o, copy, "{{link:Gradient Descent|Gradient descent}} takes a");
		expect(await o.read(copy)).toContain("the {{link:Learning Rate Schedule|learning rate}} matters.");

		// In reading view, the command writes the file.
		await open(o, copy, "preview");
		await until("the bubbles in reading view", async () => (await bubbles(o, "preview").count()) === 4);
		await command();
		await saved(o, copy, "[[Gradient Descent|Gradient descent]] takes a {{new:Step Size|step size}}. {{new:Momentum|Momentum}} speeds it up, and the [[Learning Rate Schedule|learning rate]] matters.");
		await until("two bubbles in reading view", async () => (await bubbles(o, "preview").count()) === 2);
		await command();
		await until("the notice", async () => (await notices(o)).includes("Almagest: this note holds no link mark."));
		expect(o.errors).toEqual([]);
	});

	it("a link mark whose title names no note offers Ignore only, and bulk Accept leaves it", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: lecture });
		const copy = await wikified(o);
		await writeFile(path.join(o.vault, copy), (await o.read(copy)) + "\nThe {{link:Gone Topic|gone topic}} stays.\n");
		await open(o, copy, "source");
		const live = bubbles(o, "source");
		await until("the bubbles", async () => (await live.count()) === 5, { describe: async () => `bubbles: ${await live.count()}` });
		const gone = live.filter({ hasText: "→ Gone Topic" });
		expect(await gone.getAttribute("data-state")).toBe("gone");
		expect(await shown(gone)).toEqual([{ phrase: "gone topic", pill: "→ Gone Topic", buttons: ["Ignore"] }]);
		expect(await gone.locator(".almagest-mark-gone").getAttribute("title")).toBe("No note is titled Gone Topic now.");

		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:accept-link-marks"));
		await saved(o, copy, "[[Gradient Descent|Gradient descent]] takes a");
		expect(await notices(o)).toContain("Almagest: accepted 2 link marks. 1 names no note now; Ignore it or fix the title.");
		expect(await o.read(copy)).toContain("The {{link:Gone Topic|gone topic}} stays.");

		await gone.locator("button", { hasText: "Ignore" }).click();
		await saved(o, copy, "The gone topic stays.");
		expect(o.errors).toEqual([]);
	});

	it("Create on a new mark starts a draft work document and its agent; once the topic exists, Link links it", { timeout: 120_000 }, async () => {
		const o = await launch({ prepare: lecture });
		const copy = await wikified(o);
		const out = await stubTerminal(o);
		await open(o, copy, "source");
		const live = bubbles(o, "source");
		await until("the bubbles", async () => (await live.count()) === 4);
		const momentum = live.filter({ hasText: "+ Momentum" });

		await momentum.locator("button", { hasText: "Create" }).click();
		const command = await terminalCommand(out);
		const doc = await workDoc(o, "Draft Momentum");
		expect(doc.kind).toBe("draft");
		expect(doc.title).toMatch(/^\d{4}-\d{2}-\d{2} Draft Momentum$/);
		const message = `/almagest:wiki-edit Draft a topic titled Momentum from [[Lecture · wikified]] and what the wiki holds; give it a why. Your work document is [[${doc.title}]] (${doc.id}): report each step with change progress, and propose into it with change propose and id ${doc.id}.`;
		expect(command).toMatch(TIP_THEN_AGENT);
		expect(command.endsWith(` && claude '${message.replace(/'/g, "'\\''")}'`)).toBe(true);
		expect(await notices(o)).toContain("Almagest: Duet is not on, so the agent starts in a terminal. The Almagest settings say what Duet needs, or choose the terminal there.");

		// The bubble shows drafting while the work document runs and waits for the user.
		await until("drafting", async () => (await momentum.getAttribute("data-state")) === "drafting", { describe: () => momentum.innerHTML() });
		expect(await shown(momentum)).toEqual([{ phrase: "Momentum", pill: "+ Momentum", buttons: ["Ignore"] }]);
		expect(await momentum.locator(".almagest-mark-drafting").textContent()).toBe("drafting");
		expect(await live.filter({ hasText: "+ Step Size" }).getAttribute("data-state")).toBe("new");

		// The agent's proposal, then the user's Approve, as the CLI makes them.
		const plan = path.join(o.vault, "..", "momentum.json");
		await writeFile(
			plan,
			JSON.stringify({
				title: "Draft Momentum",
				writes: [{ op: "create", type: "topic", kind: "concept", title: "Momentum", fields: { description: "Momentum." }, body: "## Definition\n\nMomentum speeds up gradient descent.\n", why: "the lecture names it" }],
			}),
		);
		await o.almagest(["change", "propose", plan, "--id", doc.id, "--json"]);
		await until("the proposed draft", async () => (await status(o, doc.path)).status === "proposed");
		await o.page.waitForTimeout(1000);
		expect(await momentum.getAttribute("data-state")).toBe("drafting");
		await o.almagest(["change", "apply", doc.id, "--json"]);

		await until("Link", async () => (await momentum.getAttribute("data-state")) === "ready", { describe: () => momentum.innerHTML() });
		expect(await shown(momentum)).toEqual([{ phrase: "Momentum", pill: "+ Momentum", buttons: ["Link", "Ignore"] }]);
		await momentum.locator("button", { hasText: "Link" }).click();
		await saved(o, copy, "step size}}. [[Momentum]] speeds it up");
		await until("three bubbles", async () => (await live.count()) === 3);
		expect(o.errors).toEqual([]);
	});

	it("lists the agent sessions on the Agents page as message threads; one that waits counts on the home row, and the closed ones fold away and offer Resume", { timeout: TIMEOUT }, async () => {
		const now = Date.now();
		const session = (id: string, status: string, updated: number, extra: string, body: string, description = "Plan the [[Alpha]] study") =>
			`---\nid: ses-${id}\ntype: session\nharness: claude\nharness_id: ${id}\nstatus: ${status}\nupdated: ${new Date(updated).toISOString()}\n${extra}${description ? `description: ${description}\n` : ""}---\n\n${body}`;
		const o = await launch({
			prepare: async (vault) => {
				await mkdir(path.join(vault, "tool/sessions/2026-10"), { recursive: true });
				await writeFile(path.join(vault, "tool/sessions/2026-10/waits.md"), session("aaaaaa", "waiting", now - 120_000, "", "## Progress\n\n- 2026-10-07: Read the sources.\n- 2026-10-07: Asked which paper comes first.\n"));
				await writeFile(path.join(vault, "tool/sessions/2026-10/works.md"), session("cccccc", "running", now - 10_000, "", "", ""));
				await writeFile(path.join(vault, "tool/sessions/2026-10/closed.md"), session("bbbbbb", "ended", now - 1_200_000, `ended: ${new Date(now - 1_200_000).toISOString()}\n`, "## Progress\n\n- 2026-10-07: Proposed the edits.\n"));
				// The waiting session runs in a Duet conversation, whose note names its id.
				await mkdir(path.join(vault, "Conversations"), { recursive: true });
				await writeFile(path.join(vault, "Conversations/Plan Alpha.md"), "---\nduet: conversation\nagent: claude\nsession: aaaaaa\n---\n\n> [!user]\n> Plan the study.\n");
			},
		});
		// A sync links each session to its conversation, as the plugin's sync after an edit does.
		await o.almagest(["vault", "sync", "--views"]);
		expect(await o.read("tool/sessions/2026-10/waits.md")).toContain("> Duet conversation: [[Plan Alpha]]");
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		await until("the agents line", async () => (await line(palette, "agents")) === "1 needs you · 2 live sessions", { describe: () => palette.innerText() });
		const chip = palette.locator('[data-area="agents"] .almagest-chip');
		expect(await chip.textContent()).toBe("1");
		expect(await chip.getAttribute("data-tone")).toBe("accent");

		await goTo(palette, "agents");
		expect(await tile(palette, "needs you")).toBe("1");
		const thread = (state: string) => palette.locator(`.almagest-thread[data-state="${state}"]`);
		const waits = thread("needs-you");
		expect(await waits.locator(".almagest-thread-title").textContent()).toBe("Plan the Alpha study");
		expect(await waits.locator(".almagest-thread-time").textContent()).toBe("2 min ago");
		expect(await waits.locator(".almagest-thread-preview").textContent()).toBe("Needs you · 2026-10-07: Asked which paper comes first.");
		// An open session runs in its terminal, so it offers no Resume.
		expect(await waits.locator("button").count()).toBe(0);
		// A session with no description yet is untitled, not its document's name; its avatar glows while it works.
		const works = thread("working");
		expect(await works.locator(".almagest-thread-title").textContent()).toBe("Untitled session");
		expect(await works.locator(".almagest-thread-preview").textContent()).toBe("Working");
		const animation = (row: typeof works) => row.locator(".almagest-avatar").evaluate((el) => getComputedStyle(el).animationName);
		expect(await animation(works)).toBe("almagest-glow");
		expect(await animation(waits)).toBe("none");

		// The closed sessions fold away; their head opens them, gray and still.
		const closed = thread("ended");
		expect(await closed.isVisible()).toBe(false);
		await palette.locator(".almagest-fold > summary").click();
		await until("the closed sessions", () => closed.isVisible());
		expect(await closed.locator(".almagest-thread-time").textContent()).toBe("20 min ago");
		expect(await closed.locator(".almagest-thread-preview").textContent()).toBe("Ended · 2026-10-07: Proposed the edits.");
		expect(await closed.getAttribute("class")).toContain("is-closed");
		expect(await animation(closed)).toBe("none");
		const faint = await closed.locator(".almagest-thread-title").evaluate((el) => {
			const probe = document.body.createDiv();
			probe.style.color = "var(--text-faint)";
			const want = getComputedStyle(probe).color;
			probe.remove();
			return getComputedStyle(el).color === want;
		});
		expect(faint).toBe(true);

		// Resume finds no saved conversation for this made-up session, says so, and runs nothing.
		await closed.locator('button[data-action="resume"]').click();
		await until("the notice", async () => (await notices(o)).some((t) => t.includes("no saved conversation")), { describe: async () => JSON.stringify(await notices(o)) });
		expect(existsSync(out)).toBe(false);
		// The fold stays open while the palette draws again.
		await o.page.evaluate(() => (window as any).app.plugins.plugins.almagest.app.workspace.getLeavesOfType("almagest-palette")[0].view.draw());
		expect(await closed.isVisible()).toBe(true);

		// A row opens the session's Duet conversation when it has one, else the session's document.
		const active = () => o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path);
		await until("the conversation's link", async () => {
			await o.page.evaluate(() => void (window as any).app.workspace.getLeavesOfType("almagest-palette")[0].view.refresh());
			await waits.click();
			return (await active()) === "Conversations/Plan Alpha.md";
		}, { describe: active });
		await goTo(palette, "agents");
		await thread("working").click();
		await until("the session to open", async () => (await active()) === "tool/sessions/2026-10/works.md", { describe: active });
		expect(o.errors).toEqual([]);
	});

	it("migrates an 11.0 vault from the palette: it shows what moves, then one button moves it and opens the home", { timeout: TIMEOUT }, async () => {
		const session = "---\nid: ses-cccccc\ntype: session\ncreated: 2026-10-01T09:00:00\nupdated: 2026-10-01T10:00:00\nharness: claude\nharness_id: cccccc\nstatus: ended\n---\n\n## Description\n\nWork.\n";
		const o = await launch({
			// The vault as 11.0 left it: sessions/, source-core/, and trash/ at the root, and a note that links into one.
			prepare: async (vault) => {
				await mkdir(path.join(vault, "tool/sessions/2026-10"), { recursive: true });
				await writeFile(path.join(vault, "tool/sessions/2026-10/2026-10-01 0900 cccccc.md"), session);
				for (const dir of ["sessions", "source-core"]) await rename(path.join(vault, "tool", dir), path.join(vault, dir));
				await rm(path.join(vault, "tool"), { recursive: true });
				const edit = async (file: string, from: string, to: string) => writeFile(path.join(vault, file), (await readFile(path.join(vault, file), "utf8")).replace(from, to));
				await edit("Almagest.md", "\nlayout: 8\n", "\nlayout: 7\n");
				await edit("sessions/Sessions.base", 'file.inFolder("tool/sessions")', 'file.inFolder("sessions")');
				await edit(".obsidian/app.json", '"tool/source-core/originals"', '"source-core/originals"');
				await edit(".obsidian/app.json", '"tool/trash/"', '"trash/"');
				await writeFile(path.join(vault, "scratchpad/Plan.md"), "Read [[sessions/2026-10/2026-10-01 0900 cccccc|the last session]].\n");
			},
		});
		await until("the notice", async () => (await notices(o)).some((t) => t.includes("Open the Almagest palette to migrate the vault")), { describe: async () => JSON.stringify(await notices(o)) });
		await o.page.evaluate(() => (window as any).app.commands.executeCommandById("almagest:open-palette"));
		const palette = o.page.locator(".almagest-palette");
		await until("the migrate page", async () => (await palette.getAttribute("data-page")) === "migrate" && (await palette.locator(".almagest-tile").count()) === 2, { describe: () => palette.innerText() });
		expect(await palette.locator("[data-area]").count()).toBe(0);
		expect(await tile(palette, "files move")).toBe("2");
		expect(await tile(palette, "files change")).toBe("4");
		await palette.locator('button[data-action="migrate"]').click();

		await until("the home", async () => (await palette.getAttribute("data-page")) === "home" && (await palette.locator('[data-area="ingest"]').count()) === 1, { describe: () => palette.innerText() });
		await until("the migrated notice", async () => (await notices(o)).some((t) => t.startsWith("Almagest: migrated the vault in one commit: 2 files moved into tool/.")), { describe: async () => JSON.stringify(await notices(o)) });
		expect((await notices(o)).some((t) => t.includes("Open the Almagest palette to migrate"))).toBe(false);
		expect(await o.read("tool/sessions/2026-10/2026-10-01 0900 cccccc.md")).toBe(session);
		expect(existsSync(path.join(o.vault, "sessions"))).toBe(false);
		expect(await o.read("scratchpad/Plan.md")).toBe("Read [[tool/sessions/2026-10/2026-10-01 0900 cccccc|the last session]].\n");
		expect(frontmatter(await o.read("Almagest.md")).layout).toBe("8");
		expect(await o.git(["log", "-1", "--format=%s"])).toBe("layout: move sessions/, source-core/, and trash/ into tool/\n");
		expect(o.errors).toEqual([]);
	});

	it("Sync the vault on the Wiki health page writes the views", { timeout: TIMEOUT }, async () => {
		const o = await launch();
		const home = path.join(o.vault, "wiki-view/View · Home.md");
		expect(existsSync(home)).toBe(true);
		await rm(home);
		const palette = await openPalette(o);
		await goTo(palette, "health");
		await palette.locator('button[data-action="sync"]').click();
		await until("the views", () => existsSync(home));
		await until("the notice", async () => (await notices(o)).some((t) => t.startsWith("Almagest: ")), { describe: async () => JSON.stringify(await notices(o)) });
		expect(o.errors).toEqual([]);
	});

	it("Wikify this note copies the active note, opens the copy, and starts the agent", { timeout: TIMEOUT }, async () => {
		const o = await launch({ prepare: lecture });
		const out = await stubTerminal(o);
		const palette = await openPalette(o);
		await goTo(palette, "note");
		const button = palette.locator('button[data-action="wikify"]');

		await open(o, "Almagest.md", "source");
		await until("Wikify to turn off", async () => (await button.isDisabled()) && (await button.getAttribute("title")) === "Wikify takes a note of yours, not Almagest.md.", {
			describe: () => palette.innerText(),
		});

		await open(o, LECTURE, "source");
		await until("Wikify to turn on", async () => await button.isEnabled(), { describe: () => palette.innerText() });
		expect(await button.textContent()).toBe("Wikify this note");
		await button.click();

		const command = await terminalCommand(out);
		const copy = "scratchpad/Lecture · wikified.md";
		expect(await o.read(copy)).toBe(LECTURE_TEXT);
		expect(await o.read(LECTURE)).toBe(LECTURE_TEXT);
		expect(command).toMatch(TIP_THEN_AGENT);
		expect(command.endsWith(" && claude '/almagest:wiki-wikify Wikify [[Lecture · wikified]]: mark what the wiki knows and the subjects worth a topic, with wikify mark.'")).toBe(true);
		await until("the copy to open", async () => (await o.page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)) === copy);
		expect(o.errors).toEqual([]);
	});
});
