import type { NodeFailure } from "./types.js";

/**
 * Events are facts: the engine's only way of changing state, and later the
 * persistence format. Discriminated on `kind` so an exhaustive switch with
 * a `never` default catches unhandled kinds at compile time.
 *
 * Node events only, for now — run-level events can be added as new kinds
 * without breaking existing consumers (additive is compatible; renaming or
 * reusing a kind never is).
 */
export type RunEvent =
  | { readonly kind: "node_ready"; readonly nodeId: string }
  | { readonly kind: "node_started"; readonly nodeId: string }
  | {
      readonly kind: "node_succeeded";
      readonly nodeId: string;
      readonly output: unknown;
    }
  | {
      readonly kind: "node_failed";
      readonly nodeId: string;
      readonly failure: NodeFailure;
    }
  | {
      readonly kind: "node_blocked";
      readonly nodeId: string;
      /** The failed-or-blocked dependencies that caused this. */
      readonly blockedBy: readonly string[];
    };

/**
 * An event as the store returns it. `seq` is assigned by the store on
 * append — monotonic per run, gapless, starting at 0 — never by the
 * event's producer.
 */
export type PersistedRunEvent = RunEvent & { readonly seq: number };
