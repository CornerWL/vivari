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

function loadSw({ caches = memoryCacheStorage(), answer = noPolicy } = {}) {
  const probes = [];
  const listeners = {};
  const ctx = {
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    URL, Response, Request, Headers, MessageChannel, TextEncoder, TextDecoder, AbortSignal,
    setTimeout, clearTimeout, atob, btoa,
    async fetch(input, init) {
      probes.push({ url: String(input), method: init?.method });
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

// The bridge's `vv-kernel-host` announcement, from a client at `url`.
async function announce(ctx, url = HOST_URL) {
  const pending = [];
  const event = {
    data: { type: "vv-kernel-host" },
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
    await announce(ctx, `${HOST_URL}?${name}`);
    ok((await previewPolicy(ctx)) === "isolate-and-require-corp", `a probe answering ${name} keeps it`);
  }
  ctx.__answer = unreachable;
  await announce(ctx, `${HOST_URL}?retry`);
  const probed = ctx.__probes.length;
  ctx.__answer = withPolicy("isolate-and-credentialless");
  await announce(ctx, `${HOST_URL}?retry`);
  ok(ctx.__probes.length === probed + 1, "a failed probe is retried on the next announcement");
  ok((await previewPolicy(ctx)) === "isolate-and-credentialless", "and the retry's answer is used");
  ctx.__answer = noPolicy;
  await announce(ctx, `${HOST_URL}?changed`);
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

console.log(
  failed === 0
    ? "\n✓ preview isolation policy mirrors its host"
    : `\n✗ ${failed} check(s) failed`,
);
process.exit(failed ? 1 : 0);
