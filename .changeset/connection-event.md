---
"@vivari/core": minor
"@vivari/react": minor
---

pr: #9

Add a `connection` event (with the `ConnectionEvent` and `ConnectionListener` types) that fires when one process in the VM opens a TCP connection to a server in another, before either end can send anything. It reports the server's port, the connection's `remotePort`, both pids, and the client's still-running ancestors.