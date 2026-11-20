/**
 * Links the Pi host packages this package declares as peerDependencies into
 * ./node_modules so `npm run smoke` / `npm run detach-check` can import the
 * extension without a network install.
 *
 *   node tests/link-host.mjs [path-to-pi-coding-agent]
 *
 * Default target: the globally installed @earendil-works/pi-coding-agent.
 * Plain `npm install` (which pulls the peers) makes this unnecessary.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
	encoding: "utf8",
	// Windows cannot exec a .cmd without a shell.
	shell: process.platform === "win32",
}).trim();
const target = process.argv[2] ?? join(npmRoot, "@earendil-works", "pi-coding-agent");

if (!existsSync(target)) {
	console.error(`pi-coding-agent not found at ${target}\nPass the path explicitly or run npm install.`);
	process.exit(1);
}
// pi's own node_modules carries its bundled dependencies, including typebox and
// the other @earendil-works packages it re-exports.
const hostModules = join(target, "node_modules");
if (!existsSync(hostModules)) {
	console.error(`No node_modules next to ${target}; run npm install in the package that should provide peers.`);
	process.exit(1);
}

const link = (from, to) => {
	rmSync(to, { force: true, recursive: true });
	symlinkSync(from, to, "junction");
};

const modulesDir = join(repoRoot, "node_modules");
mkdirSync(join(modulesDir, "@earendil-works"), { recursive: true });

const { readdirSync, statSync } = await import("node:fs");
for (const entry of readdirSync(hostModules)) {
	if (entry === "@earendil-works" || entry.startsWith(".")) continue;
	link(join(hostModules, entry), join(modulesDir, entry));
}
for (const entry of readdirSync(join(hostModules, "@earendil-works"))) {
	if (entry === "pi-coding-agent") continue;
	link(join(hostModules, "@earendil-works", entry), join(modulesDir, "@earendil-works", entry));
}
link(target, join(modulesDir, "@earendil-works", "pi-coding-agent"));

// The host package must agree with what the links resolve to.
if (!statSync(join(modulesDir, "typebox")).isDirectory()) {
	console.error("typebox did not resolve; check the host install.");
	process.exit(1);
}
console.log(`Linked host packages from ${target} into ${modulesDir}`);