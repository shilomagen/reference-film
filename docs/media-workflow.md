# Media workflow

The media engine is local-first orchestration around the public provider factory in
`src/providers/index.mjs`. It does not duplicate provider configuration or transport
logic. Runtime code has no third-party Node dependency; FFmpeg and ffprobe are required
for video QA and assembly.

## Safety gates

Paid image, judge, and video work requires **both** independent gates:

1. `approveMedia({config, plan, acknowledgeRights: true})` records SHA256 hashes for
   every ordered character reference, direct-animation source photograph, and selected
   audio file. Replacing any source invalidates approval.
2. `runMedia({... yes: true})` acknowledges potential spend for that invocation.
   `yes` is not rights, consent, or editorial approval.

Run `node src/media-cli.mjs approve-rights --acknowledge-rights ...` to create the
rights record. Do not commit this project-specific record.

## Public API

```js
import {
  approveArtifact,
  approveMedia,
  reconcilePaidOperation,
  runMedia,
} from "./src/media.mjs";

await runMedia({
  command,                 // run | images | videos | assemble | status | validate | dry-run
  config,
  plan,
  timings,                 // optional loaded {timings:[...]} document
  yes: true,               // paid commands only
  registry,                // optional injected public provider-registry shape
  journal,                 // optional PaidOperationJournal
  fetch, sleep, random,    // optional provider/test dependencies
  clock, clockMs, logger,
  testOrigins, trustedOrigins,
  process, download,       // optional local-process/download test adapters
});

await approveMedia({ config, plan, acknowledgeRights: true });

await approveArtifact({
  config, plan,
  sceneId: "scene_id",
  stage: "image",          // image | video
  checksum: "<64-char sha256>",
  provider: "xai",         // optional, defaults to configured video provider
});

reconcilePaidOperation({
  config,
  operationId: "<journal id>",
  reason: "provider confirmed no job was accepted",
  acknowledgeDuplicateRisk: true,
  journal,                  // optional
});
```

`registry` follows `createProviderRegistry`: `image`, `judge`, `video`, `selected`, and
`models`. Production callers should normally omit it and let `runMedia` invoke the
public factory. Tests inject it to guarantee no external requests.

## Manual review

`quality.judgeEnabled: false` never auto-passes creative media. Generation writes a
`needs_review` selection containing a candidate path and checksum. Review the local
file and call `approveArtifact` with that exact checksum. A changed file cannot be
approved. Video technical QA remains mandatory and cannot be manually overridden.

## Resumption and cache rules

Generation and quality-policy fingerprints are separate. Prompt, ordered source
hashes, model, candidate count, quality/resolution/aspect, duration, and audio policy
belong to generation fingerprints. Judge model, rubric, and thresholds belong to QA
fingerprints. Thus policy edits rejudge existing candidates/clips without buying the
creative generation again.

Every reusable selection has a SHA256 checksum. Missing, stale, mismatched, failed, or
corrupt selections are rejected. Starting a video writes its operation ID before the
first poll. Poll timeouts, GET failures, missing completion URLs, and download failures
leave that operation resumable; rerunning polls and downloads the same operation rather
than POSTing again. Definite provider job failure or failed QA may consume the next
configured attempt. Ambiguous paid submissions are blocked by the provider journal
until explicit duplicate-risk reconciliation; `--force` is not a bypass.

Provider URLs are never persisted by the media engine. Metadata records only safe IDs,
checksums, statuses, timestamps, model/provider labels, and costs. Unknown costs remain
unknown rather than becoming zero.

## Timeline and assembly

The timeline always derives from `plan.allScenes` before selected-scene work is
filtered, so a scene gets the same target/request fingerprints in full and partial
runs. Timing overrides must be complete, unique, and known. Locked overrides must match
the plan. Complete overrides plus freeze must match audio within normal encoding
tolerance. All-locked or too-short audio configurations fail before generation.

Assembly makes no paid requests. It requires checksum-valid, current selected stills
and clips with passed technical QA. Clips are normalized in plan order to fixed size,
FPS, pixel format, and exact duration; short clips use final-frame padding. All model
audio is stripped. The supplied song is the sole final audio stream. A configured zero
freeze is supported. Output is isolated under `final-<provider>/<project-slug>.mp4` with
timeline, poster, checksums, source fingerprints, and a safe report.

## Standalone CLI

`src/media-cli.mjs` is import-safe and supports existing config arguments plus:

- `--yes`
- `approve-rights --acknowledge-rights`
- `approve-artifact --scene ID --stage image|video --checksum SHA256`
- `reconcile --operation-id ID --reason TEXT --acknowledge-duplicate-risk`

`status`, `validate`, `dry-run`, and `assemble` never perform paid work. Dry-run reports
upper request-count bounds and explicitly marks prices unknown.
