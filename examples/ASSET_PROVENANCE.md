# Synthetic example asset provenance

All files in `examples/assets/` are generated locally by `npm run example:assets`.
They contain colored geometric shapes, labels naming fictional roles, and a sine-wave
tone. They depict no real person, contain no copied photograph or music, and are not
model outputs. The script is deterministic and overwrites only these known files.

The assets are intentionally Git-ignored. Generate them after cloning so the example
can validate reference paths without distributing face or music media.
