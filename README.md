# JevTrace

An offline prototype for inspecting coding agent traces. JevTrace flags redundant reads, unjustified retries, loops, and premature claims of completion. Rules mode runs locally; optional Jev mode uses the TypeSafe SDK for semantic judgments.

## Quick start

Requires Node.js 20 or later. Run these commands from the repository root. In PowerShell, use `npm.cmd` if execution policy prevents running `npm`.

```sh
npm ci
npm run typecheck
npm run typecheck:scripts
npm run build
npm test
npm run benchmark
npm run experiments
npm run dev -- inspect benchmark/traces/01-clean-fix.json --judge rules
```

No API key or private logs are needed. The benchmark uses 20 bundled synthetic traces and writes its results to `reports/rules.json`. The default experiment also uses a bundled synthetic example and makes no API requests. Run `npm run fixtures` to regenerate the synthetic fixtures.

## Optional Jev integration

Copy `.env.example` to `.env` and set `TYPESAFE_API_KEY` locally. The CLI does not automatically load `.env`; after building, load it explicitly with Node:

```sh
node --env-file=.env dist/cli.js inspect benchmark/traces/01-clean-fix.json --judge jev --max-calls 5
```

**Jev mode sends selected trace context to TypeSafe and may incur API charges.** Review the input for sensitive data before using it. Keep `.env` out of version control.

Defaults are the fixed model version `jev-1.13.0` and a provisional confidence threshold of `0.6`. Set `--max-calls` and `--max-input-bytes` to limit requests and context size; use `--no-cache` to disable the local response cache. Request failures, oversized context, and exhausted budgets produce uncertain decisions. The TypeSafe SDK is pinned to version `0.6.0`.

## Experiments with private local logs

These commands require your own Codex logs, which are not included in the repository. Logs may contain paths, session identifiers, code, prompts, and tool output. Importing and rules-based inspection run locally. **Importing does not automatically sanitize a log.**

Replace `<your-rollout.jsonl>` with the path to a log you are authorized to use:

```sh
npm run dev -- codex-list
npm run dev -- codex-import <your-rollout.jsonl> --turn 1 --output local-traces/imported.json
npm run experiments -- --trace local-traces/imported.json --output reports/local-experiment.json
npm run dev -- inspect local-traces/imported.json --judge rules
```

Log discovery uses the sessions directory under `CODEX_HOME`, or `.codex/sessions` under the current user's home directory. Use `--directory` and `--cwd` to specify the discovery scope. The importer selects one task turn and preserves unknown tool effects and acceptance outcomes as unknown. Static recovery recognizes a strict syntax subset without executing logged JavaScript; later process results remain at their original timeline positions.

The local review tools accept explicit inputs rather than fixed session identifiers:

- `scripts/prepare-real-review.ts` takes a log file and task turn, freezes a source snapshot, and creates an unlabeled worksheet.
- `scripts/annotate-real-review.ts` validates manually reviewed traces and labels, then freezes their hashes. It does not generate judgments or certify reviewer independence.
- `scripts/evaluate-real.ts` runs a local rules evaluation and verifies that the frozen traces and labels remain unchanged.

See the [real-data evaluation procedure](experiments/REAL_EVALUATION.md) for the full workflow.

## Acceptance criteria and repeated verification

Each trace can record acceptance methods, expected results, and their provenance in `requirements[].acceptance`. Step-level `checks` record whether a requirement passed and cite supporting evidence. `verification` records the specific reason for a repeated check, its trigger, related earlier steps, and relevant requirements, distinguishing agent statements from reviewer inferences.

A tool exit code or a `verify` tag alone does not establish task completion or justify repetition. File changes invalidate affected earlier checks; unknown effects conservatively clear acceptance evidence. Judgments use only the current step and its history, without future results or reference labels.

## Evaluation limitations

**Real-data annotations have not completed independent second review. Detection accuracy has not been validated.**

This repository includes synthetic fixtures only. The fixtures and rules were developed together and cannot substitute for independently labeled, held-out evaluation. Private real logs, provisional single-reviewer labels, real session identifiers, and historical API reports are excluded from this release copy.

Recall cannot be established without real positive cases; precision is undefined when there are no predicted positives. Unflagged steps are not necessarily useful work, and low confidence is not a negative label. Confidence thresholds and automatic intervention policies still require independent validation. See the [synthetic benchmark notes](benchmark/RESULTS.md) and [experiment notes](experiments/FOLLOWUP.md).

## Project structure and checks

- `src/`: CLI, schemas, rules, SDK integration, and the log adapter.
- `tests/`: offline automated tests.
- `scripts/`: fixture generation and local experiment tools.
- `benchmark/`: synthetic traces and reference labels.
- `experiments/`: experiment procedures and limitations.

GitHub Actions is configured to run type checks, builds, tests, and synthetic experiments on pushes and pull requests, without an API key. Local validation passed all 45 tests on Node.js 22; the workflow covers Node.js 20 and 22. Check its run results on GitHub after publication.

The original [design proposal](JevTrace_README.md) describes planned features and illustrative numbers, not verified implementation results. Supporting experiment documents and the publication check record are currently in Chinese.

## License and publication review

Released under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

See [PUBLICATION_CHECK.md](PUBLICATION_CHECK.md) for the release copy's privacy and validation checks. [FILE_MANIFEST.json](FILE_MANIFEST.json) records SHA-256 hashes of the delivered files, excluding the manifest itself. Any private data added later needs a separate privacy review before publication.
