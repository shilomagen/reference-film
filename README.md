# Reference Film

A local-first, provider-extensible CLI for creating reference-driven films. This first
slice publishes the project contracts and an offline validator/dry run. Paid image,
video, judging, and assembly stages are deliberately not implemented yet.

## Offline bootstrap

Requires Node.js 20+ and FFmpeg on `PATH`.

```sh
npm install --ignore-scripts
npm run example:assets
npm test
npm run validate
npm run dry-run
```

`npm install` has no runtime dependencies or install scripts. Validation and dry-run
do not load `.env`, require credentials, or make network calls. The default config is
`examples/project.config.json`; generated synthetic assets and project outputs are
Git-ignored.

To run from another working directory, provide an explicit config path:

```sh
node /path/to/reference-film/src/cli.mjs validate --config /path/to/reference-film/examples/project.config.json
```

CLI paths (`--config`, `--env`, `--audio`, `--timings`) resolve relative to the current
working directory. Paths owned by a config (`inputs`, references, output) resolve
relative to that config file. Run `node src/cli.mjs --help` for all preserved options.
`--provider` overrides video only; text, image, and judge providers remain independent.

## Contracts and creator workflow

Canonical JSON Schemas are in `schemas/` for:

- project configuration;
- creator brief;
- structured lyrics with stable section and line IDs;
- scene plan, whose `lyric_ids` link scenes to lyric lines; and
- optional timing overrides.

The validator implements only the bounded JSON Schema keyword set documented in
`src/schema.mjs`; it does not claim general JSON Schema conformance. The example has
solo, two-person, action, and direct-animation scenes. Edit local JSON and
`examples/creator-notes.md`; approval `source_hashes` are reserved for later workflow
slices.

Generate the example's deterministic geometric PNG references, group image, and WAV
tone with `npm run example:assets`. See `examples/ASSET_PROVENANCE.md`. They contain no
real likenesses or copyrighted source music. Use only references, music, and likenesses
for which you have rights and informed consent.

## Environment and privacy

Environment files are **never auto-loaded**. Select one explicitly with
`--env path/to/project.env`, or set `envFile` in a project config. Supported variables
are documented in `.env.example`: `XAI_API_KEY` (`GROK_API_KEY` alias), xAI/Grok base
URL variables, and Gemini variables. Credentials live in a non-enumerable runtime
field and are omitted when normalized config is serialized.

Outputs must include the project slug as a directory segment and may not target the
filesystem root, home, current directory, or config directory. The example writes to
`.generated/example-film` and dry-run only prints the planned execution—it does not
fabricate outputs or model responses.

## License status

The owner has not selected a license. `package.json` is `UNLICENSED`, and no
open-source license is granted at present.
