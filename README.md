[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haofanjiuju/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/haofanjiuju/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies AI-written edits in four formats — unified diffs (often with wrong
line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool
calls — to a tree of text files, to the written specification in `SPEC.md`.
Every file is changed or none.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; when absent or `-`, the patch is read from stdin.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`;
  `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file touched.
- `--strict` matches lines exactly (tier 0 only).

Old lines are found at the first of three matching tiers (exact, trailing
whitespace ignored, leading and trailing whitespace ignored, with re-indentation),
so a model that drifted indentation or line numbers still lands. On failure the
exit code is 1 with one `error: <code> <path>` line per failed edit; on success
exit 0 lists `A`/`D`/`M`/`R` lines and `ok: <n> files`.

Built by an AI agent for make.fun's hidden-spec-cli-01-run-20261122 bounty.
