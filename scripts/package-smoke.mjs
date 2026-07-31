/**
 * Section 7 package smoke: prove what a consumer actually installs.
 * Packs both packages, installs the tarballs into a throwaway consumer
 * project, then runs a plain-JS import, a strict TS compile against the
 * packed declarations, and the packed CLI binary. Workspace source is
 * never on the module path — only the tarballs are tested.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function log(message) {
  process.stderr.write(`[smoke] ${message}\n`);
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { timeout: 180_000, ...options });
}

const JS_CONSUMER = `
import {
  SDK_VERSION,
  builtinExecutors,
  compileGraph,
  createEngine,
  createExecutorRegistry,
  createMemoryStore,
  parseGraph,
} from "@rsetia/prism";
import {
  createLocalExecutionBackend,
  createSqliteStore,
} from "@rsetia/prism/node";

if (
  typeof createLocalExecutionBackend !== "function" ||
  typeof createSqliteStore !== "function"
) {
  throw new Error("the ./node entry point did not resolve");
}

const parsed = parseGraph({
  version: 1,
  nodes: {
    first: { executor: "constant", config: { value: "hello" } },
    second: { executor: "passthrough", dependsOn: ["first"] },
  },
  finalNode: "second",
});
if (!parsed.ok) throw new Error("parse failed");
const compiled = compileGraph(parsed.graph);
if (!compiled.ok) throw new Error("compile failed");
const engine = createEngine({
  store: createMemoryStore(),
  registry: createExecutorRegistry(builtinExecutors),
});
const outcome = await engine.run(compiled.graph).result;
if (outcome.status !== "succeeded" || outcome.output !== "hello") {
  throw new Error("unexpected outcome: " + JSON.stringify(outcome));
}
console.log("js consumer ok (SDK " + SDK_VERSION + ")");
`;

const CORE_BOUNDARY_CONSUMER = `
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("node:")) {
      throw new Error("core entry imported Node built-in " + specifier);
    }
    return nextResolve(specifier, context);
  },
});

await import("@rsetia/prism");
console.log("core boundary ok");
`;

const TS_CONSUMER = `
import { compileGraph, createMemoryStore, parseGraph } from "@rsetia/prism";
import type {
  ArtifactStore,
  CompiledGraph,
  LogBackend,
} from "@rsetia/prism";
import type {
  ExecutionBackend,
  WorkspaceProvisioner,
} from "@rsetia/prism/node";
import type {
  ArtifactStoreFactory,
  ExecutionBackendFactory,
  LogBackendFactory,
  RunStoreFactory,
  WorkspaceProvisionerFactory,
} from "@rsetia/prism/testing";

const parsed = parseGraph({
  version: 1,
  nodes: { only: { executor: "constant", config: { value: 1 } } },
  finalNode: "only",
});
if (!parsed.ok) {
  throw new Error("parse failed");
}
const compiled = compileGraph(parsed.graph);
if (!compiled.ok) {
  throw new Error("compile failed");
}
const graph: CompiledGraph = compiled.graph;
if (graph.order.length !== 1) {
  throw new Error("unexpected order");
}
const storeFactory: RunStoreFactory = async () => createMemoryStore();
void storeFactory;
declare const artifactStore: ArtifactStore;
const artifactStoreFactory: ArtifactStoreFactory = async () => artifactStore;
void artifactStoreFactory;
declare const logBackend: LogBackend;
const logBackendFactory: LogBackendFactory = async () => logBackend;
void logBackendFactory;
declare const executionBackend: ExecutionBackend;
const executionBackendFactory: ExecutionBackendFactory = async () =>
  executionBackend;
void executionBackendFactory;
declare const workspaceProvisioner: WorkspaceProvisioner;
const workspaceProvisionerFactory: WorkspaceProvisionerFactory = async () =>
  workspaceProvisioner;
void workspaceProvisionerFactory;
`;

const TS_CONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
  },
  include: ["check.ts"],
});

const EXAMPLE_GRAPH = JSON.stringify({
  version: 1,
  nodes: {
    first: { executor: "constant", config: { value: "hello" } },
    second: { executor: "passthrough", dependsOn: ["first"] },
  },
  finalNode: "second",
});

const workDir = await mkdtemp(path.join(tmpdir(), "prism-smoke-"));
try {
  // `prism run` requires PRISM_HOME. Inheriting the developer's own home would
  // make the smoke depend on ambient state — it passes locally for anyone who
  // followed the README and fails in CI, which has none. Point every child at
  // a throwaway home inside workDir so the run is hermetic either way.
  const smokeHome = path.join(workDir, "prism-home");
  await mkdir(smokeHome);
  process.env.PRISM_HOME = smokeHome;

  const pack = async (packageName) => {
    const { stdout } = await run(
      "npm",
      ["pack", "--json", "--pack-destination", workDir],
      { cwd: path.join(repoRoot, "packages", packageName) },
    );
    const filename = JSON.parse(stdout)[0]?.filename;
    if (typeof filename !== "string") {
      throw new Error(`npm pack produced no tarball for ${packageName}`);
    }
    return path.join(workDir, filename);
  };

  log("packing sdk and cli");
  const sdkTarball = await pack("sdk");
  const cliTarball = await pack("cli");

  const consumerDir = path.join(workDir, "consumer");
  await mkdir(consumerDir);
  await writeFile(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }),
  );

  log("installing tarballs into a clean consumer");
  await run(
    "npm",
    [
      "install",
      sdkTarball,
      cliTarball,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: consumerDir },
  );

  log("verifying the core entry imports no Node built-ins");
  await writeFile(
    path.join(consumerDir, "core-boundary.mjs"),
    CORE_BOUNDARY_CONSUMER,
  );
  const { stdout: boundaryOut } = await run(
    process.execPath,
    ["core-boundary.mjs"],
    { cwd: consumerDir },
  );
  if (!boundaryOut.includes("core boundary ok")) {
    throw new Error(`core boundary check failed: ${boundaryOut}`);
  }

  log("running the plain-JS consumer");
  await writeFile(path.join(consumerDir, "check.mjs"), JS_CONSUMER);
  const { stdout: jsOut } = await run(process.execPath, ["check.mjs"], {
    cwd: consumerDir,
  });
  if (!jsOut.includes("js consumer ok")) {
    throw new Error(`js consumer failed: ${jsOut}`);
  }

  log("type-checking the TS consumer against packed declarations");
  await writeFile(path.join(consumerDir, "check.ts"), TS_CONSUMER);
  await writeFile(path.join(consumerDir, "tsconfig.json"), TS_CONFIG);
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  await run(process.execPath, [
    tsc,
    "--project",
    path.join(consumerDir, "tsconfig.json"),
  ]);

  log("running the packed CLI binary");
  await writeFile(path.join(consumerDir, "graph.json"), EXAMPLE_GRAPH);
  const cliBin = path.join(consumerDir, "node_modules", ".bin", "prism");
  const { stdout: cliOut } = await run(
    cliBin,
    ["run", "graph.json", "--json"],
    {
      cwd: consumerDir,
    },
  );
  const result = JSON.parse(cliOut);
  if (result.status !== "succeeded" || result.output !== "hello") {
    throw new Error(`packed CLI failed: ${cliOut}`);
  }

  // The skill is how a consumer discovers Prism's planning workflow at all,
  // so it has to survive packing — a `files` omission would silently drop it.
  log("verifying the packed CLI ships and installs its agent skills");
  const { stdout: skillsOut } = await run(
    cliBin,
    ["skills", "list", "--json"],
    {
      cwd: consumerDir,
    },
  );
  const packedSkills = JSON.parse(skillsOut);
  if (!packedSkills.some((skill) => skill.name === "prism-plan-project")) {
    throw new Error(`packed CLI ships no planning skill: ${skillsOut}`);
  }
  await run(cliBin, ["skills", "install", "--project", "--repo", consumerDir], {
    cwd: consumerDir,
  });
  const installedSkill = await readFile(
    path.join(
      consumerDir,
      ".claude",
      "skills",
      "prism-plan-project",
      "SKILL.md",
    ),
    "utf8",
  );
  if (!installedSkill.includes("name: prism-plan-project")) {
    throw new Error("installed skill is missing its frontmatter");
  }

  log("package smoke OK");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
