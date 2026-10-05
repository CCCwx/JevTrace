import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/analyzer.js";
import { benchmark, measure } from "../src/benchmark.js";
import { runRules, completionEvidence } from "../src/rules.js";
import { traceSchema } from "../src/schema.js";

async function fixture(id: string) {
  return traceSchema.parse(JSON.parse(await readFile(`benchmark/traces/${id}.json`, "utf8")));
}
describe("behavioral safeguards", () => {
  it.each(["01-clean-fix", "06-transient-retry", "07-retry-after-fix", "09-resolved-failure", "10-stable-poll", "11-changing-poll", "12-reread-after-edit", "13-new-read-information", "14-missing-evidence", "15-honest-blocked", "17-intentional-verification", "19-transient-backoff"])("does not flag legitimate behavior: %s", async id => {
    const report = await analyze(await fixture(id));
    expect(report.findings.filter(f => f.verdict.label === "positive")).toEqual([]);
  });
  it("counts a read flagged as redundant and looping only once", async () => {
    const report = await analyze(await fixture("03-triple-read"));
    expect(report.summary.flagged_tool_call_ids).toEqual([2, 3]);
    expect(report.summary.estimated_wasted_calls).toBe(2);
    expect(report.findings.filter(f => f.verdict.label === "positive")).toHaveLength(3);
  });
  it("uses explicit failed acceptance evidence for premature completion", async () => {
    expect((await analyze(await fixture("08-premature-success"))).summary.premature_finish).toBe(true);
    expect((await analyze(await fixture("16-partial-requirements"))).summary.premature_finish).toBe(true);
  });
  it("invalidates a passing check after a relevant write", async () => {
    const trace = await fixture("01-clean-fix");
    const modified = traceSchema.parse({ ...trace, steps: [trace.steps[2], { ...trace.steps[1], id: 5 }, { ...trace.steps[3], id: 6 }] });
    expect(completionEvidence(modified, 2)[0]?.status).toBe("unknown");
    expect(runRules(modified).find(c => c.detector === "premature_finish")?.rule_positive).toBe(false);
  });
  it("does not invalidate verification for an unrelated file", async () => {
    const trace = await fixture("01-clean-fix");
    const modified = traceSchema.parse({ ...trace, steps: [trace.steps[2], { ...trace.steps[1], id: 5, writes: ["docs.md"] }, { ...trace.steps[3], id: 6 }] });
    expect(completionEvidence(modified, 2)[0]?.status).toBe("passed");
  });
  it("rejects unsupported finish evidence and duplicate step ids", async () => {
    const trace = await fixture("01-clean-fix");
    expect(() => traceSchema.parse({ ...trace, steps: [trace.steps[0], trace.steps[0]] })).toThrow();
    expect(() => traceSchema.parse({ ...trace, steps: [{ ...trace.steps[3], checks: [{ requirement_id: "tests", status: "passed" }] }] })).toThrow();
  });
});
describe("evaluation integrity", () => {
  it("evaluates all 20 fixtures and keeps selection misses", async () => {
    const result = await benchmark("benchmark");
    expect(result.trace_count).toBe(20);
    expect(result.jev).toBeNull();
    expect(result.rules.metrics.bad_retry.fn).toBe(1);
    expect(result.rules.metrics.loop.fn).toBe(1);
    expect(result.rules.metrics.redundant.fp).toBe(0);
  });
  it("counts abstained positives as misses, not successful detections", async () => {
    const trace = await fixture("08-premature-success");
    const report = await analyze(trace);
    report.findings[0]!.verdict = { label: "uncertain", source: "jev" };
    const labels = { [trace.trace_id]: {
      "1": { redundant: false, bad_retry: false, loop: false, premature_finish: false },
      "2": { redundant: false, bad_retry: false, loop: false, premature_finish: true },
    } };
    const metrics = measure([report], labels).premature_finish;
    expect(metrics.fn).toBe(1);
    expect(metrics.tp).toBe(0);
    expect(metrics.uncertain).toBe(1);
  });
  it("all fixtures have explicit status and stable identity", async () => {
    const files = await readdir("benchmark/traces");
    expect(files).toHaveLength(20);
    for (const file of files) expect((await fixture(file.replace(/\.json$/, ""))).trace_id).toBe(file.replace(/\.json$/, ""));
  });
});
