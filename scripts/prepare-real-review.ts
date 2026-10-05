import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { importCodexLog, parseCodexLog } from "../src/codex.js";
import { detectors } from "../src/schema.js";
import { normalizeCodex } from "./lib/normalize-codex.js";

// This local preparation stage does not import a detector or API client.
const options = new Command().requiredOption("--log <file>", "private local rollout JSONL")
  .requiredOption("--turn <number>", "completed 1-based turn", Number)
  .option("--id <id>", "anonymous public trace identifier", "review-001")
  .option("--output <directory>", "private review directory", "local-traces/real-review").parse()
  .opts<{ log: string; turn: number; id: string; output: string }>();
if (!Number.isSafeInteger(options.turn) || options.turn < 1) throw new Error("Turn must be a positive integer");
if (!/^[a-zA-Z0-9_-]+$/.test(options.id)) throw new Error("Use a simple anonymous id");
const log = parseCodexLog(await readFile(options.log, "utf8"));
if (log.turns[options.turn - 1]?.state !== "completed") throw new Error("Select a completed turn");
const trace = normalizeCodex(importCodexLog(log, { sourceFile: options.log, turn: options.turn }));
trace.trace_id = options.id;
const snapshot = JSON.stringify(trace, null, 2) + "\n";
await mkdir(join(options.output, "raw"), { recursive: true });
await writeFile(join(options.output, "raw", `${options.id}.json`), snapshot, { flag: "wx" });
await writeFile(join(options.output, `${options.id}-worksheet.json`), JSON.stringify({
  source_snapshot_sha256: createHash("sha256").update(snapshot).digest("hex"),
  labels: Object.fromEntries(trace.steps.map(step => [step.id, Object.fromEntries(detectors.map(d => [d, null]))])),
  notes: "Unlabeled template. Manually minimize inputs, add acceptance conditions/evidence/repetition reasons, and label before predictions. Raw snapshot is private, not automatically sanitized."
}, null, 2) + "\n", { flag: "wx" });
console.log("Local snapshot and unlabeled worksheet saved. No uploads or detector predictions.");
