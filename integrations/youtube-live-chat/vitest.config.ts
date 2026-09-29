import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'youtube-live-chat',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
