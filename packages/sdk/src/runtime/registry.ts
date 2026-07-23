import type { ExecutorDefinition, ExecutorRegistry } from "./ports.js";

/**
 * Build an immutable registry from a list of executor definitions.
 *
 * - Copies the list: mutating the caller's array afterwards must not
 *   change the registry.
 * - Duplicate names throw — invalid API use throws synchronously;
 *   "failures are data" applies to expected runtime outcomes only.
 * - `names` preserves registration order.
 */
export function createExecutorRegistry(
  executors: readonly ExecutorDefinition[],
): ExecutorRegistry {
  const byName = new Map<string, ExecutorDefinition>();
  const names: string[] = [];

  for (const executor of executors) {
    if (byName.has(executor.name)) {
      throw new Error(`duplicate executor name: "${executor.name}"`);
    }

    const snapshot: ExecutorDefinition = Object.freeze({
      name: executor.name,
      execute: executor.execute,
      ...(executor.validateConfig === undefined
        ? {}
        : { validateConfig: executor.validateConfig }),
    });
    byName.set(snapshot.name, snapshot);
    names.push(snapshot.name);
  }

  const frozenNames: readonly string[] = Object.freeze(names);
  return Object.freeze({
    get(name: string): ExecutorDefinition | undefined {
      return byName.get(name);
    },
    has(name: string): boolean {
      return byName.has(name);
    },
    names: frozenNames,
  });
}
