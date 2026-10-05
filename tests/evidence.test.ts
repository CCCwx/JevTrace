import { describe, expect, it } from "vitest";
import { traceSchema, labelsSchema } from "../src/schema.js";
import { completionEvidence, verificationEvidence, runRules } from "../src/rules.js";
import { buildRequest } from "../src/judge.js";
import { measure } from "../src/benchmark.js";
import { analyze } from "../src/analyzer.js";

const base = {
  trace_id: "evidence", goal: "Tests pass", requirements: [{ id: "tests", description: "All tests pass", depends_on: ["src/app.ts"],
    acceptance: { method: "command_exit", expected: "Test command exits 0", provenance: "user_stated", source_ref: "task" } }],
  steps: [
    { id: 1, type: "tool_call", tool: "run_test", input: { command: "test" }, status: "success", intent: "verify", output: { result: "ok" } },
    { id: 2, type: "tool_call", tool: "edit_file", writes: ["src/app.ts"] },
    { id: 3, type: "tool_call", tool: "run_test", input: { command: "test" }, status: "success", intent: "verify", output: { result: "ok" },
      verification: { reason: "Recheck modified implementation", trigger: "after_change", requirement_ids: ["tests"], related_step_ids: [2], provenance: "reviewer_inferred" },
      checks: [{ requirement_id: "tests", status: "passed", evidence: { description: "exit code 0", step_ids: [3], source_ref: "source:3:output" } }] },
    { id: 4, type: "finish", outcome: "success" },
  ],
};
describe("acceptance and verification evidence", () => {
  it("exposes concrete acceptance evidence and retrospective provenance to the judge", () => {
    const trace = traceSchema.parse(base);
    const req = buildRequest(trace, { step_id: 4, detector: "premature_finish", rule_positive: false, evidence_step_ids: [3], reason: "check" }, "jev-1.13.0");
    const state = JSON.parse(req.state);
    expect(state.acceptance_evidence[0].evidence.source_ref).toBe("source:3:output");
    expect(state.acceptance_evidence[0].acceptance.expected).toBe("Test command exits 0");
    expect(verificationEvidence(trace, 2).support).toBe("recorded_change");
  });
  it("does not justify a repeat using an unrelated edit or an edit predating the previous run", () => {
    const unrelated = structuredClone(base);
    unrelated.steps[1]!.writes = ["README.md"];
    expect(verificationEvidence(traceSchema.parse(unrelated), 2).support).toBe("no_supporting_change");
    const old = traceSchema.parse(base);
    old.steps = [old.steps[1]!, old.steps[0]!, old.steps[2]!, old.steps[3]!];
    expect(verificationEvidence(traceSchema.parse(old), 2).support).toBe("no_supporting_change");
  });
  it("rejects future references and unknown acceptance IDs", () => {
    const future = structuredClone(base);
    future.steps[2]!.verification!.related_step_ids = [4];
    expect(() => traceSchema.parse(future)).toThrow("earlier steps");
    const missing = structuredClone(base);
    missing.steps[2]!.verification!.requirement_ids = ["missing"];
    expect(() => traceSchema.parse(missing)).toThrow("unknown requirement");
    const futureCheck = structuredClone(base);
    futureCheck.steps[2]!.checks![0]!.evidence.step_ids = [4];
    expect(() => traceSchema.parse(futureCheck)).toThrow("current or earlier");
  });
  it("does not turn a verification tag alone into a proven exemption", async () => {
    const step = { id: 1, type: "tool_call", tool: "read_file", status: "success", intent: "verify", input: { path: "a" }, output: { content: "same" } };
    const trace = traceSchema.parse({ trace_id: "unbacked", goal: "inspect", steps: [step, { ...step, id: 2 }] });
    const report = await analyze(trace);
    expect(report.findings[0]?.verdict.label).toBe("uncertain");
  });
  it("selects failed acceptance checks for retry review even when the command exits successfully", () => {
    const trace = traceSchema.parse(base);
    trace.steps[0]!.checks = [{ requirement_id: "tests", status: "failed" }];
    expect(runRules(trace).find(c => c.step_id === 3 && c.detector === "bad_retry")).toBeDefined();
  });
  it("keeps unknown ground truth out of both correct-negative and error counts", async () => {
    const trace = traceSchema.parse(base);
    const report = await analyze(trace);
    const labels = labelsSchema.parse({ provenance: "review", traces: { evidence: Object.fromEntries(trace.steps.map(s => [s.id, { redundant: null, bad_retry: null, loop: null, premature_finish: null }])) } });
    const metrics = measure([report], labels.traces).redundant;
    expect(metrics.unscored).toBe(4);
    expect(metrics.tn).toBe(0);
    expect(metrics.precision).toBeNull();
    expect(metrics.recall).toBeNull();
  });
  it("invalidates recorded check evidence after relevant changes", () => {
    const trace = traceSchema.parse(base);
    trace.steps.splice(3, 0, traceSchema.parse({ ...base, steps: [{ id: 5, type: "tool_call", tool: "edit", writes: ["src/app.ts"] }] }).steps[0]!);
    const evidence = completionEvidence(trace, 4)[0]!;
    expect(evidence.status).toBe("unknown");
    expect(evidence.evidence).toBeNull();
  });
});
