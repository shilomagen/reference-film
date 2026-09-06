# Reference Film

A local-first, provider-extensible CLI for creating reference-driven music videos.

Planned workflow:

```text
creator questionnaire -> editable lyrics -> structured scenes
  -> reference-conditioned still candidates -> identity/quality selection
  -> image-to-video -> visual and technical QA
  -> supplied music track + local FFmpeg assembly -> film and report
```

Implementation is arriving in small, reviewed pull requests. No private reference images, source music, generated media, provider credentials, or production checkpoints belong in this repository.

## Project principles

- Inspectable, resumable stages with explicit approvals before paid generation.
- Independently selected provider adapters; no hosted orchestration dependency.
- Local project files and media assembly.
- Synthetic examples and tests that do not spend API credits.
- Rights and informed consent for all reference media and likenesses.

## License status

The owner has not selected a license yet. This repository is intended for an open-source release, but **no open-source license is granted at present**. Do not assume MIT, Apache-2.0, or any other license until a `LICENSE` file is added by the owner.
