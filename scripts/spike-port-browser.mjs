// Spike (OFFLINE, no Wasm): Node's MessagePort semantics on a BROWSER-shaped port.
//
// WHY THIS EXISTS. spike-port-liveness runs the VM headless, where the platform
// MessagePort is Node's own — and Node's port already starts and refs itself on
// any listener, so the runtime's model of those rules is never what is being
// measured there. GitHub issue #13 lived exactly in that gap: in a browser,
// `onmessage` and `addEventListener` held nothing, `addEventListener` never even
// started the port, and a worker whose only handle was a workerData port exited 0
// as soon as its module finished. Headless it all passed.
//
// Nothing in CI runs a browser, so this builds the port the HTML spec describes —
// an EventTarget; only setting `onmessage` starts it; no ref/unref, no Node
// methods; no notice when the other end closes — and drives the SHIPPED
// message-port.js and worker_threads.js on it. The liveness host counts what the
// runtime retains, which is the whole question: a count left above zero is a
// process that never exits, one that drops to zero early is a process that exits
// before its message arrives.
//
//   run:  node scripts/spike-port-browser.mjs

import EventEmitter from "node:events";
import { installMessagePort } from "../packages/runtime/message-port.js";
import workerThreadsFactory from "../packages/runtime/node/lib/worker_threads.js";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => tick(20);

// ── a MessagePort as the HTML spec describes it ──────────────────────────────
const IS_PORT = Symbol("browserPort");
const CONSTRUCT = Symbol("construct");
const etAdd = EventTarget.prototype.addEventListener;
const etRemove = EventTarget.prototype.removeEventListener;

const cloneWith = (v, moved, depth = 0) => {
  if (moved.has(v)) return moved.get(v);
  if (!v || typeof v !== "object" || v[IS_PORT] || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => cloneWith(x, moved, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneWith(x, moved, depth + 1)]));
};

