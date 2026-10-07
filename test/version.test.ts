import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// The release workflow publishes manifest.json's version; every other file must agree.
test("manifest.json, package.json, package-lock.json, and versions.json name one version", () => {
	const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
	const manifest = read("manifest.json");
	const version = manifest.version as string;
	assert.match(version, /^\d+\.\d+\.\d+$/, "a release tag has no v in front");
	assert.equal(read("package.json").version, version);
	const lock = read("package-lock.json");
	assert.equal(lock.version, version);
	assert.equal(lock.packages[""].version, version);
	assert.equal(read("versions.json")[version], manifest.minAppVersion, "versions.json maps the version to its minAppVersion");
});
