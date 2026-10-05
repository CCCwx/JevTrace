# JevTrace — design proposal

> This is an early design proposal, not a report of completed features or measured accuracy. Example numbers are illustrative. See README.md for the implemented scope. Real-data annotations have not completed independent second review; detection accuracy is not validated.

> **A lightweight semantic debugger for AI agent traces.**  
> Your agent finished — but did it waste half its steps?

JevTrace analyzes an AI agent's execution trace and identifies where the agent made progress, repeated unnecessary actions, retried without changing strategy, entered a loop, or stopped too early.

Instead of asking a large language model to generate a long free-form critique, JevTrace uses **Jev-style typed decisions** to make small, structured judgments about each step in the trace.

The goal is simple:

> **Make agent failures easier to see, measure, and debug.**

---

## Why JevTrace?

Modern AI agents often fail in ways that are hard to notice from the final answer alone.

An agent may:

- read the same file repeatedly;
- call the same tool without gaining new information;
- retry a failed command without changing its strategy;
- continue working after the task is already complete;
- claim success while tests are still failing;
- loop between a small set of actions;
- spend unnecessary tokens and tool calls before reaching the answer.

Traditional logs tell us **what happened**.

JevTrace tries to tell us:

> **Was that step actually useful?**

---

## Example

Suppose a coding agent produces this trace:

```text
User:
Fix the checkout bug.

Step 1
search_files("checkout")

Step 2
read_file("checkout.ts")

Step 3
read_file("checkout.ts")

Step 4
read_file("checkout.ts")

Step 5
edit_file("checkout.ts")

Step 6
run_test("npm test")
→ FAILED

Step 7
run_test("npm test")
→ FAILED

Step 8
finish()
```

Run:

```bash
jevtrace inspect trace.json
```

JevTrace may produce:

```text
JevTrace Analysis
────────────────────────────────────────────

Step 1  search_files     useful
Step 2  read_file        useful
Step 3  read_file        redundant       0.91
Step 4  read_file        looping         0.94
Step 5  edit_file        useful
Step 6  run_test         useful
Step 7  run_test         bad_retry       0.89
Step 8  finish           premature       0.97

Summary
────────────────────────────────────────────

Useful steps:            4 / 8
Redundant steps:         2
Bad retries:             1
Premature finish:        yes
Estimated wasted calls:  3

Suggested interventions
────────────────────────────────────────────

After Step 3:
Stop repeating read_file.
Confidence: 0.93

After Step 6:
Change strategy before retrying the test.
Confidence: 0.87

Before Step 8:
Do not finish while tests are still failing.
Confidence: 0.99
```

---

# Core Idea

JevTrace separates agent execution into three roles:

```text
Agent
  │
  │ produces actions
  ▼
Execution Trace
  │
  │ analyzed step by step
  ▼
JevTrace
  │
  ├── progress judgment
  ├── redundancy judgment
  ├── retry judgment
  ├── loop judgment
  └── completion judgment
  │
  ▼
Structured Report
```

The agent itself does not need to use Jev.

JevTrace can analyze traces **after execution**, which keeps the first version lightweight and framework-independent.

---

# What JevTrace Detects

## 1. Useful vs. Redundant Steps

For every agent step:

```text
useful
redundant
harmful
uncertain
```

Example:

```text
read_file("checkout.ts")
read_file("checkout.ts")
read_file("checkout.ts")
```

The first read may be useful.

The second may be redundant.

The third may indicate a loop.

---

## 2. Bad Retries

A retry is not automatically bad.

For example:

```text
npm test
→ network timeout

npm test
→ success
```

may be reasonable.

But:

```text
npm test
→ 3 unit tests failed

npm test
→ same 3 unit tests failed

npm test
→ same 3 unit tests failed
```

without any code change is probably a bad retry.

JevTrace classifies retries as:

```text
reasonable_retry
bad_retry
strategy_changed
uncertain
```

---

## 3. Agent Loops

JevTrace detects repeated action patterns such as:

```text
read A
read B
read A
read B
read A
read B
```

or:

```text
search
read
search
read
search
read
```

