import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { canonical, labelsSchema, traceSchema } from "../src/schema.js";
import { benchmark } from "../src/benchmark.js";

// Local-only evaluation. For an explicitly authorized external evaluation, use the
// CLI benchmark --judge jev on the reviewed minimized dataset after privacy review.
const { dataset, output } = new Command().requiredOption("--dataset <directory>", "reviewed frozen dataset")
  .option("--output <file>", "local ledger", "reports/real-rules.json").parse()
  .opts<{ dataset: string; output: string }>();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const lock = JSON.parse(await readFile(join(dataset, "review-lock.json"), "utf8")) as { label_sha256: string; traces: Record<string, string> };
async function verify() {
  const bytes = await readFile(join(dataset, "labels.json"));
  if (hash(bytes) !== lock.label_sha256) throw new Error("Labels changed: review and freeze a new version first");
  const labels = labelsSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (Object.keys(labels.traces).sort().join() !== Object.keys(lock.traces).sort().join()) throw new Error("Dataset inventory changed");
  for (const id of Object.keys(labels.traces)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid trace id");
    const trace = traceSchema.parse(JSON.parse(await readFile(join(dataset, "traces", `${id}.json`), "utf8")));
    if (hash(canonical(trace)) !== lock.traces[id]) throw new Error("Trace changed: review again");
  }
  return labels;
}
const labels = await verify();
const result = await benchmark(dataset);
await verify();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ mode: "rules", new_model_requests: 0, label_sha256: lock.label_sha256,
  reviewed_inputs_unchanged: true, dataset_kind: labels.dataset_kind,
  independent_review_verified_by_script: false, result }, null, 2) + "\n");
console.log(`Saved ${output}; reviewed inputs unchanged; no API requests.`);