function createRealm() {
  const realm = {};
  class MessagePort extends EventTarget {
    constructor(key) {
      if (key !== CONSTRUCT) throw new TypeError("Illegal constructor");
      super();
      this[IS_PORT] = true;
      this._realm = realm;
      this._peer = null;
      this._queue = [];
      this._enabled = false;
      this._closed = false;
      this._pumping = false;
      this._handler = null;
      this._handlerListener = null;
    }
    get onmessage() {
      return this._handler;
    }
    // The one implicit start() in the spec.
    set onmessage(fn) {
      const f = typeof fn === "function" ? fn : null;
      if (f && !this._handlerListener) {
        this._handlerListener = (e) => this._handler && this._handler.call(this, e);
        etAdd.call(this, "message", this._handlerListener);
      }
      if (!f && this._handlerListener) {
        etRemove.call(this, "message", this._handlerListener);
        this._handlerListener = null;
      }
      this._handler = f;
      if (f) this.start();
    }
    start() {
      if (this._closed || this._enabled) return;
      this._enabled = true;
      this._pump();
    }
    // Disentangles. The peer is told nothing — that is the browser's behaviour,
    // and the one the runtime has to cope with.
    close() {
      this._closed = true;
      if (this._peer) this._peer._peer = null;
      this._peer = null;
      this._queue.length = 0;
    }
    postMessage(data, transfer) {
      if (this._closed) return;
      const list = Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || [];
      const peer = this._peer;
      const moved = new Map();
      for (const p of list) if (p && p[IS_PORT]) moved.set(p, p._moveTo(peer ? peer._realm : realm));
      if (peer) peer._receive(cloneWith(data, moved), [...moved.values()]);
    }
    _receive(data, ports) {
      if (this._closed) return;
      this._queue.push({ data, ports });
      this._pump();
    }
    _pump() {
      if (!this._enabled || this._pumping || !this._queue.length) return;
      this._pumping = true;
      setImmediate(() => {
        this._pumping = false;
        if (!this._enabled || this._closed) return;
        const m = this._queue.shift();
        if (m) {
          const ev = new Event("message");
          Object.defineProperty(ev, "data", { value: m.data });
          Object.defineProperty(ev, "ports", { value: Object.freeze(m.ports) });
          this.dispatchEvent(ev);
        }
        this._pump();
      });
    }
    // A transfer: a fresh object in the receiving realm, entangled with the same
    // peer, carrying the undelivered queue; this one is detached.
    _moveTo(target) {
      const p = new target.MessagePort(CONSTRUCT);
      p._peer = this._peer;
      if (this._peer) this._peer._peer = p;
      p._queue = this._queue;
      this._queue = [];
      this._peer = null;
      this._closed = true;
      return p;
    }
  }
  class MessageChannel {
    constructor() {
      this.port1 = new MessagePort(CONSTRUCT);
      this.port2 = new MessagePort(CONSTRUCT);
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
  }
  realm.MessagePort = MessagePort;
  realm.MessageChannel = MessageChannel;
  return realm;
}

// ── a process: realm + liveness host + what createRuntime installs ───────────
function bootRealm(realm, { isMainThread = true, workerData = null, parentPort = null } = {}) {
  const host = {
    active: 0,
    scheduled: false,
    drain: null,
    dispatch: null,
    spawned: [],
    isMainThread,
    threadId: isMainThread ? 0 : 7,
    workerData,
    parentPort,
    retain() {
      host.active++;
    },
    release() {
      if (host.active > 0) host.active--;
    },
    wake() {
      if (host.scheduled) return;
      host.scheduled = true;
      setImmediate(() => {
        host.scheduled = false;
        if (host.drain) host.drain();
      });
    },
    registerDrain(fn) {
      host.drain = fn;
    },
    registerDispatch(fn) {
      host.dispatch = fn;
    },
    spawn(reqId, spec, port, extraTransfer) {
      host.spawned.push({ reqId, spec, port, extraTransfer });
    },
    terminate() {},
  };
  realm.g = { MessagePort: realm.MessagePort, MessageChannel: realm.MessageChannel };
  realm.host = host;
  realm.ports = installMessagePort(realm.g, host);
  if (workerData) realm.ports.markGuestIn(workerData);
  return realm;
}
const boot = (opts) => bootRealm(createRealm(), opts);

// worker_threads reads globalThis.MessagePort/MessageChannel, as it does in a
// process worker; each realm gets its own for as long as its code runs.
function withRealm(realm, fn) {
  const saved = { MessagePort: globalThis.MessagePort, MessageChannel: globalThis.MessageChannel };
  globalThis.MessagePort = realm.g.MessagePort;
  globalThis.MessageChannel = realm.g.MessageChannel;
  try {
    return fn();
  } finally {
    globalThis.MessagePort = saved.MessagePort;
    globalThis.MessageChannel = saved.MessageChannel;
  }
}
function loadWorkerThreads(realm) {
  return withRealm(realm, () => {
    const exports = {};
    const proc = { __wtHost: realm.host, pid: 100, env: {}, cwd: () => "/" };
    const req = (id) => {
      if (id === "events") return EventEmitter;
      throw new Error("unexpected require: " + id);
    };
    workerThreadsFactory(exports, req, { exports }, proc);
    return exports;
  });
}

// The kernel's half of `new Worker`: move the child's ports into a new realm,
// boot it, run its program, and report its exit once nothing holds it.
function runChild(parent, spawn, program) {
  const realm = createRealm();
  const moved = new Map();
  for (const p of [spawn.port, ...(spawn.extraTransfer || [])]) moved.set(p, p._moveTo(realm));
  const child = bootRealm(realm, {
    isMainThread: false,
    workerData: cloneWith(spawn.spec.workerData, moved),
    parentPort: moved.get(spawn.port),
  });
  child.wt = loadWorkerThreads(child);
  child.exited = false;
  parent.host.dispatch({ type: "thread-started", reqId: spawn.reqId, threadId: 7 });
  withRealm(child, () => program(child.wt));
  const watch = setInterval(() => {
    if (child.host.active === 0 && !child.host.scheduled) {
      clearInterval(watch);
      child.exited = true;
      parent.host.dispatch({ type: "thread-exit", reqId: spawn.reqId, code: 0 });
    }
  }, 25);
  return child;
}
const waitIdle = async (realm, limitMs = 3000) => {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (realm.host.active === 0 && !realm.host.scheduled) return true;
    await tick(25);
  }
  return false;
};