A loop can be detected using both:

1. deterministic structural checks;
2. semantic Jev judgments.

This hybrid design is intentional.

Simple repetition should be detected with code.

Semantic repetition should be judged by the model.

---

## 4. Premature Completion

One of the most important failure modes in autonomous agents is:

> **The agent says it is done when the evidence says it is not done.**

Examples:

```text
tests failed
→ finish
```

```text
deployment failed
→ finish
```

```text
user asked for three files
→ only two created
→ finish
```

JevTrace evaluates:

```text
should_stop: yes / no
```

and compares that result against the actual agent behavior.

---

## 5. Wasted Tool Calls

JevTrace estimates how many calls did not materially help the task.

Example output:

```text
Total tool calls:          23
Useful tool calls:         16
Redundant tool calls:       4
Bad retries:                2
Likely wasted calls:        6
Waste ratio:              26%
```

This can later be converted into:

```text
estimated wasted tokens
estimated wasted latency
estimated wasted cost
```

---

# "Could Jev Have Prevented This?"

A key feature of JevTrace is counterfactual intervention analysis.

Instead of only saying:

> Step 7 was bad.

JevTrace asks:

> **At what point could a lightweight decision model have changed the trajectory?**

Example:

```text
Actual execution

1. search files
2. read checkout.ts
3. read checkout.ts
4. read checkout.ts
5. edit checkout.ts
6. run tests → failed
7. run tests → failed
8. finish
```

JevTrace:

```text
Potential intervention points

Step 3
Action: STOP_REPEATING
Reason: repeated file read with no new information
Confidence: 0.93

Step 6
Action: CHANGE_STRATEGY
Reason: test failure requires modification before retry
Confidence: 0.87

Step 8
Action: CONTINUE
Reason: completion condition is not satisfied
Confidence: 0.99
```

This makes JevTrace useful not only as a debugger, but also as a way to study where **System One decision models** can improve agent reliability.

---

# Design Principles

## Lightweight First

The MVP should not require:

- a database;
- distributed tracing;
- a web backend;
- LangGraph;
- OpenTelemetry;
- a custom agent runtime;
- model training;
- vector databases.

The first version should work with:

```bash
jevtrace inspect trace.json
```

and generate a terminal or HTML report.

---

## Typed Decisions Over Free-Form Critiques

Instead of:

```text
Please analyze this agent execution and explain what went wrong.
```

JevTrace asks narrow questions such as:

```text
Was this step useful?

A. useful
B. redundant
C. harmful
D. uncertain
```

or:

```text
Should the agent stop at this point?

A. yes
B. no
```

The result is easier to:

- evaluate;
- threshold;
- aggregate;
- benchmark;
- visualize;
- compare across traces.

---

## Code Handles Rules, Jev Handles Semantics

Not every problem needs a model.

Example:

```text
tool call #5 == tool call #6
input #5 == input #6
output #5 == output #6
```

This can be detected deterministically.

But:

```text
search("payment flow")
search("checkout error")
```

may or may not be semantically redundant.

That is where Jev is useful.

The intended design is:

```text
Deterministic checks
        +
Semantic Jev judgments
        =
Final trace diagnosis
```

---

# Architecture

```text
                    trace.json
                        │
                        ▼
               ┌────────────────┐
               │  Trace Parser  │
               └───────┬────────┘
                       │
                       ▼
               ┌────────────────┐
               │ Normalized     │
               │ Trace Schema   │
               └───────┬────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
    ┌────────────────┐  ┌────────────────┐
    │ Deterministic  │  │ Jev Analyzer   │
    │ Checks         │  │                │
    │                │  │ progress       │
    │ exact repeats  │  │ redundancy     │
    │ repeated error │  │ retry quality  │
    │ duplicate call │  │ should stop    │
    └───────┬────────┘  └───────┬────────┘
            │                   │
            └─────────┬─────────┘
                      ▼
              ┌────────────────┐
              │ Aggregator     │
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │ Report         │
              │                │
              │ terminal       │
              │ JSON           │
              │ HTML           │
              └────────────────┘
```

---

# Trace Schema

