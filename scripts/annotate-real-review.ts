import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { canonical, labelsSchema, traceSchema } from "../src/schema.js";

// Human reviewers supply the minimized traces and labels. This script only freezes
// their contents; it neither generates judgments nor certifies reviewer independence.
const { dataset } = new Command().requiredOption("--dataset <directory>", "manually reviewed dataset")
  .parse().opts<{ dataset: string }>();
const bytes = await readFile(join(dataset, "labels.json"));
const labels = labelsSchema.parse(JSON.parse(bytes.toString("utf8")));
const traces: Record<string, string> = {};
for (const [id, rows] of Object.entries(labels.traces)) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Use anonymous simple trace IDs");
  const trace = traceSchema.parse(JSON.parse(await readFile(join(dataset, "traces", `${id}.json`), "utf8")));
  if (trace.trace_id !== id) throw new Error("Trace id mismatch");
  if (Object.keys(rows).length !== trace.steps.length || trace.steps.some(step => !rows[String(step.id)])) {
    throw new Error("Every step must have explicit labels (null for unknown)");
  }
  traces[id] = createHash("sha256").update(canonical(trace)).digest("hex");
}
await writeFile(join(dataset, "review-lock.json"), JSON.stringify({
  label_sha256: createHash("sha256").update(bytes).digest("hex"), traces,
  dataset_kind: labels.dataset_kind,
  note: "Hashes freeze inputs, not annotation quality. Reviewer independence requires separate documented review."
}, null, 2) + "\n", { flag: "wx" });
console.log("Reviewed inputs frozen; no predictions or API requests.");
