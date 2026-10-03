---
"@vivari/core": patch
---

pr: #11

A hard-reloaded page (Ctrl+Shift+R) has no Service Worker controller, so its previews used to go to the host's origin while `boot()` reported success. The page now asks the preview Service Worker to claim it. The standalone preview tab of modes B and C, `__vv-preview-boot.html`, does the same and comes back after a hard reload instead of waiting for a controller that never came.