The MVP uses one simple internal schema.

Example:

```json
{
  "trace_id": "checkout-fix-001",
  "goal": "Fix the checkout bug and make all tests pass.",
  "metadata": {
    "agent": "example-agent",
    "model": "gpt-5",
    "started_at": "2026-10-04T12:00:00Z"
  },
  "steps": [
    {
      "id": 1,
      "type": "tool_call",
      "tool": "search_files",
      "input": {
        "query": "checkout"
      },
      "output": {
        "files": [
          "src/checkout.ts",
          "src/payment.ts"
        ]
      }
    },
    {
      "id": 2,
      "type": "tool_call",
      "tool": "read_file",
      "input": {
        "path": "src/checkout.ts"
      },
      "output": {
        "content": "..."
      }
    },
    {
      "id": 3,
      "type": "tool_call",
      "tool": "run_test",
      "input": {
        "command": "npm test"
      },
      "output": {
        "exit_code": 1,
        "stderr": "3 tests failed"
      }
    },
    {
      "id": 4,
      "type": "finish",
      "output": {
        "message": "The issue has been fixed."
      }
    }
  ]
}
```

---

# Step Analysis Schema

Each step can produce:

```json
{
  "step_id": 7,
  "progress": {
    "label": "redundant",
    "confidence": 0.91
  },
  "retry": {
    "label": "bad_retry",
    "confidence": 0.89
  },
  "loop": {
    "label": "likely_loop",
    "confidence": 0.94
  },
  "completion": {
    "should_stop": false,
    "confidence": 0.97
  }
}
```

---

# Suggested Decision Labels

## Progress

```text
useful
redundant
harmful
uncertain
```

## Retry

```text
not_retry
reasonable_retry
bad_retry
strategy_changed
uncertain
```

## Loop

```text
no_loop
possible_loop
likely_loop
```

## Completion

```text
should_continue
should_stop
uncertain
```

## Intervention

```text
none
stop_repeating
change_strategy
retry
rollback
ask_user
continue
finish
```

---

# CLI

## Inspect a trace

```bash
jevtrace inspect trace.json
```

---

## JSON output

```bash
jevtrace inspect trace.json --format json
```

---

## HTML report

```bash
jevtrace inspect trace.json --format html
```

Output:

```text
report.html
```

---

## Verbose mode

```bash
jevtrace inspect trace.json --verbose
```

Shows individual Jev decisions and confidence scores.

---

## Only analyze suspicious steps

```bash
jevtrace inspect trace.json --suspicious-only
```

---

# Example Terminal Report

```text
╭──────────────────────────────────────────────╮
│ JevTrace                                     │
│ Lightweight semantic debugger for AI agents │
╰──────────────────────────────────────────────╯

Trace: checkout-fix-001
Goal:  Fix the checkout bug and make all tests pass.

┌──────┬──────────────┬────────────────┬────────────┐
│ Step │ Tool         │ Judgment       │ Confidence │
├──────┼──────────────┼────────────────┼────────────┤
│ 1    │ search_files │ useful         │ 0.96       │
│ 2    │ read_file    │ useful         │ 0.94       │
│ 3    │ read_file    │ redundant      │ 0.91       │
│ 4    │ read_file    │ likely_loop    │ 0.94       │
│ 5    │ edit_file    │ useful         │ 0.93       │
│ 6    │ run_test     │ useful         │ 0.99       │
│ 7    │ run_test     │ bad_retry      │ 0.89       │
│ 8    │ finish       │ premature      │ 0.97       │
└──────┴──────────────┴────────────────┴────────────┘

Trace score: 61 / 100

Useful steps:       4
Redundant steps:    2
Bad retries:        1
Loop detected:      yes
Premature finish:   yes
Estimated waste:    37.5%

Recommended interventions:

[Step 3]
STOP_REPEATING
The same file was read repeatedly without a meaningful state change.

[Step 6]
CHANGE_STRATEGY
The test failed. Modify the implementation before retrying.

[Step 8]
CONTINUE
The agent should not finish while tests are still failing.
```

---

# Trace Score

JevTrace may optionally calculate a simple trace quality score.

