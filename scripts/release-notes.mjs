#!/usr/bin/env node
// Prints the body of the GitHub release for one SDK version, built from the
// CHANGELOG.md sections changesets wrote for it.
// Usage: node scripts/release-notes.mjs 1.2.3 [commit]
//
// `commit` is the one the release is cut from (default HEAD); the hosted files are
// compared up to it. The previous release is the highest `v*` tag below the version,
// so run it in a checkout that has the tags (the release workflow fetches with
// `fetch-depth: 0`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = process.argv[2];
const ref = process.argv[3] || "HEAD";
if (!version) {
  console.error("usage: node scripts/release-notes.mjs <version> [commit]");
  process.exit(2);
}

const root = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const PACKAGES = [
  { name: "@vivari/core", dir: "packages/core" },
  { name: "@vivari/react", dir: "packages/react" },
];

// Files an embedder hosts on their own origin; a release that changes them needs a
// redeploy as well as an `npm install`.
const HOSTED_FILES = [
  "packages/studio/public/sw.js",
  "packages/studio/public/__vv-bridge.html",
  "packages/studio/public/__vv-preview-boot.html",
];

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = JSON.parse(read("packages/core/package.json")).repository.url;
  return /github\.com[/:](.+?)(?:\.git)?$/.exec(url)[1];
}
const repo = repository();
const server = process.env.GITHUB_SERVER_URL || "https://github.com";

function section(pkg) {
  const lines = read(`${pkg.dir}/CHANGELOG.md`).split("\n");
  const start = lines.findIndex((line) => /^##\s+\[?v?([^\s\]]+)/.exec(line)?.[1] === version);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  const notes = lines.slice(start + 1, end).join("\n").trim();
  // Links relative to the package directory would resolve against the releases page.
  const base = `${server}/${repo}/blob/v${version}/${pkg.dir}/`;
  return notes.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, `](${base}$1)`);
}

// A fixed-group release bumps every package; one with nothing of its own to say
// gets "No changes" or only an "Updated dependencies" list.
function saysSomething(notes) {
  if (!notes || /^No changes\b/.test(notes)) return false;
  const bullets = notes.split("\n").filter((line) => /^- /.test(line));
  return bullets.some((line) => !/^- Updated dependencies\b/.test(line));
}

// Semver precedence, build metadata aside: a prerelease sorts below its release, and
// its dot-separated identifiers compare numerically when both are numbers.
function parse(v) {
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  return { parts: core.split(".").map(Number), pre: dash === -1 ? null : v.slice(dash + 1).split(".") };
}
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// A release is compared with the release before it, so its notes cover everything an
// embedder on that release gets; a prerelease, with whatever came before it.
function previousTag() {
  const stable = !version.includes("-");
  const tags = git("tag", "--list", "v*")
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+/.test(t) && (!stable || !t.includes("-")));
  const older = tags.filter((t) => compare(t.slice(1), version) < 0);
  older.sort((a, b) => compare(b.slice(1), a.slice(1)));
  return older[0] ?? null;
}

function changedHostedFiles(since) {
  if (!since) return [];
  return git("diff", "--name-only", since, ref, "--", ...HOSTED_FILES).split("\n").filter(Boolean);
}

const sections = PACKAGES.map((pkg) => ({ ...pkg, notes: section(pkg) }));
const core = sections[0];
if (!core.notes) {
  console.error(`${core.dir}/CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}

const tag = version.includes("-") ? "next" : "latest";
const prev = previousTag();
const out = [];

for (const pkg of sections) {
  if (pkg !== core && !saysSomething(pkg.notes)) continue;
  out.push(`## \`${pkg.name}\``, "", pkg.notes, "");
}

const changed = changedHostedFiles(prev);
if (changed.length > 0) {
  const names = changed.map((f) => `\`${f.slice(f.lastIndexOf("/") + 1)}\``).join(", ");
  out.push(
    "## Upgrading",
    "",
    `This release changes ${names}, which embedders host on their own origin. After updating the packages:`,
    "",
  );
  if (changed.some((f) => f.endsWith("/sw.js"))) {
    out.push(
      "- If you serve the preview Service Worker yourself, copy " +
        "`node_modules/@vivari/core/dist/assets/sw.js` there again. Browsers keep running " +
        "the old one until it is replaced.",
    );
  }
  if (changed.some((f) => !f.endsWith("/sw.js"))) {
    out.push(
      "- If you deploy a separate preview origin (modes B and C), redeploy it so its " +
        "`__vv-bridge.html` and `__vv-preview-boot.html` match this version.",
    );
  }
  out.push("");
}

out.push(
  "## Install",
  "",
  "```sh",
  `npm install ${PACKAGES.map((p) => `${p.name}@${version}`).join(" ")}`,
  "```",
  "",
  PACKAGES.map((p) => `[\`${p.name}@${version}\`](https://www.npmjs.com/package/${p.name}/v/${version})`).join(
    " · ",
  ) + ` on npm, dist-tag \`${tag}\`, published with provenance.`,
  "",
);

out.push(
  prev
    ? `**Full Changelog**: ${server}/${repo}/compare/${prev}...v${version}`
    : `**Full Changelog**: ${server}/${repo}/commits/v${version}`,
);

console.log(out.join("\n"));