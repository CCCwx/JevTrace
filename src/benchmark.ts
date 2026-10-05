import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { analyze, type Report } from "./analyzer.js";
import { type JevJudge } from "./judge.js";
import { detectors, labelsSchema, traceSchema, type Detector } from "./schema.js";

export function measure(reports: Report[], labels: ReturnType<typeof labelsSchema.parse>["traces"]) {
  return Object.fromEntries(detectors.map(detector => {
    let tp = 0, fp = 0, fn = 0, tn = 0, uncertain = 0, unscored = 0;
    for (const report of reports) {
      const reference = labels[report.trace_id]!;
      for (const [id, expected] of Object.entries(reference)) {
        if (expected[detector] === null) { unscored++; continue; }
        const finding = report.findings.find(f => f.step_id === Number(id) && f.detector === detector);
        const predicted = finding?.verdict.label === "positive";
        if (finding?.verdict.label === "uncertain") uncertain++;
        // Abstentions and unselected candidates are not detections; positives count as misses.
        if (predicted && expected[detector]) tp++;
        else if (predicted) fp++;
        else if (expected[detector]) fn++;
        else tn++;
      }
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null;
    return [detector, { tp, fp, fn, tn, precision, recall, f1, uncertain, unscored }];
  })) as Record<Detector, { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null; f1: number | null; uncertain: number; unscored: number }>;
}

export async function benchmark(directory: string, judge?: JevJudge) {
  const labels = labelsSchema.parse(JSON.parse(await readFile(join(directory, "labels.json"), "utf8")));
  const files = (await readdir(join(directory, "traces"))).filter(f => f.endsWith(".json")).sort();
  const traces = await Promise.all(files.map(async file => traceSchema.parse(JSON.parse(await readFile(join(directory, "traces", file), "utf8")))));
  if (!traces.length) throw new Error("No benchmark traces found.");
  const seen = new Set<string>();
  // Validate the entire dataset before making any paid calls.
  for (const trace of traces) {
    if (seen.has(trace.trace_id)) throw new Error(`Duplicate trace: ${trace.trace_id}`);
    seen.add(trace.trace_id);
    const reference = labels.traces[trace.trace_id];
    if (!reference || Object.keys(reference).length !== trace.steps.length || trace.steps.some(s => !reference[String(s.id)])) {
      throw new Error(`Labels must cover every step exactly: ${trace.trace_id}`);
    }
  }
  if (Object.keys(labels.traces).some(id => !seen.has(id))) throw new Error("Labels contain unknown traces.");
  const started = performance.now();
  const baseline: Report[] = [];
  const evaluated: Report[] = [];
  for (const trace of traces) {
    baseline.push(await analyze(trace));
    if (judge) evaluated.push(await analyze(trace, judge));
  }
  return {
    dataset_provenance: labels.provenance,
    dataset_kind: labels.dataset_kind,
    trace_count: traces.length,
    step_count: traces.reduce((sum, t) => sum + t.steps.length, 0),
    elapsed_ms: performance.now() - started,
    rules: { metrics: measure(baseline, labels.traces), reports: baseline },
    jev: judge ? { metrics: measure(evaluated, labels.traces), reports: evaluated,
      api_calls: judge.calls, cache_hits: judge.cacheHits, input_tokens: judge.inputTokens,
      output_tokens: judge.outputTokens,
      failed_or_skipped_decisions: evaluated.flatMap(r => r.findings).filter(f => f.verdict.error).length,
    } : null,
    limitations: [labels.dataset_kind === "synthetic" ? "Synthetic developer-authored reference labels are a smoke test, not an independently validated benchmark."
      : labels.dataset_kind === "real_single_reviewer" ? "Real traces were labeled by one reviewer separately from detector outputs; no independent second reviewer or inter-annotator agreement exists."
      : "Independently reviewed labels still require representative sampling and adequate positive cases.",
      "Rules and Jev are compared on the same candidate selector; selection misses remain false negatives.",
      "Abstained positive examples count as false negatives; uncertain counts are also reported.",
      "Elapsed time includes local work and cache reads; it is not model-only latency.",
      "No dollar cost is inferred; token usage covers successful uncached responses only. Failed requests may also be billed."],
  };
}