Example:

```text
100
 - 10 × redundant steps
 - 15 × bad retries
 - 20 × detected loops
 - 25 × premature completion
```

The exact scoring function should remain configurable.

The score is not intended to be a universal measure of agent quality.

It is primarily useful for:

- comparing two agent configurations;
- regression testing;
- benchmark experiments;
- spotting major behavior changes.

---

# Benchmark

A small benchmark makes the project much stronger.

The MVP benchmark can contain approximately 50 manually labeled traces.

Suggested categories:

```text
10 normal traces
10 redundant-step traces
10 looping traces
10 bad-retry traces
10 premature-completion traces
```

Each trace should contain human labels for the relevant steps.

---

# Benchmark Metrics

JevTrace can report:

```text
Precision
Recall
F1
Accuracy
Latency
Cost per trace
Cost per step
```

For example:

```text
                     Precision    Recall     F1

Redundant Step          0.91        0.88     0.89
Bad Retry               0.89        0.92     0.90
Loop Detection          0.94        0.90     0.92
Premature Finish        0.96        0.93     0.94
```

These numbers must come from real experiments.

Do not hard-code or fabricate benchmark results.

---

# Baselines

For evaluation, JevTrace should eventually compare:

```text
Rule-based detector
Jev
Small LLM judge
Large LLM judge
```

This allows the project to answer a more interesting question:

> **Which agent decisions actually require a large language model?**

Example experiment:

```text
                   F1       Latency       Cost

Rules             0.62       2 ms         ~$0
Jev               0.91      80 ms         low
Small LLM         0.89     420 ms         medium
Large LLM         0.94    1200 ms         high
```

Again, actual numbers should only be published after running the benchmark.

---

# MVP Scope

The first release should stay deliberately small.

## v0.1

Support:

```text
✓ custom JSON trace format
✓ deterministic duplicate-call detection
✓ step usefulness judgment
✓ bad retry detection
✓ loop detection
✓ premature completion detection
✓ terminal report
✓ JSON report
✓ 10–20 example traces
```

Do not build adapters yet.

---

# v0.2

Add:

```text
✓ HTML report
✓ trace quality score
✓ intervention suggestions
✓ confidence thresholds
✓ basic benchmark runner
```

---

# v0.3

Add adapters for one or two popular frameworks.

Potential candidates:

```text
OpenAI Agents SDK
LangGraph
Claude Code exports
OpenTelemetry agent traces
```

Do not support all of them at once.

---

# v0.4

Add live monitoring:

```text
Agent
  │
  ▼
JevTrace middleware
  │
  ├── allow
  ├── warn
  ├── interrupt
  └── continue
```

This moves JevTrace from:

```text
offline debugger
```

toward:

```text
runtime supervisor
```

without requiring that complexity in the MVP.

---

# Proposed Repository Structure

```text
jevtrace/
├── src/
│   ├── cli.ts
│   ├── parser.ts
│   ├── schema.ts
│   ├── analyzer.ts
│   ├── jev.ts
│   ├── rules.ts
│   ├── aggregator.ts
│   ├── report.ts
│   └── scoring.ts
│
├── examples/
│   ├── good-agent.json
│   ├── looping-agent.json
│   ├── premature-finish.json
│   └── bad-retry.json
│
├── benchmark/
│   ├── traces/
│   ├── labels.json
│   └── evaluate.ts
│
├── tests/
│   ├── parser.test.ts
│   ├── rules.test.ts
│   └── analyzer.test.ts
│
├── package.json
├── tsconfig.json
├── .env.example
├── LICENSE
└── README.md
```

---

# Suggested Tech Stack

For a lightweight implementation:

```text
Language:        TypeScript
Runtime:         Node.js
CLI:             Commander.js
Validation:      Zod
Terminal UI:     Chalk + cli-table3
Model:           Jev / System One API
Tests:           Vitest
HTML report:     static HTML template
```

A Python implementation would also work, but TypeScript is a natural fit if the project is aimed at agent tooling and npm distribution.

---

# Pseudocode

