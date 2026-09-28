import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const mode = process.argv[2] ?? "dev";

const external = [
  "obsidian",
  "electron",
  "@codemirror/*",
  "@lezer/*",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

if (mode === "test") {
  rmSync("build-test", { recursive: true, force: true });
  const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
  await esbuild.build({
    entryPoints: tests.map((f) => `test/${f}`),
    outdir: "build-test",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    external,
    logLevel: "info",
  });
} else {
  mkdirSync("dist", { recursive: true });
  const copy = () => {
    copyFileSync("manifest.json", "dist/manifest.json");
    copyFileSync("styles.css", "dist/styles.css");
  };
  const options = {
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.js",
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2022",
    external,
    sourcemap: mode === "production" ? false : "inline",
    minify: false,
    treeShaking: true,
    logLevel: "info",
    plugins: [{ name: "copy", setup: (b) => b.onEnd(copy) }],
  };
  if (mode === "production") {
    await esbuild.build(options);
  } else {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
}
