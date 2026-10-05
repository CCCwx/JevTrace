import { canonical, type Detector, type Step, type Trace } from "./schema.js";

export interface Candidate {
  step_id: number;
  detector: Detector;
  rule_positive: boolean;
  evidence_step_ids: number[];
  reason: string;
  rule_uncertain?: boolean;
}
const signature = (s: Step) => canonical({ tool: s.tool, input: s.input });
const changed = (s: Step) => s.state_changed || s.effects_unknown || s.writes.length > 0;
const readLike = (s: Step) => s.reads.length > 0 || /^(read_file|search_files|search|read)$/.test(s.tool ?? "");

export function verificationEvidence(trace: Trace, index: number) {
  const step = trace.steps[index]!;
  const reason = step.verification;
  let previous = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (signature(trace.steps[i]!) === signature(step)) { previous = i; break; }
  }
  const supporting = trace.steps.slice(0, index).filter(s => reason?.related_step_ids.includes(s.id));
  const requirements = trace.requirements.filter(r => reason?.requirement_ids.includes(r.id));
  const changedSincePrevious = supporting.some(s => trace.steps.indexOf(s) > previous && (s.state_changed || s.writes.some(path =>
    requirements.some(r => !r.depends_on.length || r.depends_on.includes(path)))));
  const priorFailure = supporting.some(s => s.status === "failure" || s.checks.some(c => c.status === "failed"));
  return {
    declared_reason: reason ?? null,
    repeated_action: previous >= 0,
    support: !reason ? "missing_reason" : reason.trigger === "after_change" ? changedSincePrevious ? "recorded_change" : "no_supporting_change"
      : reason.trigger === "after_failure" ? priorFailure ? "recorded_failure" : "no_supporting_failure" : "requires_semantic_review",
  };
}

export function completionEvidence(trace: Trace, index: number) {
  return trace.requirements.map(requirement => {
    let status: "passed" | "failed" | "unknown" = "unknown";
    let step_id: number | null = null;
    let evidence: Step["checks"][number]["evidence"] | null = null;
    for (const step of trace.steps.slice(0, index)) {
      if (step.state_changed || step.effects_unknown || (step.writes.length > 0 &&
        (!requirement.depends_on.length || step.writes.some(path => requirement.depends_on.includes(path))))) {
        status = "unknown";
        step_id = step.id;
        evidence = null;
      }
      for (const check of step.checks) {
        if (check.requirement_id === requirement.id) { status = check.status; step_id = step.id; evidence = check.evidence ?? null; }
      }
    }
    return { ...requirement, status, step_id, evidence };
  });
}

export function runRules(trace: Trace): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [index, step] of trace.steps.entries()) {
    if (step.type === "finish") {
      if (step.outcome !== "blocked" && step.outcome !== "incomplete") {
        const requirements = completionEvidence(trace, index);
        const failed = requirements.filter(r => r.status === "failed");
        candidates.push({
          step_id: step.id, detector: "premature_finish",
          rule_positive: step.outcome === "success" && failed.length > 0,
          evidence_step_ids: requirements.flatMap(r => r.step_id === null ? [] : [r.step_id]),
          reason: failed.length ? `Unresolved failed requirements: ${failed.map(r => r.id).join(", ")}.`
            : "Completion requires checking explicit acceptance evidence; missing evidence alone is not proof of failure.",
        });
      }
      continue;
    }
    let priorIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (trace.steps[i]!.type === "tool_call" && signature(trace.steps[i]!) === signature(step)) { priorIndex = i; break; }
    }
    if (priorIndex >= 0) {
      const prior = trace.steps[priorIndex]!;
      const intervening = trace.steps.slice(priorIndex, index);
      const noChange = !intervening.some(changed) && !changed(step);
      const stableRead = noChange && step.intent === "work" && prior.intent === "work"
        && step.status === "success" && prior.status === "success" && readLike(step)
        && canonical(step.output) === canonical(prior.output);
      if (readLike(step) || step.intent === "verify") candidates.push({
        step_id: step.id, detector: "redundant", rule_positive: stableRead,
        rule_uncertain: noChange && step.intent === "verify" && step.status === "success" && prior.status === "success"
          && canonical(step.output) === canonical(prior.output),
        evidence_step_ids: [prior.id, ...trace.steps.slice(priorIndex + 1, index).filter(changed).map(s => s.id)],
        reason: stableRead ? "Repeated successful read with identical input/output and no recorded state change."
          : "Repeated read may be justified by polling, changed state, or new information.",
      });
      if (prior.status === "failure" || prior.checks.some(check => check.status === "failed")) candidates.push({
        step_id: step.id, detector: "bad_retry",
        rule_positive: noChange && prior.failure_kind === "persistent" && step.status === "failure"
          && step.intent !== "poll" && prior.intent !== "poll" && canonical(prior.output) === canonical(step.output),
        evidence_step_ids: [prior.id, ...trace.steps.slice(priorIndex + 1, index).filter(changed).map(s => s.id)],
        reason: "Compare the previous failure, the current attempt, and intervening changes; transient failures can justify retry.",
      });
    }
    // At least three consecutive repetitions of a block of length 1–3.
    for (let width = 1; width <= 3 && index + 1 >= width * 3; width++) {
      const window = trace.steps.slice(index + 1 - width * 3, index + 1);
      if (window.some(s => s.type !== "tool_call")) continue;
      const repeats = window.every((s, i) => signature(s) === signature(window[i % width]!));
      if (!repeats) continue;
      const stable = window.every((s, i) => canonical(s.output) === canonical(window[i % width]!.output));
      candidates.push({
        step_id: step.id, detector: "loop",
        rule_positive: stable && !window.some(changed) && window.every(s => s.intent === "work" && s.status === "success" && readLike(s)),
        rule_uncertain: stable && !window.some(changed) && window.some(s => s.intent === "verify") && !window.some(s => s.intent === "poll"),
        evidence_step_ids: window.slice(0, -1).map(s => s.id),
        reason: `An action block of length ${width} repeated three times; check whether information or state advanced.`,
      });
      break;
    }
  }
  return candidates;
}
