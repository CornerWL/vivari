---
"@vivari/core": patch
---

commit: 48986382c7118534cd67489474efdbe207427dcf

A cross-process TCP dial that finds every client port in use now fails with `EADDRNOTAVAIL`, as on a real host, instead of `ECONNREFUSED`.