import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own worker (and therefore its own in-memory
    // SQLite database — see test/setup.ts).
    isolate: true,
    env: {
      ACCIO_DB_PATH: ":memory:",
      // E6 tests assert Central-Time behavior independent of the host zone
      TZ: "UTC",
    },
  },
});
