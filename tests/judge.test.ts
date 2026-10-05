import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildRequest, JevJudge } from "../src/judge.js";
import { runRules } from "../src/rules.js";
import { traceSchema } from "../src/schema.js";

const options = { model: "jev-1.13.0", threshold: 0.6, maxCalls: 2, maxInputBytes: 24000 };
async function sample() {
  const trace = traceSchema.parse(JSON.parse(await readFile("benchmark/traces/03-triple-read.json", "utf8")));
  return { trace, candidate: runRules(trace)[0]! };
}
function mockedClient(reply: unknown, status = 200) {
  let calls = 0;
  const requests: unknown[] = [];
  const client = new TypeSafeClient({ apiKey: "unit-test-only", retry: { maxRetries: 0 }, logLevel: "off",
    fetch: async (url, init) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      calls++; requests.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
    },
  });
  return { client, calls: () => calls, requests };
}
const response = {
  model: "jev-1.13.0",
  answers: { diagnosis: { type: "choice", choice: "positive", probabilities: { positive: 0.9, negative: 0.05, uncertain: 0.05 }, confidence: 0.85 } },
  usage: { input_tokens: 120, output_tokens: 0 },
};
describe("official SDK transport", () => {
  it("sends the real request shape without future steps or labels", async () => {
    const { trace, candidate } = await sample();
    const transport = mockedClient(response);
    const judge = new JevJudge(transport.client, options);
    const verdict = await judge.evaluate(trace, candidate);
    expect(verdict.label).toBe("positive");
    expect(judge.inputTokens).toBe(120);
    expect(transport.calls()).toBe(1);
    const request = buildRequest(trace, candidate, options.model);
    const state = JSON.parse(request.state);
    expect(state.current_step.id).toBe(2);
    expect(state.relevant_history.map((s: { id: number }) => s.id)).toEqual([1]);
    expect(JSON.stringify(transport.requests)).not.toContain("marks");
    expect(request.questions.diagnosis.type).toBe("choice");
  });
  it("reuses answers while applying the current threshold", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevtrace-test-"));
    try {
      const { trace, candidate } = await sample();
      const transport = mockedClient(response);
      const first = new JevJudge(transport.client, { ...options, cacheDir: directory });
      await first.evaluate(trace, candidate);
      const second = new JevJudge(transport.client, { ...options, threshold: 0.95, cacheDir: directory });
      expect((await second.evaluate(trace, candidate)).label).toBe("uncertain");
      expect(second.cacheHits).toBe(1);
      expect(second.inputTokens).toBe(0);
      expect(transport.calls()).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("abstains on size limits and call budget without making extra requests", async () => {
    const { trace, candidate } = await sample();
    const transport = mockedClient(response);
    const oversized = new JevJudge(transport.client, { ...options, maxInputBytes: 1 });
    expect((await oversized.evaluate(trace, candidate)).error).toContain("exceeds local limit");
    expect(transport.calls()).toBe(0);
    const limited = new JevJudge(transport.client, { ...options, maxCalls: 1 });
    await limited.evaluate(trace, candidate);
    expect((await limited.evaluate(trace, candidate)).error).toContain("budget exhausted");
    expect(transport.calls()).toBe(1);
  });
  it("surfaces API failures as abstention instead of falling back to fabricated Jev labels", async () => {
    const { trace, candidate } = await sample();
    const transport = mockedClient({ error: "service unavailable" }, 529);
    const judge = new JevJudge(transport.client, options);
    const verdict = await judge.evaluate(trace, candidate);
    expect(verdict.label).toBe("uncertain");
    expect(verdict.source).toBe("jev");
    expect(verdict.error).toBeTruthy();
    expect(judge.inputTokens).toBe(0);
    expect(transport.calls()).toBe(1);
  });
});