```ts
const trace = parseTrace("trace.json");

const analyses = [];

for (const step of trace.steps) {
  const deterministic = runRuleChecks(trace, step);

  const semantic = await analyzeWithJev({
    goal: trace.goal,
    history: getRelevantHistory(trace, step),
    currentStep: step,
  });

  analyses.push(
    mergeAnalysis(deterministic, semantic)
  );
}

const report = aggregate(trace, analyses);

renderTerminal(report);
```

---

# Jev Analysis Example

Conceptually:

```ts
const progress = await jev.choice({
  question: `
    Given the user's goal, previous steps, and the current action,
    did this step materially advance the task?
  `,
  options: [
    "useful",
    "redundant",
    "harmful",
    "uncertain",
  ],
});
```

Completion check:

```ts
const completion = await jev.choice({
  question: `
    Based on the task goal and evidence available so far,
    should the agent stop now?
  `,
  options: [
    "should_stop",
    "should_continue",
    "uncertain",
  ],
});
```

Retry check:

```ts
const retry = await jev.choice({
  question: `
    Is the current action a reasonable retry,
    a bad retry, or a meaningfully changed strategy?
  `,
  options: [
    "not_retry",
    "reasonable_retry",
    "bad_retry",
    "strategy_changed",
    "uncertain",
  ],
});
```

---

# Confidence Thresholds

Not every decision should be treated equally.

Example:

```text
confidence < 0.60
→ uncertain

0.60 ≤ confidence < 0.80
→ weak signal

confidence ≥ 0.80
→ strong signal
```

Thresholds should eventually be calibrated using benchmark data rather than chosen arbitrarily.

---

# Failure Modes

JevTrace itself can make mistakes.

Important cases include:

## Legitimate repetition

Repeated actions may be intentional.

Example:

```text
poll deployment status
poll deployment status
poll deployment status
```

This is not necessarily a loop.

---

## Hidden state changes

Two identical tool calls may return different state because the external environment changed.

---

## Long-horizon usefulness

A step may appear useless locally but become important later.

---

## Ambiguous completion

For open-ended tasks, there may be no objectively correct stopping point.

---

## Model calibration

A high confidence score does not automatically mean the decision is correct.

For that reason, JevTrace should expose probabilities and support threshold tuning.

---

# Privacy

Agent traces may contain:

- source code;
- API responses;
- credentials;
- internal file paths;
- customer information;
- private prompts.

JevTrace should eventually support:

```text
redaction
field exclusion
local preprocessing
maximum context limits
```

The MVP should clearly warn users not to upload secrets.

---

# What JevTrace Is Not

JevTrace is not:

```text
a full agent framework
a replacement for LangGraph
a tracing database
an observability SaaS
a model training framework
a generic MCP wrapper
a coding agent
```

It is intentionally narrow:

> **A semantic debugger for agent execution traces.**

---

# Why Jev?

Most agent trace analysis tools either rely on:

```text
hard-coded rules
```

or ask a generative LLM for:

```text
long free-form explanations
```

Jev-style decision models occupy a useful middle ground:

```text
fast
typed
probabilistic
cheap
easy to evaluate
easy to threshold
```

This makes them a natural fit for questions such as:

```text
Was this step useful?
Is this retry reasonable?
Is the agent looping?
Should the agent stop?
```

These are judgment problems, not text-generation problems.

---

# Future Research Questions

JevTrace can eventually help explore:

```text
Can small decision models detect agent loops earlier than LLM judges?

How much agent cost can be avoided by stopping redundant actions?

Which agent decisions require frontier-model reasoning?

Can System One models reliably supervise System Two agents?

How should confidence thresholds vary across tasks?

Can offline trace analysis predict live agent failures?

Can trace-level signals be used to automatically improve prompts or policies?
```

---

# Potential Extensions

Possible future modules:

```text
jevtrace compare
jevtrace benchmark
jevtrace replay
jevtrace watch
jevtrace intervene
```

Example:

```bash
jevtrace compare run-a.json run-b.json
```

Output:

```text
Run A

28 steps
6 redundant
2 bad retries
1 loop

Run B

19 steps
1 redundant
0 bad retries
0 loops

Estimated efficiency improvement: 32%
```

