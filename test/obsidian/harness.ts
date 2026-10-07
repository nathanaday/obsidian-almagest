import { type ChildProcess, execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";

const OBSIDIAN = process.env.OBSIDIAN_BINARY ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
/** Obsidian's own data folder, where it keeps the app updates that it downloaded. */
const OBSIDIAN_DATA = process.env.OBSIDIAN_DATA ?? path.join(homedir(), "Library/Application Support/obsidian");
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_BUILD = path.join(REPO, "dist");
/** A checkout of the almagest repository, which holds the binary the plugin runs. */
const ALMAGEST_SRC = process.env.ALMAGEST_SRC ?? path.join(REPO, "../almagest");
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

export interface AlmagestBinary {
	path: string;
	remove(): Promise<void>;
}

/** Builds almagest from the checkout in ALMAGEST_SRC (by default ../almagest) into a temporary folder. */
export async function buildAlmagest(): Promise<AlmagestBinary> {
	await stat(path.join(ALMAGEST_SRC, "cmd/almagest")).catch(() => {
		throw new Error(`no almagest checkout at ${ALMAGEST_SRC}; clone github.com/nathanaday/almagest beside this repository, or set ALMAGEST_SRC`);
	});
	const dir = await mkdtemp(path.join(tmpdir(), "almagest-e2e-bin-"));
	const bin = path.join(dir, "almagest");
	await run("go", ["build", "-o", bin, "./cmd/almagest"], { cwd: ALMAGEST_SRC });
	return { path: bin, remove: () => rm(dir, { recursive: true, force: true }) };
}

export interface ObsidianInstance {
	/** The vault window. It changes when Obsidian restarts. */
	page: Page;
	vault: string;
	/** The console errors and uncaught exceptions of the vault window since the plugin loaded. */
	errors: string[];
	/** Runs almagest in the vault, as the plugin does, and returns its output. */
	almagest(args: string[]): Promise<string>;
	git(args: string[]): Promise<string>;
	read(file: string): Promise<string>;
	/**
	 * Quits Obsidian and starts it again with the same profile, so the plugin loads at
	 * Obsidian's start, as it does for a user. `between` runs while Obsidian is closed.
	 * `freshIndex` deletes Obsidian's metadata index, as for a vault it has not opened yet.
	 */
	restart(options?: { between?: () => Promise<void>; freshIndex?: boolean }): Promise<void>;
	/**
	 * Opens the settings at a plugin's tab and returns the page that shows it: a separate
	 * window in Obsidian 1.14, the vault window's modal before.
	 */
	settings(tab: string): Promise<Page>;
	close(): Promise<void>;
}

export interface LaunchOptions {
	/** The plugin's data.json, over binaryPath. */
	pluginData?: Record<string, unknown>;
	/** Changes the new vault before Obsidian opens it. The harness commits the result. */
	prepare?: (vault: string) => Promise<void>;
}

/**
 * Makes a vault with `almagest vault init`, installs the plugin from obsidian/dist,
 * and opens the vault in a separate Obsidian with its own profile. ALMAGEST_HOME points at a
 * temporary folder. The user's own Obsidian, ~/.almagest, and vaults are not touched.
 */
export async function launchObsidian(bin: AlmagestBinary, { pluginData, prepare }: LaunchOptions = {}): Promise<ObsidianInstance> {
	await stat(path.join(PLUGIN_BUILD, "main.js")).catch(() => {
		throw new Error("dist has no build. Run npm run test:obsidian, which builds it first.");
	});
	const root = await mkdtemp(path.join(tmpdir(), "almagest-e2e-"));
	const vault = path.join(root, "vault");
	const profile = path.join(root, "profile");
	const home = path.join(root, "almagest-home");
	const pluginDir = path.join(vault, ".obsidian/plugins/almagest");
	const env: NodeJS.ProcessEnv = { ...process.env, ALMAGEST_HOME: home };
	delete env.ALMAGEST_VAULT;

	const almagest = (args: string[]) => run(bin.path, [...args, "--vault", vault], { cwd: vault, env });
	const git = (args: string[]) => run("git", args, { cwd: vault, env });

	let app: Running | undefined;
	try {
		await mkdir(home);
		await run(bin.path, ["vault", "init", "--path", vault, "--name", "Test"], { cwd: root, env });
		// The test installs the plugin under test, as the community directory does for a user.
		await mkdir(pluginDir, { recursive: true });
		for (const file of PLUGIN_FILES) await copyFile(path.join(PLUGIN_BUILD, file), path.join(pluginDir, file));
		await writeFile(path.join(pluginDir, "data.json"), JSON.stringify({ binaryPath: bin.path, ...pluginData }, null, 2));
		await prepare?.(vault);
		await git(["add", "-A"]);
		await git(["commit", "-q", "-m", "test: install the plugin under test"]);

		await mkdir(profile);
		await copyAppUpdate(profile);
		await writeFile(
			path.join(profile, "obsidian.json"),
			JSON.stringify({ vaults: { almagesttest0000001: { path: vault, ts: Date.now(), open: true } } }),
		);

		app = await start(profile, env);
		await app.page.evaluate(async () => {
			const plugins = (window as any).app.plugins;
			// The plugin is not in community-plugins.json yet, so turning on community plugins loads nothing,
			// and enablePluginAndSave loads it exactly once.
			plugins.setEnable(true);
			await plugins.enablePluginAndSave("almagest");
		});
		await pluginLoaded(app);
		// Obsidian saves its configuration a moment later; a restart needs it on disk.
		const enabled = path.join(vault, ".obsidian/community-plugins.json");
		await until("Obsidian to save the enabled plugin", async () => (await readFile(enabled, "utf8").catch(() => "")).includes('"almagest"'));
		await closeSettings(app.browser, app.page);
	} catch (error) {
		await app?.kill();
		await rm(root, { recursive: true, force: true });
		throw error;
	}

	let running: Running = app;
	const instance: ObsidianInstance = {
		page: running.page,
		vault,
		errors: running.errors,
		almagest,
		git,
		read: (file) => readFile(path.join(vault, file), "utf8"),
		async restart({ between, freshIndex = false } = {}) {
			await running.quit();
			if (freshIndex) await rm(path.join(profile, "IndexedDB"), { recursive: true, force: true });
			await between?.();
			running = await start(profile, env);
			instance.page = running.page;
			instance.errors = running.errors;
			await pluginLoaded(running);
		},
		async settings(tab) {
			await running.page.evaluate((id) => {
				const setting = (window as any).app.setting;
				setting.open();
				setting.openTabById(id);
			}, tab);
			// A pop-out window starts as about:blank, and the vault window fills it.
			return until("the settings", async () => {
				for (const p of running.browser.contexts().flatMap((c) => c.pages())) {
					if (p !== running.page && (await p.$(".vertical-tab-content"))) return p;
				}
				return (await running.page.$(".modal.mod-settings")) ? running.page : undefined;
			}, {
				describe: async () =>
					`pages: ${running.browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(", ")}; modals: ${await running.page.evaluate(() => [...document.querySelectorAll(".modal")].map((m) => m.className).join(" | "))}; setting: ${await running.page.evaluate(() => typeof (window as any).app.setting?.open)}`,
			});
		},
		async close() {
			await running.kill();
			// A sync the plugin started can still write in the vault for a moment.
			await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		},
	};
	return instance;
}

interface Running {
	browser: Browser;
	page: Page;
	errors: string[];
	/** Quits as a user does, so the profile keeps what Obsidian saved. */
	quit(): Promise<void>;
	/** Stops Obsidian at once, for a profile that the harness deletes next. */
	kill(): Promise<void>;
}

/** The Obsidian processes that run now. A test run that ends early kills them. */
const children = new Set<ChildProcess>();
process.once("exit", () => {
	for (const child of children) child.kill("SIGKILL");
});

/** Starts Obsidian with the profile and waits for the vault window's layout. */
async function start(profile: string, env: NodeJS.ProcessEnv): Promise<Running> {
	const port = await freePort();
	const child = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: "ignore", env });
	children.add(child);
	child.once("exit", () => children.delete(child));
	let browser: Browser | undefined;
	const quit = async () => {
		await browser?.close().catch(() => undefined);
		await stop(child, "SIGTERM");
	};
	const kill = async () => {
		await browser?.close().catch(() => undefined);
		await stop(child, "SIGKILL");
	};
	try {
		browser = await connect(port);
		const page = await vaultPage(browser);
		const errors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(msg.text());
		});
		page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
		await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, undefined, { timeout: 30_000 });
		return { browser, page, errors, quit, kill };
	} catch (error) {
		await kill();
		throw error;
	}
}

