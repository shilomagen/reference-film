---
name: Bug report
about: Report reproducible local CLI behavior with synthetic data
labels: bug
---

## Summary

Describe the problem and expected behavior.

## Synthetic reproduction

Provide the smallest reproduction using invented text and synthetic fixtures only. Do not attach personal faces, voices, songs, source media, API keys, environment files, provider responses, or unredacted logs.

```sh
# exact local commands
```

## Evidence

- Node version (`node --version`):
- FFmpeg version (`ffmpeg -version`, if relevant):
- OS/runtime:
- Commit/version:
- Redacted output or stack trace:

## Dependencies and scope

List downstream stack dependencies, provider/model selection (without credentials), whether a paid/network call was involved, and whether the issue reproduces with offline `validate` or `run --dry-run`. Unknown provider cost is not zero; do not incur charges solely for this report.

## Safety check

- [ ] Inputs and attachments are synthetic and contain no personal likeness, song, secret, or private project data.
- [ ] Paths, identifiers, request IDs, and logs are redacted.
- [ ] I had permission to test the affected systems and accounts.