// ── the cases ────────────────────────────────────────────────────────────────
console.log("guest ports — the web-style surface is the same listener list:");
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const heard = [];
  port1.addEventListener("message", (e) => heard.push(e.data));
  ok(r.host.active === 1, "addEventListener('message') holds the loop");
  port2.postMessage("hi");
  await settle();
  ok(heard.join() === "hi", "…and is heard: the first listener started the port");
  port1.close();
  ok(r.host.active === 0, "close() releases it");
}
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const heard = [];
  port1.onmessage = (e) => heard.push("a:" + e.data);
  ok(r.host.active === 1, "onmessage holds the loop");
  port1.onmessage = (e) => heard.push("b:" + e.data);
  ok(r.host.active === 1, "…replacing the handler keeps one hold");
  port2.postMessage(1);
  await settle();
  ok(heard.join() === "b:1", `…the current handler is the one called (${heard.join()})`);
  ok(typeof port1.onmessage === "function" && port1.listenerCount("message") === 1, "…and reads back, counted once");
  port1.onmessage = null;
  ok(r.host.active === 0 && port1.onmessage === null, "onmessage = null releases it");
}
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const h = () => port1.removeEventListener("message", h);
  port1.addEventListener("message", h);
  port2.postMessage("hi");
  await settle();
  ok(r.host.active === 0, "removeEventListener inside the handler releases it");
}
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const heard = [];
  port1.addEventListener("message", (e) => heard.push(e.data), { once: true });
  port2.postMessage("first");
  port2.postMessage("second");
  await settle();
  ok(heard.join() === "first" && r.host.active === 0, `{ once: true } fires once, then releases (${heard.join()})`);
}
{
  const r = boot();
  const { port1 } = new r.g.MessageChannel();
  const f = () => {};
  port1.addEventListener("message", f);
  port1.addEventListener("message", f);
  ok(port1.listenerCount("message") === 1, "a duplicate addEventListener is one listener");
  port1.removeEventListener("message", f);
  ok(r.host.active === 0, "…so one removeEventListener releases");
}
{
  const r = boot();
  const { port1 } = new r.g.MessageChannel();
  const ac = new AbortController();
  port1.addEventListener("message", () => {}, { signal: ac.signal });
  ok(r.host.active === 1, "a listener with an AbortSignal holds");
  ac.abort();
  ok(r.host.active === 0, "…and aborting it releases");
}
{
  const r = boot();
  const { port1 } = new r.g.MessageChannel();
  const a = () => {};
  const b = () => {};
  port1.on("message", a);
  port1.addEventListener("message", b);
  port1.onmessage = () => {};
  ok(r.host.active === 1 && port1.listenerCount("message") === 3, "on + addEventListener + onmessage: one hold, three listeners");
  port1.off("message", a);
  port1.removeEventListener("message", b);
  ok(r.host.active === 1, "…held until the last one goes");
  port1.onmessage = null;
  ok(r.host.active === 0, "…released when it does");
}

console.log("\nthe other end closing:");
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const heard = [];
  port1.onmessage = (e) => heard.push(e.data);
  port2.postMessage("last");
  port2.close();
  await settle();
  ok(heard.join() === "last", `what was posted before close() arrives, and nothing else (${JSON.stringify(heard)})`);
  ok(r.host.active === 0, "…then this end stops holding, as on Node");
}

