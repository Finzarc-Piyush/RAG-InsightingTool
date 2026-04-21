// Vitest — client-side tests.
//
// Kept deliberately small: existing client tests that already use
// node:test (chartFilters, parseContentDispositionFilename,
// splitAssistantFollowUpPrompts, dashboardGridLogic, useLayoutHistory)
// continue to run via the server package's `npm test` file list so
// nothing moves in one go. New client tests — component + hook level
// ones that want `expect`, mocking, or a DOM — can live under
// src/**/*.vitest.test.ts(x) and this runner will pick them up.
//
// Add `environment: "jsdom"` and `@testing-library/*` as devDeps the
// first time a DOM-driven test lands; today the smoke test is pure.
//
// NOTE: do not wrap this header in /* ... */ block comments — the glob
// pattern above contains `*/` which silently closes the block and breaks
// esbuild config loading.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    include: ["src/**/*.{vitest.test,vitest.spec}.{ts,tsx}"],
    // Leaves the existing *.test.ts files alone — those run via the
    // server's node:test list until migrated. New vitest-native tests
    // should use `*.vitest.test.ts` (or `.vitest.spec.ts`) so the two
    // runners never double-count.
    environment: "node",
    reporters: ["default"],
    passWithNoTests: true,
  },
});
