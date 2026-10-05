#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { analyze, renderTerminal } from "./analyzer.js";
import { benchmark } from "./benchmark.js";
import { JevJudge } from "./judge.js";
import { traceSchema } from "./schema.js";
import { defaultCodexDirectory, importCodexLog, listCodexLogs, parseCodexLog } from "./codex.js";

interface Options {
  judge: string; model: string; threshold: number; maxCalls: number; maxInputBytes: number;
  cache: string | false; output?: string; format?: string;
}
const positiveInteger = (text: string) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvalidArgumentError("Expected a positive integer.");
  return value;
};
const probability = (text: string) => {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new InvalidArgumentError("Expected a number between 0 and 1.");
  return value;
};
function addOptions(command: Command) {
  return command.option("--judge <mode>", "rules or jev; jev sends selected trace contents to TypeSafe", "rules")
    .option("--model <id>", "fixed model version", "jev-1.13.0")
    .option("--threshold <number>", "provisional confidence threshold", probability, 0.6)
    .option("--max-calls <number>", "maximum logical SDK calls per run", positiveInteger, 100)
    .option("--max-input-bytes <number>", "local UTF-8 request limit; oversized context abstains", positiveInteger, 24000)
    .option("--cache <directory>", "local response cache (answers only)", ".jevtrace-cache")
    .option("--no-cache", "disable response cache")
    .option("--output <file>", "write output to a file");
}
function makeJudge(options: Options) {
  if (!['rules', 'jev'].includes(options.judge)) throw new Error("--judge must be rules or jev");
  if (options.judge === "rules") return undefined;
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is missing. Rules mode is available without a key.");
  if (!process.env.TYPESAFE_API_KEY.trim()) throw new Error("TYPESAFE_API_KEY is empty.");
  if (!/^jev-\d+\.\d+\.\d+$/.test(options.model) && options.cache !== false) {
    throw new Error("Use a fixed model version for reproducible caching, or pass --no-cache.");
  }
  // Disable SDK retries so max-calls bounds HTTP attempts as well as logical calls.
  const client = new TypeSafeClient({ timeout: 15000, retry: { maxRetries: 0 }, logLevel: "off" });
  return new JevJudge(client, {
    model: options.model, threshold: options.threshold, maxCalls: options.maxCalls,
    maxInputBytes: options.maxInputBytes, cacheDir: options.cache === false ? undefined : options.cache,
  });
}
async function emit(content: string, file?: string) {
  if (file) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content + "\n"); console.log(`Saved ${file}`); }
  else console.log(content);
}
const program = new Command().name("jevtrace").description("Offline coding-agent trace inspection").version("0.1.0");
program.command("codex-list").description("List local VS Code Codex logs for this workspace; no uploads")
  .option("--directory <directory>", "Codex sessions directory", defaultCodexDirectory())
  .option("--cwd <path>", "filter by workspace", process.cwd())
  .action(async (options: { directory: string; cwd: string }) => {
    console.log(JSON.stringify(await listCodexLogs(options.directory, options.cwd), null, 2));
  });
program.command("codex-import").description("Convert one local Codex turn to a trace; no uploads")
  .argument("<log>", "Codex rollout JSONL file")
  .option("--turn <number>", "1-based turn index; default latest completed turn with tool calls", positiveInteger)
  .option("--goal <text>", "explicit goal override")
  .requiredOption("--output <file>", "local destination JSON")
  .action(async (file: string, options: { turn?: number; goal?: string; output: string }) => {
    const trace = importCodexLog(parseCodexLog(await readFile(file, "utf8")), { ...options, sourceFile: file });
    await emit(JSON.stringify(trace, null, 2), options.output);
    console.log(`Imported turn ${trace.metadata.turn_index}: ${trace.steps.filter(s => s.type === "tool_call").length} opaque/direct tool calls; acceptance checks remain unknown.`);
  });
addOptions(program.command("inspect").argument("<trace>", "JSON trace"))
  .option("--format <format>", "terminal or json", "terminal")
  .action(async (file: string, options: Options) => {
    if (!['terminal', 'json'].includes(options.format ?? "")) throw new Error("--format must be terminal or json");
    const trace = traceSchema.parse(JSON.parse(await readFile(file, "utf8")));
    const judge = makeJudge(options);
    const report = await analyze(trace, judge);
    const output = { ...report, usage: judge ? { api_calls: judge.calls, cache_hits: judge.cacheHits,
      input_tokens: judge.inputTokens, output_tokens: judge.outputTokens } : null };
    await emit(options.format === "json" ? JSON.stringify(output, null, 2) : renderTerminal(report), options.output);
    if (report.findings.some(f => f.verdict.error)) process.exitCode = 2;
  });
addOptions(program.command("benchmark").argument("<directory>", "directory containing traces/ and labels.json"))
  .action(async (directory: string, options: Options) => {
    const result = await benchmark(directory, makeJudge(options));
    await emit(JSON.stringify(result, null, 2), options.output);
    if (result.jev?.failed_or_skipped_decisions) process.exitCode = 2;
  });
try { await program.parseAsync(); }
catch (error) {
  console.error(error instanceof Error ? error.message.replace(/\bsk-[\w-]+\b/g, "[REDACTED]") : "Unknown error");
  process.exitCode = 1;
}
