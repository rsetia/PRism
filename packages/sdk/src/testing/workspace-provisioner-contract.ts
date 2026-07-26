import { access, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ProvisionInput,
  WorkspaceHandle,
  WorkspaceProvisioner,
} from "../node/workspace-provisioner.js";

/**
 * Creates a workspace provisioner for one contract test. Asynchronous
 * factories are supported for container or remote-control clients.
 */
export type WorkspaceProvisionerFactory = () =>
  WorkspaceProvisioner | Promise<WorkspaceProvisioner>;

/**
 * Registers Prism's WorkspaceProvisioner conformance suite with Vitest.
 * Call this at module scope in a test file.
 *
 * `makeProvisioner` is called before each test. Every successfully provisioned
 * handle is released afterward, followed by the provisioner's optional
 * `close` method.
 */
export function runWorkspaceProvisionerContract(
  label: string,
  makeProvisioner: WorkspaceProvisionerFactory,
): void {
  describe(`WorkspaceProvisioner contract: ${label}`, () => {
    let provisioner: WorkspaceProvisioner | undefined;
    const handles = new Set<WorkspaceHandle>();

    beforeEach(async () => {
      provisioner = await makeProvisioner();
    });

    function open(): WorkspaceProvisioner {
      if (provisioner === undefined) {
        throw new Error("WorkspaceProvisioner factory did not complete");
      }
      return provisioner;
    }

    async function provision(
      input: ProvisionInput = INPUT,
    ): Promise<WorkspaceHandle> {
      const handle = await open().provision(input);
      handles.add(handle);
      return handle;
    }

    afterEach(async () => {
      const opened = provisioner;
      provisioner = undefined;
      const pendingHandles = [...handles];
      handles.clear();
      if (opened !== undefined) {
        await Promise.allSettled(
          pendingHandles.map((handle) => opened.release(handle)),
        );
        await opened.close?.();
      }
    });

    test("provisions an absolute, writable directory", async () => {
      const handle = await provision();

      expect(isAbsolute(handle.dir)).toBe(true);
      expect((await stat(handle.dir)).isDirectory()).toBe(true);
      if (handle.branch !== undefined) {
        expect(handle.branch.length).toBeGreaterThan(0);
      }
      const marker = join(handle.dir, ".prism-contract-write");
      await writeFile(marker, "writable");
      await expect(access(marker)).resolves.toBeUndefined();
    });

    test("distinct attempts receive isolated workspaces", async () => {
      const first = await provision({ ...INPUT, attempt: 1 });
      const second = await provision({ ...INPUT, attempt: 2 });
      expect(first.dir).not.toBe(second.dir);
      if (first.branch !== undefined && second.branch !== undefined) {
        expect(first.branch).not.toBe(second.branch);
      }

      const marker = join(first.dir, ".prism-attempt-one");
      await writeFile(marker, "first");
      await expect(
        access(join(second.dir, ".prism-attempt-one")),
      ).rejects.toThrow();

      await open().release(first);
      await expect(access(first.dir)).rejects.toThrow();
      await expect(access(second.dir)).resolves.toBeUndefined();
    });

    test("distinct logical identifiers never alias", async () => {
      const slash = await provision({
        runId: "run/a",
        nodeId: "../worker:one",
        attempt: 1,
      });
      const question = await provision({
        runId: "run?a",
        nodeId: "..?worker?one",
        attempt: 1,
      });

      expect(slash.dir).not.toBe(question.dir);
      if (slash.branch !== undefined && question.branch !== undefined) {
        expect(slash.branch).not.toBe(question.branch);
      }
      await writeFile(join(slash.dir, ".prism-identity"), "slash");
      await expect(
        access(join(question.dir, ".prism-identity")),
      ).rejects.toThrow();
    });

    test("preserves case and Unicode identities", async () => {
      const upper = await provision({
        runId: "Run",
        nodeId: "é",
        attempt: 1,
      });
      const lower = await provision({
        runId: "run",
        nodeId: "?",
        attempt: 1,
      });

      expect(upper.dir).not.toBe(lower.dir);
      if (upper.branch !== undefined && lower.branch !== undefined) {
        expect(upper.branch).not.toBe(lower.branch);
      }
    });

    test("rejects attempts that are not positive integers", async () => {
      await expect(provision({ ...INPUT, attempt: 0 })).rejects.toThrow();
      await expect(provision({ ...INPUT, attempt: 1.5 })).rejects.toThrow();
    });

    test("release removes the workspace and is idempotent", async () => {
      const handle = await provision();
      await open().release(handle);

      await expect(access(handle.dir)).rejects.toThrow();
      await expect(open().release(handle)).resolves.toBeUndefined();
    });
  });
}

const INPUT: ProvisionInput = {
  runId: "r",
  nodeId: "n",
  attempt: 1,
};