async function pluginLoaded({ page, errors }: Running): Promise<void> {
	try {
		await page.waitForFunction(() => !!(window as any).app.plugins.plugins.almagest?._loaded, undefined, { timeout: 10_000 });
	} catch {
		throw new Error(`The Almagest plugin did not load in 10 seconds. Console errors:\n${errors.join("\n") || "none"}`);
	}
}

/**
 * Turning on community plugins opens the settings a moment later: a modal in older versions,
 * a separate window in Obsidian 1.14. Either one would take the keyboard.
 */
async function closeSettings(browser: Browser, page: Page): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (otherWindows(browser, page).length > 0 || (await page.$(".modal-container"))) break;
		await page.waitForTimeout(100);
	}
	for (const other of otherWindows(browser, page)) await other.close().catch(() => undefined);
	for (let attempt = 0; attempt < 5 && (await page.$(".modal-container")); attempt++) {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);
	}
	if (await page.$(".modal-container")) throw new Error("A dialog stayed open in Obsidian.");
}

function otherWindows(browser: Browser, vault: Page): Page[] {
	return browser
		.contexts()
		.flatMap((c) => c.pages())
		.filter((p) => p !== vault && p.url().startsWith("app://obsidian.md/"));
}

/**
 * Waits until `check` returns a value other than undefined or false, and returns it. On a
 * timeout, the error names what it waited for and what `describe` gives.
 */
