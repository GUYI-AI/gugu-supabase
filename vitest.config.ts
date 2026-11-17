import { defineConfig } from 'vitest/config'

// unit:纯函数与脚本判据,不要库。integration:要一个跑过全部迁移的库(GUGU_INTEGRATION_DATABASE_URL),
// CI and local runs use test:db:start, then test:installation and test:integration (see README.md).
export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', testTimeout: 60_000 } },
    ],
  },
})
