import { describe, expect, it } from "vitest";
import { recoverWrapper } from "../scripts/lib/recover-wrapper.js";
const blocks = (...values: unknown[]) => [{ type: "text", text: "Script completed\nOutput:" }, ...values.map(value => ({ type: "text", text: JSON.stringify(value) }))];
describe("static wrapper recovery", () => {
  it("supports the input_text blocks present in real Codex rollouts", () => {
    const output = blocks({ exit_code: 0 }).map(item => ({ ...item, type: "input_text" }));
    expect(recoverWrapper('text(await tools.exec_command({cmd:"npm test"}));', output)?.[0]?.result).toEqual({ exit_code: 0 });
  });
  it("pairs explicitly emitted sequential calls", () => {
    const result = recoverWrapper('text(await tools.exec_command({cmd:"npm test"})); text(await tools.write_stdin({session_id:12}));', blocks({ session_id: 12 }, { exit_code: 0 }));
    expect(result?.map(r => r.name)).toEqual(["exec_command", "write_stdin"]);
    expect(result?.[1]?.result).toEqual({ exit_code: 0 });
  });
  it("preserves Promise.allSettled input order regardless of completion times", () => {
    const result = recoverWrapper('const results = await Promise.allSettled([tools.exec_command({cmd:"first"}), tools.exec_command({cmd:"second"})]); results.forEach(text);', blocks({ status: "fulfilled", value: { output: "first" } }, { status: "fulfilled", value: { output: "second" } }));
    expect(result?.map(r => r.arguments)).toEqual([{ cmd: "first" }, { cmd: "second" }]);
  });
  it.each([
    'text(await tools.exec_command({cmd:process.env.SECRET}));',
    'text(await tools.exec_command({cmd:(globalThis.testMutation=1)}));',
    'if (true) text(await tools.exec_command({cmd:"x"}));',
    'const x=await tools.exec_command({cmd:"x"}); text(x);',
    'text(await tools.exec_command({...settings}));',
  ])("rejects dynamic/unsupported source without executing it: %s", source => {
    expect(recoverWrapper(source, blocks({ exit_code: 0 }))).toBeNull();
    expect((globalThis as Record<string, unknown>).testMutation).toBeUndefined();
  });
  it("abstains when output cardinality or settled state does not match", () => {
    expect(recoverWrapper('text(await tools.exec_command({cmd:"x"}));', blocks({}, {}))).toBeNull();
    expect(recoverWrapper('const r=await Promise.allSettled([tools.exec_command({cmd:"x"})]); r.forEach(text);', blocks({ status: "rejected", reason: "timeout" }))).toBeNull();
  });
});
