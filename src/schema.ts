import { z } from "zod";

export const detectors = ["redundant", "bad_retry", "loop", "premature_finish"] as const;
export type Detector = typeof detectors[number];
export const stepSchema = z.object({
  id: z.number().int().positive(),
  type: z.enum(["tool_call", "finish"]),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  output: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["success", "failure", "unknown"]).default("unknown"),
  failure_kind: z.enum(["transient", "persistent", "unknown"]).default("unknown"),
  intent: z.enum(["poll", "verify", "work"]).default("work"),
  verification: z.object({
    reason: z.string().trim().min(1),
    trigger: z.enum(["after_change", "after_failure", "new_scope", "final_check", "state_poll"]),
    requirement_ids: z.array(z.string()).min(1),
    related_step_ids: z.array(z.number().int().positive()).default([]),
    provenance: z.enum(["agent_stated", "reviewer_inferred"]),
  }).optional(),
  // Explicit facts supplied by the producer; this prototype does not infer file state.
  reads: z.array(z.string()).default([]),
  writes: z.array(z.string()).default([]),
  state_changed: z.boolean().default(false),
  // Imported opaque commands may mutate state, without enough evidence to say how.
  effects_unknown: z.boolean().default(false),
  checks: z.array(z.object({
    requirement_id: z.string(),
    status: z.enum(["passed", "failed", "unknown"]),
    evidence: z.object({
      description: z.string().trim().min(1),
      step_ids: z.array(z.number().int().positive()).min(1),
      source_ref: z.string().trim().min(1),
    }).optional(),
  })).default([]),
  outcome: z.enum(["success", "blocked", "incomplete", "unknown"]).default("unknown"),
}).superRefine((step, ctx) => {
  if (step.type === "tool_call" && !step.tool) {
    ctx.addIssue({ code: "custom", message: "tool_call requires tool", path: ["tool"] });
  }
  if (step.type === "finish" && (step.writes.length || step.state_changed || step.checks.length)) {
    ctx.addIssue({ code: "custom", message: "finish cannot change state or supply verification checks" });
  }
});
export const traceSchema = z.object({
  trace_id: z.string().min(1),
  goal: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  requirements: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    depends_on: z.array(z.string()).default([]),
    acceptance: z.object({
      method: z.enum(["command_exit", "output_assertion", "artifact_review", "manual_review"]),
      expected: z.string().trim().min(1),
      provenance: z.enum(["user_stated", "reviewer_inferred"]),
      source_ref: z.string().trim().min(1),
    }).optional(),
  })).default([]),
  steps: z.array(stepSchema).min(1),
}).superRefine((trace, ctx) => {
  const ids = new Set<number>();
  const requirementIds = new Set<string>();
  for (const requirement of trace.requirements) {
    if (requirementIds.has(requirement.id)) ctx.addIssue({ code: "custom", message: "Duplicate requirement id" });
    requirementIds.add(requirement.id);
  }
  trace.steps.forEach((step, index) => {
    if (ids.has(step.id)) ctx.addIssue({ code: "custom", message: "Duplicate step id", path: ["steps", index, "id"] });
    ids.add(step.id);
    for (const check of step.checks) {
      if (!requirementIds.has(check.requirement_id)) ctx.addIssue({ code: "custom", message: "Unknown requirement id", path: ["steps", index, "checks"] });
      for (const id of check.evidence?.step_ids ?? []) {
        if (!trace.steps.slice(0, index + 1).some(s => s.id === id)) ctx.addIssue({ code: "custom", message: "Check evidence must reference current or earlier steps", path: ["steps", index, "checks"] });
      }
    }
    if (step.verification) {
      for (const id of step.verification.requirement_ids) {
        if (!requirementIds.has(id)) ctx.addIssue({ code: "custom", message: "Verification references unknown requirement", path: ["steps", index, "verification"] });
      }
      for (const id of step.verification.related_step_ids) {
        if (!trace.steps.slice(0, index).some(s => s.id === id)) ctx.addIssue({ code: "custom", message: "Verification reason must reference earlier steps", path: ["steps", index, "verification"] });
      }
    }
    if (step.type === "finish" && index !== trace.steps.length - 1) {
      ctx.addIssue({ code: "custom", message: "finish must be the final step", path: ["steps", index] });
    }
  });
});
export type Trace = z.infer<typeof traceSchema>;
export type Step = z.infer<typeof stepSchema>;
export const labelsSchema = z.object({
  provenance: z.string(),
  dataset_kind: z.enum(["synthetic", "real_single_reviewer", "real_independently_reviewed"]).default("synthetic"),
  traces: z.record(z.string(), z.record(z.string(), z.object({
    redundant: z.boolean().nullable(), bad_retry: z.boolean().nullable(), loop: z.boolean().nullable(), premature_finish: z.boolean().nullable(),
  }))),
});

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
