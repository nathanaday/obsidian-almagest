import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
		expect(await o.page.evaluate(() => (window as any).app.plugins.plugins.atlas.manifest.version)).toBe("10.0.0");

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

		const widget = o.page.locator(".atlas-change");
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

		const widget = o.page.locator(".markdown-reading-view .atlas-change");
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
});
