// Sets the plugin's version in every file that holds it: manifest.json, package.json,
// package-lock.json, and versions.json (the version and the minAppVersion it needs).
// Usage: npm run set-version 11.0.2
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
	console.error("Usage: npm run set-version <major.minor.patch>, such as 11.0.2 (no v in front).");
	process.exit(1);
}
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n");

const manifest = read("manifest.json");
manifest.version = version;
write("manifest.json", manifest);

const pkg = read("package.json");
pkg.version = version;
write("package.json", pkg);

const lock = read("package-lock.json");
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
write("package-lock.json", lock);

const versions = read("versions.json");
versions[version] = manifest.minAppVersion;
write("versions.json", versions);

console.log(`Set ${version} (needs Obsidian ${manifest.minAppVersion}). Merge it into main through a pull request from preview, and the release follows.`);
