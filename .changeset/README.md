# Changesets

Every pull request that changes what `@vivari/core` or `@vivari/react` does for an
embedder adds a changeset. That covers the runtime, the kernel and the preview Service
Worker too, since they ship inside `@vivari/core`:

```sh
npm run changeset
```

Pick the bump (patch for fixes, minor for new features, major for breaking changes) and
write one or two sentences for the changelog, from the embedder's side. The two packages
always release together under one version. Changes to the studio, the docs, the blog or
CI need no changeset.

The release workflow turns pending changesets into a "chore: release vX.Y.Z" pull request
from the branch `release/vX.Y.Z`; its description previews the GitHub release. Merging it
publishes both packages to npm and creates that release.

A changeset written after its pull request merged can say which one it belongs to, so the
changelog links it and thanks its author. Put the line first in the summary:

```md
---
"@vivari/core": patch
---

pr: #12

What changed, for the embedder.
```

`commit: <sha>` does the same for a change pushed without a pull request.