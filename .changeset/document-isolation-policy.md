---
"@vivari/core": minor
---

pr: #10

Previews now carry the host page's `Document-Isolation-Policy` (Chromium), so a same-origin preview lands in the page's agent cluster and its `contentWindow.location` stays readable. Declare the value with the new `BootOptions.documentIsolationPolicy` (the `DocumentIsolationPolicy` type, `"none"` for no header); left unset, the Service Worker learns it with a `HEAD` to the page's URL, without its query or fragment and without following redirects. Previews served to a cross-origin IDE (modes B and C) get no policy.