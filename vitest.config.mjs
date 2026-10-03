import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spawned CLI processes inherit this, so test runs never raise
    // desktop notifications.
    env: { PRISM_NOTIFY: "0" },
  },
});
