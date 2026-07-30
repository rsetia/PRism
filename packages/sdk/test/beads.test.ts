import { describe, expect, test } from "vitest";
import {
  builtinExecutors,
  buildBeadsGraph,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseBeadsJsonl,
  parseGraph,
} from "../src/index.js";
import type {
  Bead,
  ExecutorDefinition,
  GraphDefinition,
  JsonValue,
} from "../src/index.js";

const bead = (id: string, dependencies: string[] = []): Bead => ({
  id,
  title: `Work item ${id}`,
  dependencies,
});

/** Find the implement node the generator emitted for a given bead id. */
function implementNodeId(
  graph: GraphDefinition,
  beadId: string,
): string | undefined {
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node.executor !== "implement") continue;
    const config = node.config as { workItem?: { id?: string } } | undefined;
    if (config?.workItem?.id === beadId) return nodeId;
  }
  return undefined;
}

function executorNames(graph: GraphDefinition): string[] {
  return Object.values(graph.nodes).map((node) => node.executor);
}

function succeeds(name: string): ExecutorDefinition {
  return {
    name,
    execute(context) {
      return {
        status: "succeeded",
        output: { executor: name, nodeId: context.nodeId },
      };
    },
  };
}

describe("parseBeadsJsonl", () => {
  test("parses newline-delimited beads, skipping blank lines", () => {
    const text = `{"id":"A","title":"first"}\n\n{"id":"B","dependencies":["A"]}\n`;
    const beads = parseBeadsJsonl(text);
    expect(beads.map((b) => b.id)).toEqual(["A", "B"]);
    expect(beads[1]?.dependencies).toEqual(["A"]);
  });

  test("rejects a malformed line, naming its number", () => {
    const text = `{"id":"A"}\nnot json\n`;
    expect(() => parseBeadsJsonl(text)).toThrow(/2/);
  });

  test("rejects a bead without a string id", () => {
    expect(() => parseBeadsJsonl(`{"title":"no id"}`)).toThrow();
  });

  test("normalizes rich dependency objects and ignores entries without ids", () => {
    const beads = parseBeadsJsonl(
      `{"id":"B","dependencies":[{"id":"A"},{"title":"missing"},"C","C"]}`,
    );
    expect(beads[0]?.dependencies).toEqual(["A", "C"]);
  });

  test("normalizes current bd export relationships without self-cycles", () => {
    const beads = parseBeadsJsonl(
      JSON.stringify({
        id: "B",
        dependencies: [
          {
            issue_id: "B",
            depends_on_id: "A",
            type: "blocks",
          },
          {
            issue_id: "B",
            depends_on_id: "EPIC",
            type: "parent-child",
          },
        ],
      }),
    );
    expect(beads[0]?.dependencies).toEqual(["A"]);
  });

  test("accepts dependency aliases emitted by older bd versions", () => {
    const beads = parseBeadsJsonl(
      JSON.stringify({
        id: "B",
        blocked_by: [{ id: "A", dependency_type: "requires" }],
      }),
    );
    expect(beads[0]?.dependencies).toEqual(["A"]);
  });
});

