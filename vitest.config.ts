import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
    ],
    testTimeout: 30_000, // dynamic tool loading can be slow on low-power devices (e.g. phones)
  },
});
