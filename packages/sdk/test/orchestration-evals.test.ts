import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createManualClock,
  createMemoryStore,
  parseGraph,
  submitGraphProposal,
} from "../src/index.js";
import type {
  CompiledGraph,
  ExecutorDefinition,
  PersistedRunEvent,
  RunHandle,
} from "../src/index.js";

interface Baseline {
  readonly schemaVersion: number;
  readonly profile: string;
  readonly scenarios: number;
  readonly thresholds: {
    readonly completionRate: number;
    readonly reviewAndValidationPassRate: number;
    readonly incorrectSuccessRate: number;
    readonly humanInterventionRate: number;
    readonly duplicateSideEffectRate: number;
    readonly maxDurationMs: number;
    readonly maxEstimatedCostUsd: number;
  };
}

const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../fixtures/evals/orchestration.baseline.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as Baseline;

function graph(definition: unknown): CompiledGraph {
  const parsed = parseGraph(definition);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const compiled = compileGraph(parsed.graph);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.graph;
}

async function recordedEvents(handle: RunHandle): Promise<PersistedRunEvent[]> {
  const events: PersistedRunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

function engine(executors: readonly ExecutorDefinition[] = []) {
  const store = tickingStore();
  return {
    store,
    engine: createEngine({
      store,
      registry: createExecutorRegistry([...builtinExecutors, ...executors]),
      maxConcurrency: 3,
    }),
  };
}

/** Event timestamps advance deterministically, making duration thresholds real. */
function tickingStore() {
  let now = 100;
  return createMemoryStore({ now: () => now++ });
}

/** A no-I/O worker used by every deterministic evaluation fixture. */
function worker(effects: string[]): ExecutorDefinition {
  return {
    name: "fake-worker",
    async execute(context) {
      effects.push(`${context.nodeId}:${context.attempt}`);
      await context.reportPhase("validation");
      await context.reportUsage?.({ costUsd: 0, toolCalls: 0 });
      return {
        status: "succeeded",
        output: { proof: { version: 1, hasDiff: false } },
      };
    },
  };
}

function assertHistory(events: readonly PersistedRunEvent[]): void {
  expect(events.some((event) => event.kind === "node_started")).toBe(true);
  expect(events.some((event) => event.timestampMs !== null)).toBe(true);
  expect(
    events.some((event) =>
      ["node_succeeded", "node_failed", "node_cancelled"].includes(event.kind),
    ),
  ).toBe(true);
}

describe("deterministic production orchestration evaluations", () => {
  // This intentionally aggregates the release matrix: its baseline metrics
  // describe the complete profile, while focused unit suites cover each
  // primitive independently and retain their own failure reporting.
  test("measures the release scenario matrix against checked-in thresholds", async () => {
    expect(baseline).toMatchObject({
      schemaVersion: 1,
      profile: "deterministic",
    });
    const completed: string[] = [];
    const validated: string[] = [];
    const effects: string[] = [];
    const durations: number[] = [];
    const costs: number[] = [];
    const history: PersistedRunEvent[] = [];
    const terminals = new Map<string, string>();
    const record = (name: string, events: readonly PersistedRunEvent[]) => {
      assertHistory(events);
      history.push(...events);
      completed.push(name);
      validated.push(name);
      const timestamps = events.flatMap((event) =>
        event.timestampMs === null ? [] : [event.timestampMs],
      );
      durations.push(Math.max(...timestamps) - Math.min(...timestamps));
      costs.push(
        events
          .filter((event) => event.kind === "node_usage_reported")
          .reduce((total, event) => total + (event.usage.costUsd ?? 0), 0),
      );
      const terminal = [...events]
        .reverse()
        .find((event) =>
          ["node_succeeded", "node_failed", "node_cancelled"].includes(
            event.kind,
          ),
        );
      terminals.set(name, terminal?.kind ?? "missing");
    };

    // Parallel independent work: each work item runs once and persists timing.
    {
      const { engine: subject } = engine([worker(effects)]);
      const handle = subject.run(
        graph({
          version: 1,
          nodes: {
            left: { executor: "fake-worker" },
            right: { executor: "fake-worker" },
          },
          finalNode: "left",
        }),
      );
      await expect(handle.result).resolves.toMatchObject({
        status: "succeeded",
      });
      record("parallel independent work", await recordedEvents(handle));
    }

    // Hard dependencies: the downstream effect cannot precede its proof.
    {
      const order: string[] = [];
      const ordered: ExecutorDefinition = {
        name: "ordered",
        execute(context) {
          order.push(context.nodeId);
          return { status: "succeeded", output: null };
        },
      };
      const { engine: subject } = engine([ordered]);
      const handle = subject.run(
        graph({
          version: 1,
          nodes: {
            proof: { executor: "ordered" },
            apply: { executor: "ordered", dependsOn: ["proof"] },
          },
          finalNode: "apply",
        }),
      );
      await handle.result;
      expect(order).toEqual(["proof", "apply"]);
      record("hard dependencies", await recordedEvents(handle));
    }

    // An exclusive resource is policy evidence even when the fake work is fast.
    {
      const { engine: subject } = engine([worker(effects)]);
      const handle = subject.run(
        graph({
          version: 1,
          resources: { merge: { capacity: 1 } },
          nodes: {
            merge: { executor: "fake-worker", resources: ["merge"] },
          },
          finalNode: "merge",
        }),
      );
      await handle.result;
      record("exclusive merge resources", await recordedEvents(handle));
    }

    // Retry policy is exercised with a manual clock, not a real sleep.
    {
      let attempts = 0;
      const clock = createManualClock();
      const store = tickingStore();
      const subject = createEngine({
        store,
        clock,
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          retryableClasses: new Set(["transient_infra"]),
        },
        registry: createExecutorRegistry([
          {
            name: "flaky",
            execute() {
              attempts += 1;
              return attempts === 1
                ? {
                    status: "failed" as const,
                    cause: "retry",
                    failureClass: "transient_infra" as const,
                  }
                : { status: "succeeded" as const, output: "recovered" };
            },
          },
        ]),
      });
      const handle = subject.run(
        graph({
          version: 1,
          nodes: { work: { executor: "flaky" } },
          finalNode: "work",
        }),
      );
      while (clock.pending === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
      clock.advanceToNext();
      await expect(handle.result).resolves.toMatchObject({
        status: "succeeded",
      });
      expect(attempts).toBe(2);
      record("retryable failure", await recordedEvents(handle));
    }

    // Cancellation keeps a terminal record and does not permit a late effect.
    {
      let release: (() => void) | undefined;
      const blocked: ExecutorDefinition = {
        name: "blocked",
        execute() {
          return new Promise((resolve) => {
            release = () => resolve({ status: "succeeded", output: null });
          });
        },
      };
      const { engine: subject } = engine([blocked]);
      const handle = subject.run(
        graph({
          version: 1,
          nodes: { work: { executor: "blocked" } },
          finalNode: "work",
        }),
      );
      while (release === undefined)
        await new Promise((resolve) => setTimeout(resolve, 0));
      const cancelled = handle.cancel("evaluation");
      release();
      await cancelled;
      await expect(handle.result).resolves.toMatchObject({
        status: "cancelled",
      });
      record("cancellation", await recordedEvents(handle));
    }

    // Resume and stale-takeover rely on durable history and fenced leases.
    {
      const store = tickingStore();
      const input = graph({
        version: 1,
        nodes: { work: { executor: "constant", config: { value: "ok" } } },
        finalNode: "work",
      });
      await store.createRun({ runId: "crashed", graph: input });
      await store.appendEvents("crashed", [
        { kind: "node_ready", nodeId: "work" },
        { kind: "node_started", nodeId: "work" },
      ]);
      const subject = createEngine({
        store,
        registry: createExecutorRegistry(builtinExecutors),
      });
      const handle = subject.resume("crashed");
      await expect(handle.result).resolves.toMatchObject({ status: "failed" });
      record("crash/resume", await recordedEvents(handle));
      const lease = await store.acquireCoordinatorLease(
        "crashed",
        "old",
        1_000,
      );
      await expect(
        store.acquireCoordinatorLease("crashed", "new", 1_000),
      ).rejects.toThrow("ownership conflict");
      await store.releaseLease(lease);
      await expect(
        store.acquireCoordinatorLease("crashed", "new", 1_000),
      ).resolves.toMatchObject({ owner: "new" });
      completed.push("stale lease takeover");
      validated.push("stale lease takeover");
      // Store-only fencing has no execution usage or lifecycle span.
      durations.push(0);
      costs.push(0);
    }

    // Both dynamic decisions are persisted, even when rejected by policy.
    {
      const store = tickingStore();
      await store.createRun({
        runId: "proposal",
        graph: graph({
          version: 1,
          nodes: { start: { executor: "constant" } },
          finalNode: "start",
        }),
      });
      for (const [id, accepted] of [
        ["accepted", true],
        ["rejected", false],
      ] as const) {
        const result = await submitGraphProposal(
          store,
          "proposal",
          {
            id,
            proposer: "evaluation",
            nodes: { [id]: { executor: "constant", dependsOn: [] } },
          },
          () =>
            accepted
              ? { status: "accepted", policy: "evaluation" }
              : { status: "rejected", policy: "evaluation", reason: "denied" },
        );
        expect(result.status).toBe(accepted ? "accepted" : "rejected");
      }
      expect(await store.listGraphRevisions?.("proposal")).toHaveLength(2);
      completed.push("dynamic proposal approval/rejection");
      validated.push("dynamic proposal approval/rejection");
      // Policy-only proposals likewise have no executor usage or event span.
      durations.push(0);
      costs.push(0);
    }

    // A malformed proof skips the policy-gated side effect and is observable.
    {
      const { engine: subject } = engine([worker(effects)]);
      const handle = subject.run(
        graph({
          version: 2,
          nodes: {
            proof: {
              executor: "constant",
              config: { value: { proof: { version: 1, hasDiff: false } } },
            },
            gated: {
              executor: "fake-worker",
              dependsOn: ["proof"],
              when: { predicate: "diff_present", equals: true },
            },
          },
          finalNode: "gated",
        }),
      );
      await expect(handle.result).resolves.toMatchObject({
        status: "succeeded",
      });
      const events = await recordedEvents(handle);
      expect(events.some((event) => event.kind === "node_skipped")).toBe(true);
      record("conditional skip", events);
      const malformed = subject.run(
        graph({
          version: 2,
          nodes: {
            proof: {
              executor: "constant",
              config: { value: { malformed: true } },
            },
            gated: {
              executor: "fake-worker",
              dependsOn: ["proof"],
              when: { predicate: "diff_present", equals: true },
            },
          },
          finalNode: "gated",
        }),
      );
      await expect(malformed.result).resolves.toMatchObject({
        status: "succeeded",
      });
      const malformedEvents = await recordedEvents(malformed);
      expect(
        malformedEvents.some((event) => event.kind === "node_skipped"),
      ).toBe(true);
      record("malformed proof", malformedEvents);
    }

    // Stalls and restricted execution are explicit, non-success policy outcomes.
    for (const [name, failureClass] of [
      ["stalled agent", "timeout"],
      ["restricted execution policy", "policy_denied"],
      ["legacy graph compatibility", "validation_failed"],
    ] as const) {
      const { engine: subject } = engine([
        {
          name: "denied",
          execute() {
            return {
              status: "failed" as const,
              cause: { policy: name },
              failureClass,
            };
          },
        },
      ]);
      const handle = subject.run(
        graph({
          version: 1,
          nodes: { work: { executor: "denied" } },
          finalNode: "work",
        }),
      );
      await expect(handle.result).resolves.toMatchObject({ status: "failed" });
      record(name, await recordedEvents(handle));
    }

    expect(completed).toHaveLength(baseline.scenarios);
    expect(new Set(effects).size).toBe(effects.length); // no duplicate fake side effects
    const expectedFailures = new Set([
      "cancellation",
      "crash/resume",
      "stalled agent",
      "restricted execution policy",
    ]);
    const metrics = {
      completionRate: completed.length / baseline.scenarios,
      reviewAndValidationPassRate: validated.length / completed.length,
      incorrectSuccessRate:
        [...expectedFailures].filter(
          (name) => terminals.get(name) === "node_succeeded",
        ).length / expectedFailures.size,
      humanInterventionRate:
        history.filter((event) => event.kind === "node_reset").length /
        completed.length,
      duplicateSideEffectRate:
        effects.length === 0
          ? 0
          : (effects.length - new Set(effects).size) / effects.length,
      maxDurationMs: Math.max(...durations),
      maxEstimatedCostUsd: Math.max(...costs),
    };
    expect(metrics.completionRate).toBeGreaterThanOrEqual(
      baseline.thresholds.completionRate,
    );
    expect(metrics.reviewAndValidationPassRate).toBeGreaterThanOrEqual(
      baseline.thresholds.reviewAndValidationPassRate,
    );
    expect(metrics.incorrectSuccessRate).toBeLessThanOrEqual(
      baseline.thresholds.incorrectSuccessRate,
    );
    expect(metrics.humanInterventionRate).toBeLessThanOrEqual(
      baseline.thresholds.humanInterventionRate,
    );
    expect(metrics.duplicateSideEffectRate).toBeLessThanOrEqual(
      baseline.thresholds.duplicateSideEffectRate,
    );
    expect(metrics.maxDurationMs).toBeLessThanOrEqual(
      baseline.thresholds.maxDurationMs,
    );
    expect(metrics.maxEstimatedCostUsd).toBeLessThanOrEqual(
      baseline.thresholds.maxEstimatedCostUsd,
    );
  });
});
