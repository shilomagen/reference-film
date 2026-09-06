# Release process

Releases are deliberate, local, and owner-approved. This document does not authorize publishing, pushing, or auto-merging.

## Prepare

1. Start from a clean checkout and review the complete diff.
2. Confirm Node.js 20+ and FFmpeg are available.
3. Confirm examples and tests contain only synthetic material and no real faces, songs, credentials, paid responses, private paths, or corporate tooling.
4. Review privacy and cost changes, provider policy assumptions, downstream stack dependencies, schemas, and migration notes.
5. Confirm `package.json`, `package-lock.json`, packaged files, and source exports identify and include the owner-selected MIT license.

## Verify

Run locally without credentials or provider calls:

```sh
npm ci --ignore-scripts
npm run example:assets
npm run check
npm test
npm run validate
npm run dry-run
node --test test/export.test.mjs
```

Record command output and any justified gap. Validation and test fixtures must remain offline and synthetic.

## Create a review export

Choose a new destination outside the checkout:

```sh
node scripts/export.mjs ../reference-film-public-review
```

The dependency-free exporter copies only explicit public-source categories, rejects source symlinks and unsafe destinations, and writes `EXPORT_MANIFEST.json` with paths, byte counts, SHA-256 checksums, and license status. It does not use Git, contact an external service, or publish anything.

Review the entire export and manifest. Confirm `LICENSE` is present with its expected
byte count and checksum, and that the manifest reports it as included. Confirm private
workspace files, environments, projects, checkpoints, source/generated media, and
unknown files are absent. The exporter's `pending` fallback remains only for unrelated
source trees that genuinely contain no license file.

## Owner decision and publication

The owner has selected MIT for this project and separately decides whether to merge,
tag, push, publish, or distribute an export. Re-run verification on the exact approved
commit and compare inventory checksums immediately before any separately authorized
publication. Never infer publication authorization from this checklist, a passing CI
run, or repository visibility.