console.log("\nref / unref, with and without listeners:");
{
  const r = boot();
  const { port1 } = new r.g.MessageChannel();
  port1.ref();
  ok(r.host.active === 1, "ref() holds with nothing listening (the @emnapi/runtime shape)");
  port1.unref();
  ok(r.host.active === 0, "unref() releases");
  port1.ref();
  port1.close();
  ok(r.host.active === 0, "close() releases a ref()");
  ok(typeof port1.hasRef === "function", "hasRef() exists where the platform has none");
}
{
  const r = boot();
  const a = new r.g.MessageChannel();
  a.port1.unref();
  a.port1.addEventListener("message", () => {});
  ok(r.host.active === 1, "unref() then listen: the first listener refs again");
  const r2 = boot();
  const b = new r2.g.MessageChannel();
  b.port1.addEventListener("message", () => {});
  b.port1.unref();
  ok(r2.host.active === 0, "listen then unref(): released");
}

console.log("\nports the guest never had hold nothing (the worker-spawn hang):");
{
  const r = boot();
  const { port1, port2 } = new r.ports.NativeMessageChannel();
  port1.onmessage = () => {};
  port2.addEventListener("message", () => {});
  port1.ref();
  ok(r.host.active === 0, "the runtime's own channel: onmessage, addEventListener, ref() — no hold");
  const guest = new r.g.MessageChannel();
  r.ports.internalPortSetup(() => {
    guest.port1.addEventListener("message", () => {});
    guest.port1.ref();
  });
  ok(r.host.active === 0, "a guest port the runtime listens on, inside internalPortSetup — no hold");
  ok(guest.port1 instanceof r.MessagePort && guest.port1 instanceof r.g.MessagePort, "guest ports are real platform ports");
}
{
  const r = boot();
  const { port1, port2 } = new r.g.MessageChannel();
  const inner = new r.ports.NativeMessageChannel();
  let received = null;
  port1.onmessage = (e) => (received = e.ports[0]);
  port2.postMessage({ p: inner.port1 }, [inner.port1]);
  await settle();
  port1.close();
  received.onmessage = () => {};
  ok(r.host.active === 1, "a port received in a message is the guest's: listening on it holds");
  received.close();
}

console.log("\nworker_threads on browser ports:");
{
  const r = boot();
  const wt = loadWorkerThreads(r);
  ok(wt.MessageChannel === r.g.MessageChannel, "worker_threads.MessageChannel is the guest's constructor");
  const { port1, port2 } = new wt.MessageChannel();
  ok(wt.receiveMessageOnPort(port1) === undefined, "receiveMessageOnPort: nothing yet");
  port2.postMessage("polled");
  await settle();
  ok(r.host.active === 0, "…polling holds nothing");
  ok(JSON.stringify(wt.receiveMessageOnPort(port1)) === '{"message":"polled"}', "…and returns what arrived");
  port2.close();
  await settle();
  ok(wt.receiveMessageOnPort(port1) === undefined, "…and never returns the close signal");
}
{
  const parentRealm = createRealm();
  const ch = new parentRealm.MessageChannel();
  const child = bootRealm(createRealm(), { isMainThread: false });
  child.host.parentPort = ch.port2._moveTo(child);
  const wt = loadWorkerThreads(child);
  ok(wt.parentPort instanceof child.MessagePort, "parentPort is a real MessagePort");
  ok(child.host.active === 0, "an unused parentPort holds nothing (or every worker is immortal)");
  const heard = [];
  wt.parentPort.onmessage = (e) => heard.push(e.data);
  ok(child.host.active === 1, "parentPort.onmessage holds the thread");
  ch.port1.postMessage("from parent");
  await settle();
  ok(heard.join() === "from parent", "…and is delivered (from the loop's drain)");
  wt.parentPort.onmessage = null;
  const h = (e) => {
    heard.push("ael:" + e.data);
    wt.parentPort.removeEventListener("message", h);
  };
  wt.parentPort.addEventListener("message", h);
  ok(child.host.active === 1, "parentPort.addEventListener holds the thread");
  ch.port1.postMessage("again");
  await settle();
  ok(heard.at(-1) === "ael:again" && child.host.active === 0, "…removeEventListener in the handler releases it");
}
{
  const parent = boot();
  const wt = loadWorkerThreads(parent);
  const w = withRealm(parent, () => new wt.Worker("/w.js"));
  ok(parent.host.active === 1, "a running Worker holds once; its own port is not a guest port");
  const got = [];
  w.on("message", (m) => got.push(m));
  ok(parent.host.active === 2, "w.on('message') adds the port's hold");
  const child = runChild(parent, parent.host.spawned[0], (cwt) => {
    cwt.parentPort.postMessage("hello");
    cwt.parentPort.close();
  });
  await waitIdle(parent);
  ok(got.join() === "hello", `the child's close() signal never reaches w.on('message') (${JSON.stringify(got)})`);
  ok(child.exited && parent.host.active === 0, "both sides end");
}
{
  const parent = boot();
  const wt = loadWorkerThreads(parent);
  const w = withRealm(parent, () => new wt.Worker("/w.js"));
  w.unref();
  const got = [];
  w.on("message", (m) => got.push(m));
  ok(parent.host.active === 1, "an unref'd Worker's listener holds the port");
  const child = runChild(parent, parent.host.spawned[0], (cwt) => {
    cwt.parentPort.postMessage("hello");
    cwt.parentPort.close();
  });
  child.host.retain(); // a timer: the thread keeps running
  const idle = await waitIdle(parent);
  ok(idle && !child.exited && got.join() === "hello", `the child closing parentPort releases it while the thread runs on (${JSON.stringify(got)})`);
  w.on("message", () => {});
  ok(parent.host.active === 0, "…and a listener added after the close does not take it back");
  w.ref();
  ok(parent.host.active === 1, "…while ref() still holds for the thread itself");
  child.host.release();
  ok(await waitIdle(parent), "…until the thread exits");
}

