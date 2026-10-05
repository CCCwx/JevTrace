import { type Trace } from "./schema.js";
import { runRules, type Candidate } from "./rules.js";
import { type JevJudge, type Verdict } from "./judge.js";

export interface Finding extends Candidate { verdict: Verdict }
export async function analyze(trace: Trace, judge?: JevJudge) {
  const findings: Finding[] = [];
  for (const candidate of runRules(trace)) {
    const verdict: Verdict = judge ? await judge.evaluate(trace, candidate)
      : { label: candidate.rule_uncertain ? "uncertain" : candidate.rule_positive ? "positive" : "negative", source: "rules" };
    findings.push({ ...candidate, verdict });
  }
  const positive = findings.filter(f => f.verdict.label === "positive");
  const wastedIds = [...new Set(positive.filter(f => f.detector !== "premature_finish").map(f => f.step_id))];
  const calls = trace.steps.filter(s => s.type === "tool_call").length;
  return {
    trace_id: trace.trace_id, goal: trace.goal,
    mode: judge ? "rules+jev" : "rules",
    findings,
    summary: {
      total_tool_calls: calls,
      flagged_tool_call_ids: wastedIds,
      estimated_wasted_calls: wastedIds.length,
      estimated_waste_ratio: calls ? wastedIds.length / calls : 0,
      premature_finish: positive.some(f => f.detector === "premature_finish"),
      uncertain_decisions: findings.filter(f => f.verdict.label === "uncertain").length,
    },
    limitations: ["Only structurally selected candidates are analyzed; unflagged steps are not proven useful.",
      "State changes and requirement checks rely on producer-supplied facts.",
      "Offline suggestions do not establish that intervention would improve a run."],
  };
}
export type Report = Awaited<ReturnType<typeof analyze>>;
export function renderTerminal(report: Report): string {
  const lines = [`JevTrace | ${report.trace_id} | ${report.mode}`, report.goal, ""];
  for (const finding of report.findings) {
    if (finding.verdict.label === "negative") continue;
    lines.push(`Step ${finding.step_id}  ${finding.detector}  ${finding.verdict.label}`,
      `  Evidence steps: ${finding.evidence_step_ids.join(", ") || "none"}`,
      `  ${finding.reason}`);
    if (finding.verdict.confidence !== undefined) lines.push(`  Model confidence: ${finding.verdict.confidence.toFixed(3)} (not measured accuracy)`);
    if (finding.verdict.error) lines.push(`  ${finding.verdict.error}`);
  }
  lines.push("", `Flagged tool calls: ${report.summary.estimated_wasted_calls}/${report.summary.total_tool_calls}`,
    `Premature finish flagged: ${report.summary.premature_finish}`,
    `Uncertain decisions: ${report.summary.uncertain_decisions}`,
    "Unflagged steps are not proven useful. Suggestions are not verified interventions.");
  return lines.join("\n");
}