export async function until<T>(
	what: string,
	check: () => Promise<T | undefined | false> | T | undefined | false,
	{ timeout = 15_000, describe }: { timeout?: number; describe?: () => Promise<string> | string } = {},
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await check();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) {
			const last = describe ? `\n${await describe()}` : "";
			throw new Error(`Timed out after ${timeout} ms waiting for ${what}.${last}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The scalar fields of a note's frontmatter, as written. */
export function frontmatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	const fields: Record<string, string> = {};
	for (const line of match?.[1]?.split("\n") ?? []) {
		const field = /^([\w-]+):\s*(.*)$/.exec(line);
		if (field) fields[field[1]!] = field[2]!.replace(/^"(.*)"$/, "$1");
	}
	return fields;
}

/**
 * Obsidian runs the newest app update in its profile folder. A new profile has none, so it would run the
 * installer's older version. A copy of the installed update makes the test run the version that the user runs.
 * Obsidian ignores a symbolic link there.
 */
async function copyAppUpdate(profile: string): Promise<void> {
	const updates = (await readdir(OBSIDIAN_DATA).catch(() => [] as string[])).filter((name) => /^obsidian-[\d.]+\.asar$/.test(name));
	const version = (name: string) => name.slice("obsidian-".length, -".asar".length).split(".").map(Number);
	const newest = updates
		.sort((a, b) => {
			const [x, y] = [version(a), version(b)];
			for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
			return 0;
		})
		.at(-1);
	if (newest) await copyFile(path.join(OBSIDIAN_DATA, newest), path.join(profile, newest));
}

function run(program: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(program, args, { ...options, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${path.basename(program)} ${args.join(" ")} failed: ${stderr || error.message}`));
			else resolve(stdout);
		});
	});
}

async function connect(port: number): Promise<Browser> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}
}

async function vaultPage(browser: Browser): Promise<Page> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		for (const context of browser.contexts()) {
			for (const page of context.pages()) if (page.url().startsWith("app://obsidian.md/index.html")) return page;
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error("Obsidian did not open the vault window.");
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

/**
 * SIGTERM lets Electron quit cleanly, so the profile keeps what Obsidian saved. Obsidian
 * ignores SIGTERM for about a second after it starts; SIGKILL follows after 5 seconds.
 */
async function stop(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
	const running = () => child.exitCode === null && child.signalCode === null;
	if (!running()) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill(signal);
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
	if (running()) {
		child.kill("SIGKILL");
		await exited;
	}
}
