import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { traceSchema, type Trace } from "./schema.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
interface Call { call_id: string; name: string; input: unknown; output?: unknown }
export interface CodexTurn {
  index: number;
  id: string;
  state: "running" | "completed" | "aborted";
  goals: string[];
  calls: Call[];
  final?: string;
}
export interface CodexLog { metadata: ObjectValue; turns: CodexTurn[]; warnings: string[] }

/** Observed local JSONL format, not an official stable export contract. */
export function parseCodexLog(contents: string): CodexLog {
  const metadata: ObjectValue = {};
  const turns: CodexTurn[] = [];
  const warnings: string[] = [];
  let current: CodexTurn | undefined;
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event: ObjectValue;
    try { event = object(JSON.parse(line)); }
    catch {
      if (lines.slice(index + 1).every(s => !s.trim())) { warnings.push("Ignored incomplete trailing JSONL record."); break; }
      throw new Error(`Invalid Codex JSONL at line ${index + 1}.`);
    }
    const payload = object(event.payload);
    if (event.type === "session_meta") {
      // Never import credentials, account identifiers, system prompts, or encrypted reasoning.
      for (const key of ["id", "cwd", "originator", "timestamp", "cli_version"]) metadata[key] = payload[key] ?? null;
    }
    if (event.type === "event_msg" && payload.type === "task_started") {
      current = { index: turns.length + 1, id: text(payload.turn_id) || `turn-${turns.length + 1}`, state: "running", goals: [], calls: [] };
      turns.push(current);
      continue;
    }
    if (!current) continue; // Ignore inherited history before a new task boundary.
    if (event.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      if (payload.turn_id && payload.turn_id !== current.id) continue;
      current.state = payload.type === "task_complete" ? "completed" : "aborted";
      if (typeof payload.last_agent_message === "string") current.final = payload.last_agent_message;
      continue;
    }
    if (event.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const content = Array.isArray(payload.content) ? payload.content : [];
      const message = content.map(part => text(object(part).text)).join("\n").trim();
      if (message && !message.startsWith("<environment_context>") && !message.startsWith("<external_codex_apps_open_page>")) current.goals.push(message);
    }
    if ((payload.type === "function_call" || payload.type === "custom_tool_call") && current.state === "running") {
      const id = text(payload.call_id);
      if (!id || !text(payload.name)) { warnings.push(`Skipped incomplete tool call at line ${index + 1}.`); continue; }
      if (current.calls.some(c => c.call_id === id)) continue;
      current.calls.push({ call_id: id, name: text(payload.name), input: payload.type === "function_call" ? payload.arguments : payload.input });
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = current.calls.find(c => c.call_id === payload.call_id);
      if (call) call.output = payload.output;
    }
  }
  return { metadata, turns, warnings };
}

function jsonInput(value: unknown): ObjectValue {
  if (typeof value === "string") { try { return { arguments: JSON.parse(value) }; } catch { return { raw: value }; } }
  return { arguments: value ?? null };
}
function jsonOutput(value: unknown): ObjectValue {
  if (typeof value === "string") { try { return { result: JSON.parse(value) }; } catch { return { raw: value }; } }
  return { result: value ?? null };
}
function exitStatus(call: Call): "success" | "failure" | "unknown" {
  // Only direct shell output, never scrape an outer orchestrator's output for nested exit codes.
  if (!/^(?:functions\.)?exec_command$/.test(call.name)) return "unknown";
  const output = jsonOutput(call.output);
  const result = object(output.result);
  const code = result.exit_code;
  if (typeof code === "number") return code === 0 ? "success" : "failure";
  const raw = text(output.raw);
  const match = raw.match(/(?:^|\n)Process exited with code (-?\d+)(?:\r?\n|$)/);
  return match ? Number(match[1]) === 0 ? "success" : "failure" : "unknown";
}

export function importCodexLog(log: CodexLog, options: { turn?: number; goal?: string; sourceFile: string }): Trace {
  const selected = options.turn === undefined
    ? [...log.turns].reverse().find(t => t.state === "completed" && t.calls.length > 0)
    : log.turns.find(t => t.index === options.turn);
  if (!selected) throw new Error("No completed tool-using turn found. Use codex-list or explicitly select --turn.");
  if (!selected.calls.length) throw new Error("Selected turn has no tool calls.");
  const goal = options.goal?.trim() || selected.goals.join("\n").trim();
  if (!goal) throw new Error("No user task text found; supply --goal explicitly.");
  const warnings = [...log.warnings,
    "Tool inputs and outputs may contain private data; no automatic secret redaction is performed.",
    "Orchestrator calls are preserved as opaque operations; nested JavaScript is never executed or flattened.",
    "Shell effects and acceptance checks are not inferred. A completed turn is not proof of task success."];
  const steps: ObjectValue[] = selected.calls.map((call, index) => {
    if (call.output === undefined) warnings.push(`Missing output for imported step ${index + 1}.`);
    return { id: index + 1, type: "tool_call", tool: call.name,
      input: { ...jsonInput(call.input), codex_call_id: call.call_id },
      output: call.output === undefined ? { missing: true } : jsonOutput(call.output),
      status: exitStatus(call), effects_unknown: true,
    };
  });
  if (selected.state === "completed") steps.push({ id: steps.length + 1, type: "finish", outcome: "unknown", output: { message: selected.final ?? "Turn ended; no final message recorded." } });
  return traceSchema.parse({
    trace_id: `${text(log.metadata.id) || basename(options.sourceFile, ".jsonl")}:${selected.id}`,
    goal, requirements: [], steps,
    metadata: { source: "codex-vscode-jsonl", source_file: basename(options.sourceFile), cwd: log.metadata.cwd,
      turn_index: selected.index, turn_id: selected.id, turn_state: selected.state, adapter_warnings: warnings },
  });
}

export const defaultCodexDirectory = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
const normalized = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
export async function listCodexLogs(directory: string, cwd: string) {
  const rows: { file: string; turns: { index: number; state: string; tool_calls: number; missing_outputs: number }[] }[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const contents = await readFile(file, "utf8");
        // Filter on metadata before parsing full event history; never return other projects' contents.
        const firstLine = contents.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, "");
        let meta: ObjectValue;
        try { meta = object(object(JSON.parse(firstLine || "{}")).payload); } catch { continue; }
        if (normalized(text(meta.cwd)) !== normalized(cwd) || meta.source !== "vscode") continue;
        const log = parseCodexLog(contents);
        rows.push({ file, turns: log.turns.map(t => ({ index: t.index, state: t.state, tool_calls: t.calls.length,
          missing_outputs: t.calls.filter(c => c.output === undefined).length })) });
      }
    }
  }
  await visit(directory);
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
