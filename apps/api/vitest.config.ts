import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: "test",
      PASSWORD_SCRYPT_LOG_N: "10",
    },
  },
});
