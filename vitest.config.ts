import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig.json sets jsx: "preserve" for Next/SWC; Vite's esbuild layer
  // would pass "preserve" through and leave .tsx modules uncompiled when
  // tests import them (landing page seam, TASK-301). Pin the automatic JSX
  // runtime for test-time transforms only — same category of Vitest-only
  // wiring as the @-alias note in tests/README.md.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
