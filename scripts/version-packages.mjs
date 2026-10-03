#!/usr/bin/env node
// The release workflow's version step: `changeset version`, then the peer range
// changesets leaves alone, then the lockfile.
//
// @vivari/react re-exports @vivari/core's types, so a react release can need the
// core it ships with: 1.1.0 re-exports `ConnectionEvent`, which core 1.0.3 lacks.
// changesets keeps a peer range that still matches (the alternative,
// onlyUpdatePeerDependentsWhenOutOfRange off, answers every core minor with a react
// MAJOR), so the floor is moved here, to the version the two release under.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

run("npx", ["changeset", "version"]);

const core = JSON.parse(readFileSync(new URL("packages/core/package.json", root), "utf8"));
const reactUrl = new URL("packages/react/package.json", root);
const react = JSON.parse(readFileSync(reactUrl, "utf8"));
const range = `^${core.version}`;
let changed = false;
for (const field of ["peerDependencies", "devDependencies"]) {
  if (react[field]?.["@vivari/core"] && react[field]["@vivari/core"] !== range) {
    react[field]["@vivari/core"] = range;
    changed = true;
  }
}
if (changed) {
  writeFileSync(reactUrl, JSON.stringify(react, null, 2) + "\n");
  console.log(`@vivari/react: @vivari/core -> ${range}`);
}

// Against the public registry on purpose: a mirror's URLs would land in every
// `resolved` field, and spike-ci-tiers fails a lock that has them.
run("npm", [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=https://registry.npmjs.org",
]);