describe("buildBeadsGraph", () => {
  test("emits one implement node per bead", () => {
    const graph = buildBeadsGraph([bead("A"), bead("B")]);
    expect(implementNodeId(graph, "A")).toBeDefined();
    expect(implementNodeId(graph, "B")).toBeDefined();
    expect(executorNames(graph).filter((n) => n === "implement")).toHaveLength(
      2,
    );
  });

  test("the generated graph compiles", () => {
    const graph = buildBeadsGraph([bead("A"), bead("B", ["A"])]);
    const compiled = compileGraph(graph);
    expect(compiled.ok).toBe(true);
  });

  test("the generated graph is valid untrusted input for parseGraph", () => {
    const graph = buildBeadsGraph([bead("A")]);
    const roundTripped: unknown = JSON.parse(JSON.stringify(graph));
    expect(parseGraph(roundTripped).ok).toBe(true);
  });

  test("a dependency orders the dependent after it", () => {
    const graph = buildBeadsGraph([bead("B", ["A"]), bead("A")]);
    const compiled = compileGraph(graph);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = compiled.graph.order;
    const implA = implementNodeId(graph, "A");
    const implB = implementNodeId(graph, "B");
    expect(order.indexOf(implA ?? "")).toBeLessThan(order.indexOf(implB ?? ""));
  });

  test("implement receives the full bead snapshot and review config", () => {
    const graph = buildBeadsGraph(
      [
        {
          id: "MC-1",
          title: "Useful title",
          description: "Implement the useful behavior",
          acceptance_criteria: "The behavior is covered by tests",
          priority: 1,
          dependencies: [],
        },
      ],
      { review: "greptile" },
    );
    const nodeId = implementNodeId(graph, "MC-1");
    expect(nodeId).toBeDefined();
    const implement = graph.nodes[nodeId ?? ""];
    const config = implement?.config as {
      workItem?: { id?: string; provider?: string };
      review?: { by?: string };
    };
    expect(config.workItem?.id).toBe("MC-1");
    expect(config.workItem?.provider).toBe("beads");
    expect(config.review?.by).toBe("greptile");

    const contextNodeId = implement?.dependsOn[0];
    expect(contextNodeId).toBe("context-mc-1");
    expect(graph.nodes[contextNodeId ?? ""]).toMatchObject({
      executor: "constant",
      config: {
        value: {
          provider: "beads",
          id: "MC-1",
          url: "beads://MC-1",
          title: "Useful title",
          description: "Implement the useful behavior",
          acceptance_criteria: "The behavior is covered by tests",
          priority: 1,
          dependencies: [],
        },
      },
    });
  });

  test("copies review-loop and validation settings into agent nodes", () => {
    const graph = buildBeadsGraph([bead("A")], {
      review: "claude",
      reviewConfig: {
        requireApproved: true,
        requireNoActionableFindings: true,
        requireGreenChecks: true,
        triggerComment: "@claude review",
      },
      validationCommands: ["npm test"],
      mergeValidationCommands: ["npm run verify"],
      maxIterations: 6,
    });
    expect(graph.nodes["implement-a"]?.config).toMatchObject({
      review: {
        by: "claude",
        requireApproved: true,
        requireNoActionableFindings: true,
        requireGreenChecks: true,
        triggerComment: "@claude review",
      },
      maxIterations: 6,
      validationCommands: ["npm test"],
    });
    expect(graph.nodes["merge-a"]?.config).toMatchObject({
      validationCommands: ["npm run verify"],
    });
  });

  test("fans out implementations while serializing merge/update chains", () => {
    const graph = buildBeadsGraph([bead("A"), bead("B")]);
    expect(graph.nodes["implement-a"]?.dependsOn).toEqual(["context-a"]);
    expect(graph.nodes["implement-b"]?.dependsOn).toEqual(["context-b"]);
    expect(graph.nodes["merge-a"]?.dependsOn).toEqual(["implement-a"]);
    expect(graph.nodes["merge-b"]?.dependsOn).toEqual([
      "implement-b",
      "update-a",
    ]);
  });

  test("includeBeadsUpdate: false omits beads_update nodes", () => {
    const withUpdate = buildBeadsGraph([bead("A")]);
    expect(executorNames(withUpdate)).toContain("beads_update");
    const without = buildBeadsGraph([bead("A")], {
      includeBeadsUpdate: false,
    });
    expect(executorNames(without)).not.toContain("beads_update");
  });

  test("can omit merge nodes while retaining beads updates", () => {
    const graph = buildBeadsGraph([bead("A")], { includeMerge: false });
    const implementId = implementNodeId(graph, "A");
    expect(executorNames(graph)).not.toContain("merge_resolve");
    const update = Object.values(graph.nodes).find(
      (node) => node.executor === "beads_update",
    );
    expect(update?.dependsOn).toEqual([implementId]);
    expect(graph.finalNode).toBeDefined();
  });

  test("adds a stable aggregator for multiple bead terminals", () => {
    const graph = buildBeadsGraph([bead("B"), bead("A")], {
      includeMerge: false,
      includeBeadsUpdate: false,
    });
    expect(graph.finalNode).toBe("beads-final");
    expect(graph.nodes["beads-final"]).toMatchObject({
      executor: "constant",
      kind: "merge",
      config: { value: { completedBeads: ["A", "B"] } },
    });
  });

  test("the default generated graph runs with its documented executors", async () => {
    const implementInputs = new Map<string, readonly JsonValue[]>();
    const implement: ExecutorDefinition = {
      name: "implement",
      execute(context) {
        implementInputs.set(context.nodeId, [...context.inputs]);
        return {
          status: "succeeded",
          output: {
            summary: `implemented ${context.nodeId}`,
            metadata: { branch: `branch-${context.nodeId}` },
          },
        };
      },
    };
    const definition = buildBeadsGraph([
      {
        ...bead("B", ["A"]),
        description: "Depends on A",
      },
      {
        ...bead("A"),
        description: "Foundation",
      },
    ]);
    const compiled = compileGraph(definition);
    if (!compiled.ok) throw new Error("generated graph did not compile");
    const engine = createEngine({
      store: createMemoryStore(),
      registry: createExecutorRegistry([
        ...builtinExecutors,
        implement,
        succeeds("merge_resolve"),
        succeeds("beads_update"),
      ]),
    });

    await expect(engine.run(compiled.graph).result).resolves.toEqual({
      status: "succeeded",
      output: { completedBeads: ["A", "B"] },
    });
    expect(implementInputs.get("implement-a")).toEqual([
      expect.objectContaining({
        id: "A",
        description: "Foundation",
        url: "beads://A",
      }),
    ]);
    expect(implementInputs.get("implement-b")).toEqual([
      expect.objectContaining({
        id: "B",
        description: "Depends on A",
        dependencies: ["A"],
      }),
      { executor: "merge_resolve", nodeId: "merge-a" },
    ]);
  });

  test("rejects an empty bead set", () => {
    expect(() => buildBeadsGraph([])).toThrow();
  });

  test("rejects a dangling dependency", () => {
    expect(() => buildBeadsGraph([bead("A", ["ghost"])])).toThrow();
  });

  test("rejects dependency cycles", () => {
    expect(() => buildBeadsGraph([bead("A", ["B"]), bead("B", ["A"])])).toThrow(
      /cycle/i,
    );
  });

  test("rejects ids that collide after slugging", () => {
    expect(() => buildBeadsGraph([bead("A B"), bead("a-b")])).toThrow(
      /collide/i,
    );
  });

  test("rejects non-JSON bead context", () => {
    expect(() =>
      buildBeadsGraph([
        {
          id: "A",
          dependencies: [],
          metadata: BigInt(1),
        },
      ]),
    ).toThrow("JSON-safe");
  });
});
