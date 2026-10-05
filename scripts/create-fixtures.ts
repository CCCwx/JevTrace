import { mkdir, writeFile } from "node:fs/promises";
import { traceSchema, detectors, type Detector } from "../src/schema.js";

// Hand-authored synthetic scenarios. Reference labels express the scenario intent;
// they are never derived from rule outputs or sent to the model.
const read = (path = "checkout.ts", extra = {}) => ({ type: "tool_call", tool: "read_file", input: { path }, output: { content: `${path}:v1` }, status: "success", reads: [path], ...extra });
const edit = (path = "checkout.ts") => ({ type: "tool_call", tool: "edit_file", input: { path }, output: { changed: true }, status: "success", writes: [path] });
const test = (passed: boolean, extra = {}) => ({ type: "tool_call", tool: "run_test", input: { command: "npm test" }, output: { exit_code: passed ? 0 : 1, message: passed ? "passed" : "checkout assertion failed" }, status: passed ? "success" : "failure", failure_kind: passed ? "unknown" : "persistent", checks: [{ requirement_id: "tests", status: passed ? "passed" : "failed" }], ...extra });
const finish = (outcome = "success") => ({ type: "finish", outcome, output: { message: outcome === "success" ? "Done; requirements satisfied." : "Unable to finish; tests still fail." } });
const poll = (state = "pending") => ({ type: "tool_call", tool: "deployment_status", input: { id: "deployment-1" }, output: { state }, status: "success", intent: "poll" });
const requirement = { id: "tests", description: "Checkout tests must pass.", depends_on: ["checkout.ts"] };
type Mark = [number, Detector];
interface Scenario { id: string; description: string; steps: unknown[]; marks: Mark[]; requirements?: unknown[] }
const scenarios: Scenario[] = [
  { id: "01-clean-fix", description: "Read, fix, verify, finish", steps: [read(), edit(), test(true), finish()], marks: [] },
  { id: "02-duplicate-read", description: "Unchanged duplicate read", steps: [read(), read()], marks: [[2, "redundant"]] },
  { id: "03-triple-read", description: "Repeated reads become a loop", steps: [read(), read(), read()], marks: [[2, "redundant"], [3, "redundant"], [3, "loop"]] },
  { id: "04-alternating-loop", description: "A/B reads repeat three times", steps: [read("a.ts"), read("b.ts"), read("a.ts"), read("b.ts"), read("a.ts"), read("b.ts")], marks: [[3, "redundant"], [4, "redundant"], [5, "redundant"], [6, "redundant"], [6, "loop"]] },
  { id: "05-persistent-retry", description: "Same assertion fails without repair", steps: [test(false), test(false), finish("blocked")], marks: [[2, "bad_retry"]] },
  { id: "06-transient-retry", description: "Network outage justifies retry", steps: [test(false, { failure_kind: "transient", output: { message: "Network timeout fetching test dependencies" }, checks: [] }), test(true), finish()], marks: [] },
  { id: "07-retry-after-fix", description: "Relevant edit before rerunning", steps: [test(false), edit(), test(true), finish()], marks: [] },
  { id: "08-premature-success", description: "Claims success after failed acceptance test", steps: [test(false), finish()], marks: [[2, "premature_finish"]] },
  { id: "09-resolved-failure", description: "Later test success supersedes failure", steps: [test(false), edit(), test(true), finish()], marks: [] },
  { id: "10-stable-poll", description: "Same external status during legitimate polling", steps: [poll(), poll(), poll()], marks: [] },
  { id: "11-changing-poll", description: "Polling until deployment becomes ready", steps: [poll(), poll(), poll("ready")], marks: [] },
  { id: "12-reread-after-edit", description: "Read after mutation is necessary", steps: [read(), edit(), read()], marks: [] },
  { id: "13-new-read-information", description: "External content changed between reads", steps: [read(), read("checkout.ts", { output: { content: "checkout.ts:v2" }, state_changed: true })], marks: [] },
  { id: "14-missing-evidence", description: "Missing checks do not prove unsuccessful completion", steps: [read(), finish("unknown")], marks: [] },
  { id: "15-honest-blocked", description: "Agent reports inability to finish honestly", steps: [test(false), finish("blocked")], marks: [] },
  { id: "16-partial-requirements", description: "Tests pass but requested second file is missing", requirements: [requirement, { id: "second-file", description: "Create payment.ts", depends_on: ["payment.ts"] }], steps: [test(true), { type: "tool_call", tool: "check_files", status: "success", output: { missing: ["payment.ts"] }, checks: [{ requirement_id: "second-file", status: "failed" }] }, finish()], marks: [[3, "premature_finish"]] },
  { id: "17-intentional-verification", description: "Explicit repeated verification is legitimate", steps: [read("checkout.ts", { intent: "verify" }), read("checkout.ts", { intent: "verify" }), read("checkout.ts", { intent: "verify" })], marks: [] },
  { id: "18-semantic-persistent-retry", description: "Persistent failure must be inferred from message", steps: [test(false, { failure_kind: "unknown" }), test(false, { failure_kind: "unknown" }), finish("blocked")], marks: [[2, "bad_retry"]] },
  { id: "19-transient-backoff", description: "Repeated rate limit then recovery", steps: [test(false, { failure_kind: "transient", output: { message: "HTTP 429; retry after 1 second" }, checks: [] }), test(false, { failure_kind: "transient", output: { message: "HTTP 429; retry after 1 second" }, checks: [] }), test(true), finish()], marks: [] },
  { id: "20-failed-test-loop", description: "Three unchanged failed runs form a retry loop", steps: [test(false), test(false), test(false), finish("incomplete")], marks: [[2, "bad_retry"], [3, "bad_retry"], [3, "loop"]] },
];

await mkdir("benchmark/traces", { recursive: true });
const labels: Record<string, Record<string, Record<Detector, boolean>>> = {};
for (const scenario of scenarios) {
  const trace = traceSchema.parse({ trace_id: scenario.id, goal: "Fix checkout.ts and satisfy the explicitly listed requirements.",
    metadata: { synthetic: true, scenario: scenario.description }, requirements: scenario.requirements ?? [requirement],
    steps: scenario.steps.map((step, index) => ({ ...(step as object), id: index + 1 })) });
  labels[trace.trace_id] = {};
  for (const step of trace.steps) labels[trace.trace_id]![step.id] = Object.fromEntries(detectors.map(d => [d, false])) as Record<Detector, boolean>;
  for (const [stepId, detector] of scenario.marks) labels[trace.trace_id]![stepId]![detector] = true;
  await writeFile(`benchmark/traces/${trace.trace_id}.json`, JSON.stringify(trace, null, 2) + "\n");
}
await writeFile("benchmark/labels.json", JSON.stringify({
  provenance: "20 hand-authored synthetic coding-agent scenarios with developer-authored reference labels. Not independent human annotation or a held-out real-world benchmark.",
  traces: labels,
}, null, 2) + "\n");
console.log(`Wrote ${scenarios.length} traces and reference labels.`);
