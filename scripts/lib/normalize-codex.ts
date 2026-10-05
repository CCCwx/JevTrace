import { traceSchema, type Trace } from "../../src/schema.js";
import { recoverWrapper } from "./recover-wrapper.js";

export function normalizeCodex(trace: Trace): Trace {
  const steps: Record<string, unknown>[] = [];
  const pending = new Map<number, number>();
  for (const outer of trace.steps) {
    if (outer.type === "finish") { steps.push({ ...outer, id: steps.length + 1 }); continue; }
    const calls = /^(?:functions\.)?exec$/.test(outer.tool ?? "") && typeof outer.input.raw === "string"
      ? recoverWrapper(outer.input.raw, outer.output.result) : null;
    if (!calls) { steps.push({ ...outer, id: steps.length + 1 }); continue; }
    for (const call of calls) {
      const args = typeof call.arguments === "object" ? call.arguments : { raw: call.arguments };
      const result = call.result !== null && typeof call.result === "object" ? call.result as Record<string, unknown> : { raw: call.result };
      const input: Record<string, unknown> = { ...args };
      if (call.name === "write_stdin" && typeof args.session_id === "number" && pending.has(args.session_id)) {
        input.originating_step_id = pending.get(args.session_id)!;
        if (typeof result.exit_code === "number") pending.delete(args.session_id);
      }
      const id = steps.length + 1;
      if (call.name === "exec_command" && typeof result.session_id === "number" && typeof result.exit_code !== "number") pending.set(result.session_id, id);
      const status = ["exec_command", "write_stdin"].includes(call.name) && typeof result.exit_code === "number"
        ? result.exit_code === 0 ? "success" : "failure" : "unknown";
      steps.push({ id, type: "tool_call", tool: call.name, input,
        output: { result, source_outer_step: outer.id }, status, effects_unknown: true,
        writes: call.name === "apply_patch" && typeof call.arguments === "string"
          ? [...call.arguments.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]) : [],
      });
    }
  }
  return traceSchema.parse({ ...trace, steps, metadata: { ...trace.metadata, normalization: "static-only-v1", unresolved_processes: pending.size } });
}