console.log("\nthe issue #13 repro, end to end:");
{
  const parent = boot();
  const wt = loadWorkerThreads(parent);
  const log = [];
  withRealm(parent, () => {
    const { port1, port2 } = new wt.MessageChannel();
    const w = new wt.Worker("./worker.js", { workerData: { port: port2 }, transferList: [port2] });
    w.on("exit", (code) => log.push("worker exit " + code));
    port1.addEventListener("message", (e) => {
      log.push("got " + e.data);
      port1.close();
    });
    setTimeout(() => port1.postMessage("hi"), 300);
  });
  const child = runChild(parent, parent.host.spawned[0], (cwt) => {
    cwt.workerData.port.onmessage = (e) => {
      cwt.workerData.port.postMessage("re: " + e.data);
      cwt.workerData.port.close();
    };
  });
  await tick(200);
  ok(!child.exited, "the worker is still alive, waiting on its workerData port, before the message is sent");
  const idle = await waitIdle(parent);
  ok(idle, "the parent ends (no hang)");
  ok(log.join(" | ") === "got re: hi | worker exit 0", `transcript matches Node: ${JSON.stringify(log)}`);
}
{
  const parent = boot();
  const wt = loadWorkerThreads(parent);
  const log = [];
  withRealm(parent, () => {
    const { port1, port2 } = new wt.MessageChannel();
    const w = new wt.Worker("./worker.js", { workerData: { port: port2 }, transferList: [port2] });
    w.on("message", (m) => log.push(m));
    w.on("exit", (code) => log.push("worker exit " + code));
    setTimeout(() => {
      port1.postMessage("bye");
      port1.close();
    }, 100);
  });
  runChild(parent, parent.host.spawned[0], (cwt) => {
    cwt.workerData.port.onmessage = (e) => cwt.parentPort.postMessage("child got " + e.data);
  });
  await tick(150);
  const idle = await waitIdle(parent);
  ok(idle && log.join(" | ") === "child got bye | worker exit 0", `a worker listening on a port whose other end closes ends: ${JSON.stringify(log)}`);
}

console.log(failed === 0 ? "\nPASS: browser-shaped ports follow Node's rules." : `\nFAIL: ${failed} assertion(s)`);
process.exit(failed === 0 ? 0 : 1);
