---
"@vivari/core": patch
---

pr: #9

A server accepting a connection from another process in the VM now sees a real `socket.remoteAddress` and `socket.remotePort`, which used to be `undefined`. The kernel picks the client's port from the ephemeral range, unique across the VM while the connection is open, so two processes dialing the same server no longer report the same `localPort`.