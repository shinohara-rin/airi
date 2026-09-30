import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-airi/airi-plugin-airicraft',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
