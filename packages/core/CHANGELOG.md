# @vivari/core

From 1.1.0 on, entries are generated from [changesets](https://github.com/changesets/changesets).
`@vivari/core` and `@vivari/react` are released together under the same version.

## 1.0.3

### Patch Changes

- [#6](https://github.com/maitrungduc1410/vivari/pull/6) Thanks [@maceip](https://github.com/maceip)! - An optional network relay, off by default: with `BootOptions.netRelay` pointing at a local agent (`scripts/net-relay.mjs`), `connect()` to an external host rides a Wisp stream, and `listen(port)` also binds `127.0.0.1:<port>` on the relay's machine, so a browser redirected to `http://localhost:<port>/callback` reaches the in-VM server. Follow-ups harden it: the relay token is never logged, a failed dial emits `error` (`ECONNREFUSED`, `ENOTFOUND`) instead of `connect` then `close`, and a dropped relay reconnects with backoff and re-announces its listeners.
- [#5](https://github.com/maitrungduc1410/vivari/pull/5) Thanks [@ThailerL](https://github.com/ThailerL)! - A second `listen()` on a port that is already taken fails with `EADDRINUSE` without unregistering the server that holds it, which the same process could no longer reach.
- [#8](https://github.com/maitrungduc1410/vivari/pull/8) Thanks [@kkrausse](https://github.com/kkrausse)! - Deleting a file or directory in OPFS and recreating it at the same path, or changing its kind, no longer loses the new entry on reload.
- [#7](https://github.com/maitrungduc1410/vivari/issues/7) - A guest's `fetch("http://localhost:<port>")` reaches a server listening on that port in the VM, as `http.get` already did, instead of going to the browser's own localhost. `https:` to a local host rejects with `ERR_VIVARI_LOOPBACK_TLS`.

## 1.0.2

### Patch Changes

- The runtime works on Firefox. Packages that need V8's structured stack traces, such as `depd`, no longer crash on `require`, and uncaught errors keep their message.
- Whole-file reads made by the kernel (`vivari.export()`, recursive copy, search) no longer skip files larger than the 1 MiB shared window. `export()` used to drop them and still report `truncated: false`.

## 1.0.1

### Patch Changes

- Python: a notebook, `subprocess`, `python -m` for any module, `--reload`, and a scientific stack that works offline.
- Node and Bun: interactive REPLs, Bun's `new Worker()` on real threads, and wider Bun API coverage.
- The kernel keeps a cookie jar, so a login survives to the next request.
- File-system payloads larger than the 1 MiB shared window are carried whole.
- Node-fidelity fixes across the runtime, file system, network and codecs: HTTP body encoding is decided by the bytes, not the `Content-Type`; a handle's close callback runs in its loop phase; a failing guest process fails without taking the kernel down.
- `npm run dev` no longer kills a running Vite dev server, and the stall watchdog no longer reports a healthy dev server as stuck.

## 1.0.0

First release.