# Reference Film

Reference Film is a local-first CLI for turning a reviewed creator brief and supplied,
licensed media into a short reference-driven film. It includes creator onboarding,
structured text generation, explicit editorial and rights gates, resumable image/video
operations, QA, and FFmpeg assembly.

> **Important:** this project does **not** synthesize singing or music. Supply a finished,
> properly licensed audio file. Model names in the synthetic example are placeholders;
offline validation does not prove that a provider or model is available.

## Install and offline example

Requires Node.js 20+ and FFmpeg/ffprobe on `PATH`.

```sh
npm install --ignore-scripts
npm run example:assets       # synthetic PNGs and a 20-second WAV
npm test
npm run validate             # real media validator; no network or credentials
npm run dry-run              # real timeline/prompts/paths; no network or credentials
```

The default example is wholly synthetic. Its 18 seconds of scenes plus a 2-second final
freeze match the generated 20-second audio. `examples/assets/` and generated output are
ignored; public example JSON and documentation remain tracked.

## Creator onboarding and end-to-end flow

Create workspaces under the ignored `projects/` directory. Interactive `init` asks six
questions and requires the literal `CONSENT` token before any personal details may be
sent to the configured text provider:

```sh
node src/cli.mjs init --project projects/my-film
```

For CI/noninteractive use, prepare a private brief conforming to
`schemas/creator-brief.schema.json`; do not place personal answers in public examples:

```sh
node src/cli.mjs init --project projects/my-film --brief /private/path/brief.json
```

`init` adds a workspace `.gitignore` without replacing existing content. It excludes the
brief, lyrics, plan, config, workflow audit data, and `.private/` output. Review
`projects/my-film/project.config.json`, add reference paths under `inputs.faces`, add the
finished song under `inputs.audioCandidates`, and replace every `SET_ME_*` model name.
An explicit `--audio` override is also supported.

Then run the gated flow:

```sh
node src/cli.mjs approve --project projects/my-film --stage disclosure \
  --statement "I reviewed and permit this provider disclosure"
node src/cli.mjs lyrics --project projects/my-film --yes
# Review/edit lyrics.json; lyrics.md is only a preview.
node src/cli.mjs approve --project projects/my-film --stage lyrics \
  --statement "I approve these lyrics"
node src/cli.mjs storyboard --project projects/my-film --yes
# Review/edit scene-plan.json.
node src/cli.mjs approve --project projects/my-film --stage scenes \
  --statement "I approve these scenes"
node src/cli.mjs approve-media --project projects/my-film --acknowledge-rights \
  --statement "I have rights and informed consent for every current input"
node src/cli.mjs create --project projects/my-film --yes
```

`create` resumes at the next missing stage. `--yes` acknowledges potentially paid work
with unknown cost; it never grants disclosure, editorial approval, likeness consent, or
media rights. Rights approval hashes normalized config references, direct-animation
photos, and the selected audio (including `--audio`), and writes both creator and media
approval records. Changing any file invalidates both gates. Empty references are allowed
while drafting, but validation/generation stops before media spend.

Run individual media stages with `images`, `videos`, and `assemble`; `run` runs all of
them. `--provider xai|gemini` changes video only. `--scenes`, `--concurrency`, `--judge`
or `--no-judge`, `--audio`, and `--timings` are available. Generated video audio is
disabled/stripped; assembly uses only the supplied song. With `--no-judge`, inspect the
candidate and explicitly accept its exact checksum:

```sh
node src/cli.mjs approve-artifact --project projects/my-film \
  --scene scene_id --stage image --checksum <sha256>
```

## Resume and reconciliation

Paid operations have durable journals. Rerunning resumes known asynchronous video IDs
and never silently repeats uncertain requests. If a synchronous response was completed
but its local result was lost, confirm provider state and explicitly accept duplicate
billing risk before one replacement submission:

```sh
node src/cli.mjs reconcile --project projects/my-film --operation <creator-id> \
  --reason "provider confirmed no usable result" --acknowledge-duplicate-risk
node src/cli.mjs reconcile-media --project projects/my-film --operation <media-id> \
  --reason "provider confirmed no accepted request" --acknowledge-duplicate-risk
```

Lyrics and storyboard cache provenance binds prompt, model, upstream content, output
budget, generation epoch, and artifact checksum. Edited JSON remains an editable draft,
but stale content is never presented as a matching generated cache. Use `--force` only
after resolving uncertain journal entries; it intentionally starts a new generation
epoch. Edited `lyrics.md`/`music-brief.md` previews are not silently overwritten.

## Validation, status, contracts, and paths

```sh
node src/cli.mjs validate --config /absolute/project.config.json
node src/cli.mjs status --config /absolute/project.config.json
node src/cli.mjs run --dry-run --config /absolute/project.config.json
```

These root commands call the actual media read-only functions and timeline implementation.
They make no network calls. Config-owned paths resolve relative to the config; CLI paths
resolve relative to the current working directory, so external-CWD use is supported.

Canonical bounded schemas live in `schemas/` for project config, creator brief, lyrics,
scene plan, and timings. Creator approvals/provenance are under `workflow/`; media rights,
paid-operation journals, scene selections, timeline, and final reports are under the
configured private output directory. The validator supports the explicitly documented
JSON Schema subset in `src/schema.mjs`, not arbitrary JSON Schema.

## Privacy, costs, and limitations

Environment files are never auto-loaded. Pass `--env` or configure `envFile`; see
`.env.example`. Credentials are non-enumerable and sanitized from stored diagnostics.
Prompts necessarily disclose approved brief data and references to selected providers.
Keep workspaces and source media private, review provider retention/privacy terms, and
never use a likeness or recording without rights and informed consent.

Prices are reported when providers return them; otherwise costs remain explicitly
unknown. Quality checks reduce but cannot eliminate identity drift, unsafe generations,
or editing errors. Human review is required. Provider APIs and supported models can
change and are not checked during offline validation.

## License

Project code and documentation are available under the [MIT License](LICENSE). The
`private: true` package setting exists only to prevent accidental npm publication; it
does not limit the rights granted by MIT.

MIT covers this project's software, not rights in user-supplied likenesses, voices,
music, logos, text, or other input assets. It also does not provide those rights for
generated media or replace any third-party provider terms. Obtain all required rights
and informed consent separately.
