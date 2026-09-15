/**
 * PiAstra vendored-baseline tests for the vendored pi-atelier fork.
 * Uses only node:test and node: builtins — no upstream dev dependencies
 * (vitest/typescript/etc.) are installed.
 *
 * Run: node --test extensions/pi-atelier/tests/baseline.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("pi-atelier vendored baseline", () => {
	it("package.json declares the expected upstream manifest", async () => {
		const pkg = JSON.parse(await readFile(path.join(pkgRoot, "package.json"), "utf8"));
		assert.equal(pkg.name, "pi-atelier");
		assert.equal(pkg.version, "0.10.1");
		assert.equal(pkg.license, "MIT");
		assert.equal(pkg.type, "module");
		assert.deepEqual(pkg.pi.extensions, ["./extensions/index.ts"]);
		assert.ok(pkg.keywords.includes("pi-package"));
	});

	it("manifest runtime entry exists and is nonempty source", async () => {
		const pkg = JSON.parse(await readFile(path.join(pkgRoot, "package.json"), "utf8"));
		for (const entry of pkg.pi.extensions) {
			const p = path.join(pkgRoot, entry);
			await access(p, constants.R_OK);
			const text = await readFile(p, "utf8");
			assert.ok(text.trim().length > 0, `${entry} is empty`);
		}
	});

	it("LICENSE is present and is the MIT license", async () => {
		const lic = await readFile(path.join(pkgRoot, "LICENSE"), "utf8");
		assert.match(lic, /MIT License/);
		assert.match(lic, /Copyright/);
	});

	it("shipped metadata files are present", async () => {
		for (const f of ["README.md", "CHANGELOG.md", "package.json", "LICENSE"]) {
			await access(path.join(pkgRoot, f), constants.R_OK);
		}
	});

	it("no runtime dependencies are required (peerDependencies only)", async () => {
		const pkg = JSON.parse(await readFile(path.join(pkgRoot, "package.json"), "utf8"));
		assert.ok(
			!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
			"runtime code should not require npm dependencies beyond pi peers",
		);
		assert.ok(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]);
		assert.ok(pkg.peerDependencies?.["@earendil-works/pi-tui"]);
	});

	it("all relative runtime imports resolve to existing files", async () => {
		const roots = ["src", "extensions"];
		const checked = new Set();
		for (const root of roots) {
			const dir = path.join(pkgRoot, root);
			for (const f of await (await import("node:fs/promises")).readdir(dir)) {
				if (!/\.(ts|mts|js|mjs)$/.test(f)) continue;
				const file = path.join(dir, f);
				const text = await readFile(file, "utf8");
				const imports = [
					...text.matchAll(/from\s+["']([^"']+)["']/g),
					...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
				].map((m) => m[1]);
				for (const spec of imports) {
					if (spec.startsWith("node:")) continue;
					if (!spec.startsWith(".") && !spec.startsWith("@earendil-works/")) {
						continue; // package-style spec, checked above
					}
					if (!spec.startsWith(".")) continue; // peers, checked above
					const resolved = path.resolve(path.dirname(file), spec);
					// TypeScript ESM style: source "./x.js" maps to "./x.ts" on disk.
					let target = resolved;
					try {
						await access(resolved, constants.R_OK);
					} catch {
						target = resolved.replace(/\.m?js$/, ".ts");
						await access(target, constants.R_OK);
					}
					checked.add(path.relative(pkgRoot, target));
				}
			}
		}
		assert.ok(checked.size > 0, "expected at least one internal import");
	});
});
