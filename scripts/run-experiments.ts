import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { traceSchema } from "../src/schema.js";
import { analyze } from "../src/analyzer.js";
import { normalizeCodex } from "./lib/normalize-codex.js";

const options = new Command().option("--trace <file>", "explicit local input", "benchmark/traces/01-clean-fix.json")
  .option("--output <file>", "local report", "reports/experiments.json").parse().opts<{ trace: string; output: string }>();
const original = traceSchema.parse(JSON.parse(await readFile(options.trace, "utf8")));
const normalized = normalizeCodex(original);
const report = await analyze(normalized);
await mkdir(dirname(options.output), { recursive: true });
await writeFile(options.output, JSON.stringify({ original_steps: original.steps.length, normalized_steps: normalized.steps.length,
  new_model_requests: 0, report, limitations: ["Static recovery never executes logged code.",
  "Unknown effects and acceptance outcomes remain unknown.", "Unlabeled inputs cannot establish detection accuracy."] }, null, 2) + "\n");
console.log(`Saved ${options.output}; no API requests.`);