---

# Roadmap

## Phase 1 — MVP

```text
Custom trace schema
CLI
Jev integration
Redundancy detection
Retry detection
Loop detection
Premature completion detection
Terminal report
```

## Phase 2 — Evaluation

```text
Manual benchmark dataset
Precision / recall metrics
Latency tracking
Cost tracking
Threshold experiments
Baseline comparison
```

## Phase 3 — Integrations

```text
OpenAI Agents adapter
LangGraph adapter
Claude Code adapter
HTML report
```

## Phase 4 — Runtime Supervision

```text
Live trace streaming
Intervention hooks
Policy engine
Human approval
Automatic strategy switching
```

---

# Project Positioning

The project should be described as:

> **JevTrace is a lightweight semantic debugger for AI agent execution traces. It uses typed probabilistic decisions to detect redundant actions, bad retries, loops, and premature completion, helping developers understand where autonomous agents waste steps or fail to satisfy task goals.**

Short version:

> **JevTrace finds the steps your AI agent should not have taken.**

---

# Resume Version

Example resume bullet:

> Built **JevTrace**, a lightweight semantic debugger for AI agents that analyzes execution traces using typed decision models to detect redundant tool calls, retry loops, and premature completion; designed an evaluation pipeline for measuring detection accuracy, latency, and agent-step waste.

A stronger version after completing a real benchmark:

> Built **JevTrace**, a semantic debugging and evaluation tool for AI agent traces, combining deterministic checks with Jev-based probabilistic judgments to identify redundant actions, failed retry loops, and premature completion across agent runs; benchmarked detection quality against rule-based and LLM-judge baselines.

Do not include performance numbers until they have been measured.

---

# Demo Story

A strong demo should take less than one minute.

```text
1. Show a bad agent trace.
2. Run `jevtrace inspect trace.json`.
3. JevTrace highlights:
   - repeated file reads;
   - a failed retry;
   - premature completion.
4. Show the suggested intervention point.
5. Compare with a cleaner trace.
```

The audience should understand the value immediately.

---

# Success Criteria

The project is successful if a developer can:

```text
install JevTrace
point it at a trace
understand where the agent wasted steps
identify why the agent failed
compare two agent runs
```

without needing to adopt a new agent framework.

---

# Non-Goals for v0.1

Do not build:

```text
authentication
accounts
billing
cloud hosting
multi-user dashboards
distributed workers
vector search
complex frontend
training infrastructure
large framework integrations
```

Keeping the first release small is a feature.

---

# Development Plan

A realistic lightweight sequence:

```text
Day 1
Define schema + parser + sample traces

Day 2
Implement deterministic repeat/retry checks

Day 3
Integrate Jev judgments

Day 4
Build terminal report

Day 5
Create test traces + refine prompts

Day 6
Add benchmark runner

Day 7
Polish README + record demo
```

The exact schedule is flexible, but the project should remain small enough that a complete MVP can be built quickly.

---

# Naming

Current name:

```text
JevTrace
```

Possible alternatives:

```text
TraceJev
AgentTrace
AgentReflex
StepJudge
AgentLint
TraceLint
ReflexTrace
```

`JevTrace` is explicit and easy to understand.

`AgentLint` is more product-like and would make sense if the project later supports multiple judge backends.

---

# License

MIT is a reasonable default for an open-source developer tool.

---

# Status

```text
Status: Concept / MVP
```

Initial goals:

```text
[ ] Define trace schema
[ ] Implement parser
[ ] Add deterministic checks
[ ] Add Jev integration
[ ] Detect redundant steps
[ ] Detect bad retries
[ ] Detect loops
[ ] Detect premature completion
[ ] Render terminal report
[ ] Create benchmark dataset
[ ] Compare against baseline judges
```

---

# Final Goal

JevTrace is based on a simple observation:

> **An agent can produce the right final answer while still having a bad execution trajectory.**

If we want agents to become cheaper, faster, and more reliable, we need tools that evaluate not just the answer, but the **sequence of decisions that produced it**.

JevTrace is a small step toward that goal.
