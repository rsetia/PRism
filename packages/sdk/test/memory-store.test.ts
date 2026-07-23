import { createMemoryStore } from "../src/index.js";
import { runStoreContract } from "./support/run-store-contract.js";

// The memory store is now defined by the shared contract (plan §12) —
// the same suite the SQLite store must pass. Memory-only behaviors, if
// any arise, would be added here alongside this call.
runStoreContract("createMemoryStore", () => createMemoryStore());
