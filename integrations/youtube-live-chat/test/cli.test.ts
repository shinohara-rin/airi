import process from 'node:process'

import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

it('exits with a configuration error before connecting when credentials are absent', async () => {
  const result = await new Promise<{ code: string | number | undefined, stderr: string }>((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
      env: { PATH: process.env.PATH },
      timeout: 5_000,
    }, (error, _stdout, stderr) => resolve({ code: error?.code, stderr }))
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Invalid configuration: YOUTUBE_LIVE_CHAT_ID, YOUTUBE_API_KEY')
  expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND')
})

it('handles SIGTERM while AIRI is unavailable without exposing credentials', async ({ onTestFinished }) => {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      YOUTUBE_LIVE_CHAT_ID: 'fixture-chat',
      YOUTUBE_API_KEY: 'private-fixture-key',
      AIRI_WS_URL: 'ws://127.0.0.1:1/ws',
      AIRI_TOKEN: 'private-fixture-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(() => {
    child.kill()
  })
  let stdout = ''
  let stderr = ''
  let signalled = false
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
    if (!signalled && stdout.includes('connector starting')) {
      signalled = true
      child.kill('SIGTERM')
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const result = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  expect(result).toBe(0)
  expect(stdout).toContain('connector stopped')
  expect(stdout + stderr).not.toContain('private-fixture-key')
  expect(stdout + stderr).not.toContain('private-fixture-token')
})
