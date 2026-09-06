# Creator workflow

The creator workflow turns a short, consented brief into editable lyrics and a lyric-linked storyboard. Text and media providers remain independently selected. No music service is called: export `lyrics.json`, `lyrics.md`, and `music-brief.md` to a licensed tool, then supply the finished song as a local audio file.

## Private workspace

Use an ignored/private directory. The commands below create `brief.json`, `lyrics.json`, `lyrics.md`, `music-brief.md`, `scene-plan.json`, `project.config.json`, and local `workflow/approvals`, `workflow/journal`, and invalid-output records.

```sh
node src/cli.mjs init --project .private/my-film
# Or noninteractively:
node src/cli.mjs init --project .private/my-film --brief /absolute/path/brief.json
```

Interactive init asks exactly six concise questions. Lists use semicolons, grouped answers use `|`, and supporting people use `Name~relationship~pronouns~ascii_id`. The last answer must explicitly end in `| CONSENT`. Consent and protected traits are never inferred. Review `brief.json`; answer strings are enclosed as untrusted data in prompts.

Generated config contains only the reference paths supplied in the brief. Empty arrays are deliberate: add real local files before media generation. It never invents existing media.

## Text stages and review gates

```sh
node src/cli.mjs approve --project .private/my-film --stage disclosure \
  --statement "I consent to sending these details to my configured text provider"
node src/cli.mjs lyrics --project .private/my-film --yes
# Edit lyrics.json, then:
node src/cli.mjs approve --project .private/my-film --stage lyrics \
  --statement "I approve these lyrics"
node src/cli.mjs storyboard --project .private/my-film --yes
node src/cli.mjs approve --project .private/my-film --stage scenes \
  --statement "I approve this storyboard"
```

`--yes` acknowledges a potentially paid request whose cost may be unknown. It never grants disclosure consent, editorial approval, or media rights. Lyrics and storyboard each estimate one text request. `--dry-run` is fully offline and prints the exact prompt, JSON Schema, and output path; it does not fabricate AI results.

`lyrics.json` is authoritative. `lyrics.md` is a generated preview, not an editable source, so edits to Markdown are never silently ignored. The workflow preserves model-provided approved section/line IDs; storyboard `lyric_ids` must reference those exact lines, match their text, cover all lines in order, and repeat IDs only from sections marked `repeat: true`.

Existing valid artifacts are reused. Files are atomically written and never overwritten without `--force`; `--force` cannot bypass approvals or an uncertain paid-operation journal. Editing the brief makes its disclosure hash stale and prevents more text disclosure; editing lyrics makes lyric approval stale and blocks storyboard generation; editing scenes makes scene approval stale and blocks media. Upstream edits do not silently regenerate paid work.

Malformed, refused, semantically invalid, unknown-character, invented-path, or incomplete model JSON fails closed. Parsed invalid JSON remains inspectable in `workflow/invalid` without credentials. There is no automatic paid repair request.

## Resume coordinator

```sh
node src/cli.mjs create --project .private/my-film --dry-run
node src/cli.mjs create --project .private/my-film --yes
```

`create` resumes completed unchanged stages and stops after each generation with the exact human review needed next. Once lyrics and scenes are approved, it requires all local references, a finished song, current file-hash-bound media-rights attestation, and then delegates media stages to `src/media.mjs`. It never fabricates audio. `--allow-silent` is only an explicit preview option.

Approve current local media hashes only when you have rights and consent:

```sh
node src/cli.mjs approve --project .private/my-film --stage rights \
  --acknowledge-rights --statement "I have rights and consent for these exact files"
```

## Ambiguous paid requests

A synchronous failure may be ambiguous: the provider might have accepted the request. Rerunning, `--yes`, and `--force` do not duplicate it. Investigate with the provider, locate the journal ID, and only if a retry is justified authorize exactly one retry:

```sh
node src/cli.mjs reconcile --project .private/my-film \
  --operation JOURNAL_ID \
  --reason "Provider confirmed that no request was accepted" \
  --acknowledge-duplicate-risk
```

The retry authorization is durably consumed before submission. A second retry requires another explicit reconciliation.

## Media integration

Read-only `validate`, `status`, and existing-plan `run --dry-run` remain offline. Real `run`, `images`, `videos`, and `assemble` dynamically import the media slice and call:

```js
runMedia({ command, config, plan, yes, dryRun, force, allowSilent })
approveMedia({ config, plan, acknowledgeRights })
```

Until that slice is integrated, the CLI reports that media is unavailable instead of pretending work occurred. Media selection/review gates remain independent and are not bypassed by creator approvals.
