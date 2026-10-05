import { describe, expect, it } from "vitest";
import { importCodexLog, parseCodexLog } from "../src/codex.js";
import { completionEvidence } from "../src/rules.js";
import { traceSchema } from "../src/schema.js";

const event = (type: string, payload: object) => JSON.stringify({ type, payload });
const start = (id: string) => event("event_msg", { type: "task_started", turn_id: id });
const goal = event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix checkout" }] });
const call = (id: string) => event("response_item", { type: "custom_tool_call", call_id: id, name: "functions.exec", input: "opaque JavaScript" });
const result = (id: string) => event("response_item", { type: "custom_tool_call_output", call_id: id, output: '{"exit_code":1}' });
const done = (id: string) => event("event_msg", { type: "task_complete", turn_id: id, last_agent_message: "Done" });
describe("Codex JSONL conversion", () => {
  it("selects latest completed tool turn, pairing outputs by ID and excluding inherited history", () => {
    const log = parseCodexLog([call("inherited"), start("a"), goal, call("1"), call("2"), result("2"), result("1"), done("a"), start("b"), goal, call("3")].join("\n"));
    const trace = importCodexLog(log, { sourceFile: "rollout.jsonl" });
    expect(trace.steps).toHaveLength(3);
    expect(trace.metadata.turn_id).toBe("a");
    expect(trace.steps[0]?.input.codex_call_id).toBe("1");
    expect(trace.steps[0]?.status).toBe("unknown"); // nested exit code is not outer status
    expect(trace.steps[0]?.effects_unknown).toBe(true);
    expect(trace.steps[2]?.outcome).toBe("unknown");
  });
  it("tolerates only an incomplete trailing record", () => {
    expect(parseCodexLog([start("a"), goal, call("1"), done("a"), '{"type":'].join("\n")).warnings).toHaveLength(1);
    expect(() => parseCodexLog([start("a"), "invalid", done("a")].join("\n"))).toThrow("line 2");
  });
  it("does not manufacture a finish for interrupted turns or execute input", () => {
    const log = parseCodexLog([start("a"), goal, call("1"), event("event_msg", { type: "turn_aborted", turn_id: "a" })].join("\n"));
    const trace = importCodexLog(log, { turn: 1, sourceFile: "rollout.jsonl" });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.output).toEqual({ missing: true });
    expect(trace.metadata.turn_state).toBe("aborted");
  });
  it("requires a task goal instead of guessing from system or environment messages", () => {
    const log = parseCodexLog([start("a"), call("1"), done("a")].join("\n"));
    expect(() => importCodexLog(log, { sourceFile: "rollout.jsonl" })).toThrow("--goal");
    expect(importCodexLog(log, { sourceFile: "rollout.jsonl", goal: "Check tests" }).goal).toBe("Check tests");
  });
  it("invalidates previous acceptance checks when imported effects are unknown", () => {
    const trace = traceSchema.parse({ trace_id: "x", goal: "Tests pass", requirements: [{ id: "tests", description: "tests" }], steps: [
      { id: 1, type: "tool_call", tool: "test", checks: [{ requirement_id: "tests", status: "passed" }] },
      { id: 2, type: "tool_call", tool: "functions.exec", effects_unknown: true },
      { id: 3, type: "finish" },
    ] });
    expect(completionEvidence(trace, 2)[0]?.status).toBe("unknown");
  });
});
