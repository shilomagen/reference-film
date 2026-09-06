# Contributing

Thank you for improving this local CLI. Keep changes small, reviewable, and usable without private infrastructure.

## Set up and verify

Use Node.js 20 or newer and FFmpeg on `PATH`.

```sh
npm ci --ignore-scripts
npm run example:assets
npm run check
npm test
npm run validate
npm run dry-run
node --test test/export.test.mjs
```

Validation and dry runs must remain offline. Document any narrower command used when the full suite cannot run.

## Safe test material

- Use only synthetic fixtures: fictional identities, geometric images, generated tones, and invented text.
- Never commit real faces, songs, credentials, provider responses, private prompts, logs, or user project files.
- Tests must not require credentials, paid providers, network calls, corporate tools, or private services.
- Redact paths, identifiers, request IDs, and environment values in bug reports and snapshots.
- Do not add a dependency or provider merely to support a test. Prefer Node's standard library and deterministic local fixtures.

FFmpeg-dependent behavior should check prerequisites and fail clearly. Tests may skip a platform-specific capability only with an explicit reason.

## Changes and pull requests

1. Open an issue for substantial behavior or contract changes.
2. Keep generated media and local projects outside the patch.
3. Add focused tests and run the relevant evidence commands.
4. Explain user-visible effects, privacy/cost impact, and downstream stack dependencies in the pull request.
5. Confirm that examples are synthetic and that logs contain no secrets or personal data.

Provider work must preserve an offline validation path. Do not assume an unknown provider cost is zero, and do not make external calls during tests.

## Rights, consent, and license status

Contributors are responsible for having rights and informed consent for submitted text, likenesses, music, logos, and other material. Avoid real biometric or identifying data in contributions. See [Privacy](docs/privacy.md) and [Security](SECURITY.md).

The project owner has not selected a license. Public availability and acceptance of a contribution do not grant permission to use, copy, or redistribute the project. Do not add license headers or claim an open-source license without explicit owner direction.
