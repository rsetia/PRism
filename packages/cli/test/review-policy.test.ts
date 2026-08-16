import {
  compileGraph,
  type CompiledGraph,
  type JsonValue,
} from "@rsetia/prism";
import { describe, expect, test } from "vitest";
import { applyGreptileAppSlug } from "../src/review-policy.js";

function compiledGraph(options?: {
  readonly firstSlug?: JsonValue;
  readonly includeGreptile?: boolean;
}): CompiledGraph {
  const includeGreptile = options?.includeGreptile ?? true;
  const firstReview = includeGreptile
    ? {
        by: "greptile",
        ...(options?.firstSlug === undefined
          ? {}
          : { greptileAppSlug: options.firstSlug }),
      }
    : { by: "claude" };
  const compiled = compileGraph({
    version: 1,
    nodes: {
      first: {
        executor: "implement",
        dependsOn: [],
        config: { review: firstReview },
      },
      middle: {
        executor: "implement",
        dependsOn: ["first"],
        config: { review: { by: "claude" } },
      },
      last: {
        executor: includeGreptile ? "implement" : "passthrough",
        dependsOn: ["middle"],
        ...(includeGreptile ? { config: { review: { by: "greptile" } } } : {}),
      },
    },
    finalNode: "last",
  });
  if (!compiled.ok) throw new Error("test graph did not compile");
  return compiled.graph;
}

describe("applyGreptileAppSlug", () => {
  test("applies the slug to every Greptile implement node and recompiles", () => {
    const original = compiledGraph();
    const applied = applyGreptileAppSlug(original, " greptile-apps ");

    expect(applied.nodeIds).toEqual(["first", "last"]);
    expect(applied.graph.nodes["first"]?.config).toMatchObject({
      review: { by: "greptile", greptileAppSlug: "greptile-apps" },
    });
    expect(applied.graph.nodes["last"]?.config).toMatchObject({
      review: { by: "greptile", greptileAppSlug: "greptile-apps" },
    });
    expect(applied.graph.nodes["middle"]?.config).toEqual(
      original.nodes["middle"]?.config,
    );
    expect(original.nodes["first"]?.config).not.toHaveProperty(
      "review.greptileAppSlug",
    );
    expect(Object.isFrozen(applied.graph)).toBe(true);
    expect(Object.isFrozen(applied.graph.nodes["first"]?.config)).toBe(true);
  });

  test("accepts an existing matching selection", () => {
    const applied = applyGreptileAppSlug(
      compiledGraph({ firstSlug: "greptile-apps" }),
      "greptile-apps",
    );
    expect(applied.nodeIds).toEqual(["first", "last"]);
  });

  test("rejects a conflicting node selection", () => {
    expect(() =>
      applyGreptileAppSlug(
        compiledGraph({ firstSlug: "greptile-apps-staging" }),
        "greptile-apps",
      ),
    ).toThrow(/first.*conflicts.*greptile-apps/u);
  });

  test("rejects an invalid existing node selection", () => {
    expect(() =>
      applyGreptileAppSlug(compiledGraph({ firstSlug: 42 }), "greptile-apps"),
    ).toThrow(/first.*invalid/u);
  });

  test("applies the slug to a Greptile finalize_pr node", () => {
    const compiled = compileGraph({
      version: 1,
      nodes: {
        work: {
          executor: "implement",
          dependsOn: [],
          config: { review: { by: "claude" } },
        },
        "finalize-integration-pr": {
          executor: "finalize_pr",
          dependsOn: ["work"],
          config: {
            sourceBranch: "prism/integration",
            targetBranch: "main",
            review: { by: "greptile" },
          },
        },
      },
      finalNode: "finalize-integration-pr",
    });
    if (!compiled.ok) throw new Error("test graph did not compile");
    const applied = applyGreptileAppSlug(compiled.graph, "greptile-apps");
    expect(applied.nodeIds).toEqual(["finalize-integration-pr"]);
    expect(
      applied.graph.nodes["finalize-integration-pr"]?.config,
    ).toMatchObject({
      review: { by: "greptile", greptileAppSlug: "greptile-apps" },
    });
  });

  test("rejects a graph without Greptile review nodes", () => {
    expect(() =>
      applyGreptileAppSlug(
        compiledGraph({ includeGreptile: false }),
        "greptile-apps",
      ),
    ).toThrow("graph has no Greptile review nodes");
  });

  test("preserves version 2 conditions", () => {
    const compiled = compileGraph({
      version: 2,
      nodes: {
        work: {
          executor: "implement",
          dependsOn: [],
          config: { review: { by: "greptile" } },
        },
        gated: {
          executor: "passthrough",
          dependsOn: ["work"],
          when: { predicate: "diff_present", equals: true },
        },
      },
      finalNode: "gated",
    });
    if (!compiled.ok) throw new Error("test graph did not compile");

    const applied = applyGreptileAppSlug(compiled.graph, "greptile-apps");
    expect(applied.graph.version).toBe(2);
    expect(applied.graph.nodes["gated"]?.when).toEqual(
      compiled.graph.nodes["gated"]?.when,
    );
  });

  test("rejects a blank requested slug", () => {
    expect(() => applyGreptileAppSlug(compiledGraph(), " ")).toThrow(
      "non-empty",
    );
  });
});
