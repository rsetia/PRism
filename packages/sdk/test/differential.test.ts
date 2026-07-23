import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compileGraph, parseGraph } from "../src/index.js";
import type { CompiledGraph } from "../src/index.js";

/**
 * Differential fixtures (plan §13): language-neutral input -> expected
 * compiled output. A Python implementation would run these same files to
 * prove intentional parity. Fixtures live at the repo root so both
 * implementations share them. These are reviewed specs — where TS
 * behavior diverges from Python on purpose, the fixture records the TS
 * decision, not a rubber stamp of either.
 */
const COMPILE_DIR = fileURLToPath(
  new URL("../../../fixtures/compile/", import.meta.url),
);

interface ExpectedNode {
  readonly executor: string;
  readonly kind: string;
  readonly dependsOn: readonly string[];
  readonly dependents: readonly string[];
}
interface ExpectedSuccess {
  readonly ok: true;
  readonly order: readonly string[];
  readonly finalNode: string;
  readonly nodes: Record<string, ExpectedNode>;
}
interface ExpectedFailure {
  readonly ok: false;
  readonly errorCodes: readonly string[];
}
type Expected = ExpectedSuccess | ExpectedFailure;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function projectNodes(graph: CompiledGraph): Record<string, ExpectedNode> {
  const nodes: Record<string, ExpectedNode> = {};
  for (const id of graph.order) {
    const node = graph.nodes[id];
    if (node === undefined) continue;
    nodes[id] = {
      executor: node.executor,
      kind: node.kind,
      dependsOn: [...node.dependsOn],
      dependents: [...node.dependents],
    };
  }
  return nodes;
}

const cases = readdirSync(COMPILE_DIR)
  .filter((name) => name.endsWith(".input.json"))
  .map((name) => name.replace(/\.input\.json$/, ""));

describe("differential fixtures: compile", () => {
  for (const name of cases) {
    test(name, () => {
      const input: unknown = readJson(`${COMPILE_DIR}${name}.input.json`);
      const expected = readJson<Expected>(
        `${COMPILE_DIR}${name}.expected.json`,
      );

      const parsedResult = parseGraph(input);
      if (!expected.ok) {
        const codes = parsedResult.ok
          ? compileCodes(parsedResult.graph)
          : parsedResult.errors.map((e) => e.code);
        expect(codes.sort()).toEqual([...expected.errorCodes].sort());
        return;
      }

      expect(parsedResult.ok).toBe(true);
      if (!parsedResult.ok) return;
      const compiled = compileGraph(parsedResult.graph);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;

      expect([...compiled.graph.order]).toEqual([...expected.order]);
      expect(compiled.graph.finalNode).toBe(expected.finalNode);
      expect(projectNodes(compiled.graph)).toEqual(expected.nodes);
    });
  }
});

function compileCodes(graph: Parameters<typeof compileGraph>[0]): string[] {
  const compiled = compileGraph(graph);
  return compiled.ok ? [] : compiled.errors.map((e) => e.code);
}
