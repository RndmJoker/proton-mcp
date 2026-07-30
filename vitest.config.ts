import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // node, not jsdom: the server runs in Node and there is no DOM.
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      // The entry point starts the server and cannot sensibly be checked as
      // a unit. What it does is covered by the integration test instead.
      exclude: ['src/server.ts'],
    },
  },
})
