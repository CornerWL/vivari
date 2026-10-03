---
sidebar_position: 8
title: Cross-origin isolation
---

# Cross-origin isolation

Vivari needs `SharedArrayBuffer`, which browsers only expose on a **cross-origin
isolated** page. That means serving your HTML documents (and the `sw.js` script)
with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Under `require-corp`, every **cross-origin** subresource must opt in with
`Cross-Origin-Resource-Policy` (or CORS). Same-origin subresources are fine,
which is why Vivari self-hosts all of its workers and Wasm.

**Iframes are the exception to "same-origin is fine".** A nested *document* does
not inherit its embedder's policy: it must send `require-corp` (or
`credentialless`) on its own response, even when it is same-origin. Miss it and
the browser blocks the frame and renders its "*&lt;host&gt; refused to connect*" error
page — the same page you get from `X-Frame-Options`, which sends you looking for a
CSP that isn't there. So if you scope the headers by path, make sure every
document you iframe is inside the scoped paths.

**Embedding on a host that sends no headers (Chromium only).** COOP and COEP have to
come from the top-level page, so Vivari in an iframe normally needs the host site to
send them. In Chromium the frame can isolate itself instead, by sending this on its
own documents:

```
Document-Isolation-Policy: isolate-and-require-corp
```

Other browsers ignore it and still need the host's COOP and COEP. The preview Service
Worker copies your page's `Document-Isolation-Policy` onto the preview documents it
serves to that page (previews on a separate preview origin get none, being
cross-origin anyway), so the page can still read and reload its preview iframe. Tell
it the value when you boot:

```ts
await Vivari.boot({ documentIsolationPolicy: "isolate-and-require-corp" });
```

The declared value is used as given, so it has to be the header the page is really
served with: a value the page doesn't send breaks the preview the same way a missing
one does. The option needs the `sw.js` from the same `@vivari/core` version; an older
copy ignores it and falls back to asking your server.

If you don't declare it, the Service Worker asks your server: it sends a `HEAD` to the
page's URL (without its query string) and reads the header off the response. That needs
your server to answer `HEAD` with the same header as `GET` and without a redirect, and
it costs one extra request each time the Service Worker starts. The Service Worker
keeps one value per origin, so every page on that origin that boots Vivari should
declare (or be served with) the same value.

Check at runtime:

```ts
import { isCrossOriginIsolated } from "@vivari/core";
console.log(isCrossOriginIsolated()); // must be true before Vivari.boot()
```

You don't have to check first: `Vivari.boot()` performs the same test and rejects
with `VivariError("ERR_NOT_ISOLATED")` before starting any workers. Calling
`isCrossOriginIsolated()` yourself is useful when you want to render a
"headers missing" state without attempting a boot at all.

## Header recipes

### Vite (dev + preview)

```ts
import { defineConfig } from "vite";
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
});
```

### Cloudflare Pages (`_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### Netlify (`_headers`) / Nginx / Express

```
# Netlify _headers
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

```nginx
# Nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

```ts
// Express
app.use((_req, res, next) => {
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  res.set("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
```

:::caution Scope it deliberately
Cross-origin isolation is contagious: a page is only isolated if its top-level
document sends the headers. If you host a marketing page and an embed on the same
origin, you can scope the headers to just the embed's path so the rest of the
site stays free of CORP constraints. That's exactly what this project does; see
[Deployment](./deployment).
:::