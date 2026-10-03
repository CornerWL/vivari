// Spike (OFFLINE, no kernel, no Wasm): the preview Service Worker mirrors the kernel
// host's Document-Isolation-Policy onto preview documents (why: ARCHITECTURE.md §8.3).
// Drives the real `sw.js` under `vm`, like spike-sw-routing.mjs, with a stub kernel
// sink so the real handlePreview builds the response.
//
// Gates:
//   1. Nothing learned: a preview carries no Document-Isolation-Policy (today's behaviour).
//   2. A host that sends none: the probe is a HEAD to the host's URL, and still none.
//   3. A host that sends one: the preview carries the same value, reporting parameters
//      dropped; an unknown value mirrors nothing.
//   4. A preview requested while the probe is in flight waits for it.
//   5. A failed probe keeps the last known policy and is retried; a good one is not repeated.
//   6. A revived SW (fresh globals, same Cache Storage) keeps the policy.
//   7. The connecting page and the bad-URL page carry it too.
//   8. Only documents are stamped: a subresource carries none.
//   9. A redirected probe (an expired session's login page) is a failed probe.
//  10. The probe drops the page URL's query and fragment (one-time tokens).
//  11. A policy the host declares is used without a probe; an invalid one is ignored.
//  12. A preview served to a cross-origin IDE (modes B/C) carries none.
//  13. Overlapping announcements: the last one wins, in memory and in Cache Storage.
//
//   run:  node scripts/spike-sw-isolation-policy.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SRC = path.join(ROOT, "packages/studio/public/sw.js");
const ORIGIN = "http://localhost:5173";
const HOST_URL = `${ORIGIN}/embed/`;
const PREVIEW_URL = `${ORIGIN}/preview/3000/`;

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failed++;
}

function memoryCacheStorage() {
  const entries = new Map();
  const cache = {
    match: async (key) => entries.get(String(key))?.clone(),
    put: async (key, res) => void entries.set(String(key), res.clone()),
    keys: async () => [],
    delete: async (key) => entries.delete(String(key)),
  };
  return { open: async () => cache, keys: async () => [], match: cache.match, delete: async () => true };
}

// Answers for the SW's HEAD probe, each `(init) => Response | Promise<Response>`.
const noPolicy = () => new Response(null, { status: 200 });
const withPolicy = (value) => () =>
  new Response(null, { status: 200, headers: { "Document-Isolation-Policy": value } });
const status = (code) => () => new Response(null, { status: code });
const unreachable = () => Promise.reject(new TypeError("Failed to fetch"));
// A 302 to a login page that sends no policy. Followed, fetch hands back that page's 200;
// with `redirect: "manual"` it hands back an opaque redirect, which is never `ok`.
const redirectsToLogin = (init) =>
  init?.redirect === "manual"
    ? { ok: false, status: 0, type: "opaqueredirect", redirected: false, headers: new Headers() }
    : { ok: true, status: 200, type: "basic", redirected: true, headers: new Headers() };

function loadSw({ caches = memoryCacheStorage(), answer = noPolicy } = {}) {
  const probes = [];
  const listeners = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    URL, Response, Request, Headers, MessageChannel, TextEncoder, TextDecoder, AbortSignal,
    setTimeout, clearTimeout, atob, btoa,
    async fetch(input, init) {
      probes.push({ url: String(input), method: init?.method, redirect: init?.redirect });
      return ctx.__answer(init);
    },
    caches,
  };
  ctx.self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn), undefined),
    clients: { get: async () => undefined, matchAll: async () => [], claim: async () => {} },
    registration: { scope: `${ORIGIN}/` },
    skipWaiting: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_SRC, "utf8"), ctx, { filename: "packages/studio/public/sw.js" });
  ctx.__answer = answer;
  ctx.__probes = probes;
  ctx.__listeners = listeners;
  // A same-origin kernel that answers every preview request with a plain page.
  ctx.resolveKernelSink = async () => ({
    cross: false,
    post: (_msg, transfer) => {
      transfer[0].postMessage({ status: 200, headers: { "content-type": "text/plain" }, body: "hi" });
      transfer[0].close();
    },
  });
  return ctx;
}

