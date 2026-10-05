---
"@vivari/core": patch
---

A `MessagePort` follows Node's rules in the browser: `onmessage` and `addEventListener('message')` now start the port and keep the process alive like `on('message')`, a port stops holding when its other end closes, and a worker's `parentPort` is a real `MessagePort` (GitHub issue #13).
