// Hard-reloads a standalone preview tab in a REAL Chrome and checks that it comes back to
// the preview. A forced reload (Shift+Reload, Ctrl+Shift+R) bypasses the Service Worker for
// that one load and leaves the page uncontrolled, and an SW that is already active claims
// nothing unless asked, so the page has to ask (`vv-claim`). Node cannot show any of this:
// `clients.claim()`, control and the bypass only exist in a browser.
//
// The tab is served the way worker/src/index.js serves a preview origin: the SW-runtime
// files as themselves, every other path as __vv-preview-boot.html. Nothing answers for the
// kernel, so "back to the preview" means the SW's own "Connecting to Vivari…" page.
//
// It runs twice. With the back/forward cache (Chrome's default), the forced reload of an
// already-booted tab hands back the boot page from that cache, script already spent, so the
// `pageshow` handler is what recovers it. Without it (evicted, disabled, other engines) the
// page loads fresh and uncontrolled, so the claim and the reload guard are what recover it.
//
// What it found, in the boot page: with no claim, a hard reload showed "Preview unavailable:
// The preview runtime didn't take control"; with a claim but the old once-per-tab reload flag,
// "Waiting for your Vivari project tab"; and the restored copy sat at "Registering the preview
// runtime". Review then found the loop guard timed from when the script ran, so a boot page
// slower than its window kept reloading; the bypass case serves it slowly for that reason.
// Removing any of the fixes, or sw.js's `vv-claim` handler, fails a check.
//
// Not in run-spikes.mjs on purpose: it needs a Chrome binary, which the spike tiers do not
// assume. Run it by hand after any change to sw.js's claim/activate path or to the boot page:
//   VV_CHROME=/path/to/chrome node scripts/repro-preview-hard-reload.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../packages/studio/public");
const CHROME =
  process.env.VV_CHROME ||
  (() => {
    for (const base of ["/root/.cache/puppeteer/chrome", "/root/.cache/ms-playwright"]) {
      const version = (d) => Number((d.match(/\d+/) || [0])[0]);
      const dirs = fs.existsSync(base) ? fs.readdirSync(base).sort((a, b) => version(b) - version(a)) : [];
      for (const d of dirs) {
        const c = `${base}/${d}/chrome-linux64/chrome`;
        if (fs.existsSync(c)) return c;
      }
    }
    return "chrome";
  })();
const BOOT_TITLE = "Starting Vivari preview…";
const SW_TITLE = "Connecting to Vivari…";
const RUNTIME_FILES = new Set(["/sw.js", "/__vv-bridge.html", "/__vv-preview-boot.html"]);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (cond, label, s) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}` + (cond ? "" : `  (${JSON.stringify(s)})`));
  if (!cond) failed++;
};

async function scenario(label, extraFlags) {
  console.log(`\n${label}`);
  let bootLoads = 0;
  let bootDelayMs = 0;
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    const file = RUNTIME_FILES.has(pathname) ? pathname : "/__vv-preview-boot.html";
    if (file === "/__vv-preview-boot.html" && req.headers["sec-fetch-dest"] === "document") {
      bootLoads++;
      await settle(bootDelayMs);
    }
    const headers = {
      "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if (file === "/sw.js") headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    res.end(fs.readFileSync(path.join(PUBLIC, file)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/preview/3000/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vv-hard-reload-"));
  const chrome = spawn(
    CHROME,
    ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", "--user-data-dir=" + profile, ...extraFlags],
    { stdio: "ignore" },
  );
  let wsUrl = "";
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await settle(250);
    try {
      const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n");
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) {
    console.log(`no CDP endpoint from ${CHROME}; set VV_CHROME`);
    chrome.kill();
    process.exit(2);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { browserContextId } = await send("Target.createBrowserContext");
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Network.enable");
  const state = async () =>
    (
      await page("Runtime.evaluate", {
        returnByValue: true,
        expression: `({ stale: !!window.__vvStale, title: document.title,
          controlled: !!navigator.serviceWorker.controller,
          text: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "" })`,
      })
    ).result.value;
  // Marks the current document, so a reload is judged by the one that replaces it.
  const reload = async (params) => {
    await page("Runtime.evaluate", { expression: "window.__vvStale = true" });
    await page("Page.reload", params);
  };
  // The SW's page reloads itself a few times before it shows its "Connect this tab" gate;
  // wait for that, so every step starts from a settled tab.
  const quiet = async () => {
    for (let i = 0; i < 40; i++) {
      const s = await state().catch(() => null);
      if (s && !s.stale && s.title === SW_TITLE && /Connect this tab/.test(s.text)) return s;
      await settle(250);
    }
    return state();
  };
  const backToPreview = (s) => !s.stale && s.controlled && s.title === SW_TITLE;

  await page("Page.navigate", { url });
  let s = await quiet();
  ok(backToPreview(s), "a first open registers the SW and reloads into the preview", s);
  for (const n of [1, 2]) {
    await reload({ ignoreCache: true });
    s = await quiet();
    ok(backToPreview(s), `hard reload #${n} comes back to the preview`, s);
  }

  // Slower than the loop guard's window, so a guard timed from when the page runs (rather
  // than from when its navigation started) keeps reloading.
  await page("Network.setBypassServiceWorker", { bypass: true });
  bootDelayMs = 3500;
  bootLoads = 0;
  await reload({});
  await settle(9000);
  const loads = bootLoads;
  await settle(9000);
  s = await state();
  ok(
    bootLoads === loads && loads <= 3,
    `with every load bypassing the SW (DevTools' "Bypass for network") on a slow network, the reloads stop (${loads} loads, ${bootLoads - loads} after)`,
    s,
  );
  ok(!s.stale && s.title === BOOT_TITLE && /Reload the tab normally/.test(s.text), "and the tab says what to do", s);

  ws.close();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited;
  server.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* Chrome's helpers can still be writing to it; it is a temp dir */
  }
}

await scenario("with the back/forward cache (Chrome's default)", []);
await scenario("without it", ["--disable-back-forward-cache"]);
console.log(failed === 0 ? "\n✓ a hard-reloaded preview tab comes back" : `\n✗ ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);