// The bridge's `vv-kernel-host` announcement, from a client at `url`, with any extra
// message fields (the declared `documentIsolationPolicy`).
async function announce(ctx, url = HOST_URL, extra = {}) {
  const pending = [];
  const event = {
    data: { type: "vv-kernel-host", ...extra },
    source: { id: "host-1", url },
    ports: [],
    waitUntil: (p) => pending.push(p),
  };
  for (const fn of ctx.__listeners.message) fn(event);
  await Promise.all(pending);
}

// A preview request, a document navigation unless `mode` says otherwise.
async function previewPolicy(ctx, { mode = "navigate", port = 3000 } = {}) {
  const request = { url: PREVIEW_URL, mode, method: "GET", headers: new Headers() };
  const res = await ctx.handlePreview({ request, clientId: "", resultingClientId: "" }, port, "/", false);
  return res.headers.get("Document-Isolation-Policy");
}

console.log("\n1. nothing learned: no header, as before");
{
  const ctx = loadSw();
  ok((await previewPolicy(ctx)) === null, "a preview carries no Document-Isolation-Policy");
}

console.log("\n2. a host without the header");
{
  const ctx = loadSw();
  await announce(ctx);
  ok(ctx.__probes.length === 1 && ctx.__probes[0].method === "HEAD", "the SW probes the host once, with HEAD");
  ok(ctx.__probes[0]?.url === HOST_URL, "the probe goes to the announcing client's URL");
  ok((await previewPolicy(ctx)) === null, "the preview still carries none");
}

console.log("\n3. a host with the header");
for (const [header, expected] of [
  ["isolate-and-require-corp", "isolate-and-require-corp"],
  ["isolate-and-credentialless", "isolate-and-credentialless"],
  ['isolate-and-credentialless; report-to="dip"', "isolate-and-credentialless"],
  ["none", null],
  ["isolate-everything", null],
]) {
  const ctx = loadSw({ answer: withPolicy(header) });
  await announce(ctx);
  ok((await previewPolicy(ctx)) === expected, `'${header}' mirrors ${expected ?? "nothing"}`);
}

console.log("\n4. a preview racing the probe waits for it");
{
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const ctx = loadSw({ answer: () => gate.then(withPolicy("isolate-and-require-corp")) });
  const announced = announce(ctx);
  const policy = previewPolicy(ctx);
  open();
  await announced;
  ok((await policy) === "isolate-and-require-corp", "the preview requested mid-probe gets the header");
}

console.log("\n5. a failed probe keeps what was known");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx);
  await announce(ctx);
  ok(ctx.__probes.length === 1, "a re-announcement from the same URL is not probed again");
  for (const [name, failure] of [["unreachable", unreachable], ["405", status(405)], ["500", status(500)]]) {
    ctx.__answer = failure;
    const before = ctx.__probes.length;
    await announce(ctx, `${ORIGIN}/${name}/`);
    ok(
      ctx.__probes.length === before + 1 && (await previewPolicy(ctx)) === "isolate-and-require-corp",
      `a probe answering ${name} keeps it`,
    );
  }
  ctx.__answer = unreachable;
  await announce(ctx, `${ORIGIN}/retry/`);
  const probed = ctx.__probes.length;
  ctx.__answer = withPolicy("isolate-and-credentialless");
  await announce(ctx, `${ORIGIN}/retry/`);
  ok(ctx.__probes.length === probed + 1, "a failed probe is retried on the next announcement");
  ok((await previewPolicy(ctx)) === "isolate-and-credentialless", "and the retry's answer is used");
  ctx.__answer = noPolicy;
  await announce(ctx, `${ORIGIN}/changed/`);
  ok((await previewPolicy(ctx)) === null, "a successful probe without the header clears it");
}

console.log("\n6. a revived SW keeps it");
{
  const caches = memoryCacheStorage();
  const first = loadSw({ caches, answer: withPolicy("isolate-and-require-corp") });
  await announce(first);
  const revived = loadSw({ caches });
  ok((await previewPolicy(revived)) === "isolate-and-require-corp", "the policy survives in Cache Storage");
  ok(revived.__probes.length === 0, "without probing the host again");
}

console.log("\n7. pages the SW writes itself");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx);
  ok((await previewPolicy(ctx, { port: NaN })) === "isolate-and-require-corp", "the bad-URL page carries it");
  ctx.resolveKernelSink = async () => null;
  ok(
    (await previewPolicy(ctx)) === "isolate-and-require-corp",
    "the connecting page, served with no kernel reachable, carries it",
  );
}

console.log("\n8. only documents");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx);
  ok((await previewPolicy(ctx, { mode: "cors" })) === null, "a subresource carries none");
}

console.log("\n9. a redirected probe is a failed probe");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx);
  ctx.__answer = redirectsToLogin;
  await announce(ctx, `${ORIGIN}/session-expired/`);
  ok(ctx.__probes.at(-1)?.redirect === "manual", "the probe does not follow redirects");
  ok(
    (await previewPolicy(ctx)) === "isolate-and-require-corp",
    "a login page answering for the host does not replace its policy",
  );
}

console.log("\n10. the probe drops the query and fragment");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx, `${HOST_URL}?code=one-time#state`);
  ok(ctx.__probes[0]?.url === HOST_URL, "an OAuth ?code= is not replayed to the host: " + ctx.__probes[0]?.url);
  await announce(ctx, `${HOST_URL}?code=another`);
  ok(ctx.__probes.length === 1, "a page whose query changed is not probed again");
  ok((await previewPolicy(ctx)) === "isolate-and-require-corp", "and the policy is mirrored");
}

console.log("\n11. a policy the host declares");
{
  const caches = memoryCacheStorage();
  const ctx = loadSw({ caches, answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx, HOST_URL, { documentIsolationPolicy: "isolate-and-credentialless" });
  ok(ctx.__probes.length === 0, "is used without probing the host");
  ok((await previewPolicy(ctx)) === "isolate-and-credentialless", "and mirrored as declared");
  ok(
    (await previewPolicy(loadSw({ caches }))) === "isolate-and-credentialless",
    "and survives a revived SW",
  );
  await announce(ctx, HOST_URL, { documentIsolationPolicy: "none" });
  ok(ctx.__probes.length === 0 && (await previewPolicy(ctx)) === null, "'none' clears it, still without a probe");
  await announce(ctx, HOST_URL, { documentIsolationPolicy: "isolate-everything" });
  ok(ctx.__probes.length === 1, "an invalid declaration is ignored and the host probed instead");
  ok((await previewPolicy(ctx)) === "isolate-and-require-corp", "and the probe's answer is used");
}

console.log("\n12. a preview served to a cross-origin IDE");
{
  const ctx = loadSw({ answer: withPolicy("isolate-and-require-corp") });
  await announce(ctx);
  ctx.resolveKernelSink = async () => ({
    cross: true,
    post: (_msg, transfer) => {
      transfer[0].postMessage({ status: 200, headers: { "content-type": "text/plain" }, body: "hi" });
      transfer[0].close();
    },
  });
  const request = { url: PREVIEW_URL, mode: "navigate", method: "GET", headers: new Headers() };
  const res = await ctx.handlePreview({ request, clientId: "", resultingClientId: "" }, 3000, "/", false);
  ok(res.headers.get("Document-Isolation-Policy") === null, "carries no Document-Isolation-Policy");
  ok(res.headers.get("Cross-Origin-Embedder-Policy") === "credentialless", "and keeps COEP: credentialless");
}

console.log("\n13. the last announcement wins");
{
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const caches = memoryCacheStorage();
  const ctx = loadSw({ caches, answer: () => gate.then(withPolicy("isolate-and-require-corp")) });
  const slowProbe = announce(ctx, `${ORIGIN}/slow/`);
  const declared = announce(ctx, HOST_URL, { documentIsolationPolicy: "none" });
  open();
  await Promise.all([slowProbe, declared]);
  ok((await previewPolicy(ctx)) === null, "a declaration made while a slow probe runs is what previews get");
  ok(
    (await previewPolicy(loadSw({ caches }))) === null,
    "and what a revived SW reads, not the probe's later answer",
  );
}

console.log(
  failed === 0
    ? "\n✓ preview isolation policy mirrors its host"
    : `\n✗ ${failed} check(s) failed`,
);
process.exit(failed ? 1 : 0);