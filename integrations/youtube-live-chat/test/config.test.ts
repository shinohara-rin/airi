import { describe, expect, it } from 'vitest'

import { readConfig } from '../src/config'

describe('connector configuration', () => {
  it('requires a chat ID and API key without exposing invalid values', () => {
    expect(() => readConfig({})).toThrow('YOUTUBE_LIVE_CHAT_ID')
    expect(() => readConfig({ YOUTUBE_LIVE_CHAT_ID: 'chat' })).toThrow('YOUTUBE_API_KEY')
    expect(() => readConfig({ YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'key', AIRI_WS_URL: 'secret-invalid-url' })).toThrow('AIRI_WS_URL')
    expect(() => readConfig({ YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'key', AIRI_WS_URL: 'secret-invalid-url' })).not.toThrow('secret-invalid-url')
  })

  it('defaults to local AIRI and skips history', () => {
    const config = readConfig({ YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'key' })
    expect(config.liveChatId).toBe('chat')
    expect(config.apiKey).toBe('key')
    expect(config.airiUrl).toBe('ws://localhost:6121/ws')
    expect(config.includeHistory).toBe(false)
    expect(config.maxRetries).toBe(5)
  })

  it('validates boolean and bounded numeric settings', () => {
    const env = { YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'key' }
    expect(readConfig({ ...env, YOUTUBE_INCLUDE_HISTORY: 'true', YOUTUBE_MAX_RETRIES: '0' }).includeHistory).toBe(true)
    expect(readConfig({ ...env, YOUTUBE_MAX_RETRIES: '0' }).maxRetries).toBe(0)
    expect(() => readConfig({ ...env, YOUTUBE_INCLUDE_HISTORY: 'yes' })).toThrow('YOUTUBE_INCLUDE_HISTORY')
    expect(() => readConfig({ ...env, YOUTUBE_MAX_RETRIES: '-1' })).toThrow('YOUTUBE_MAX_RETRIES')
    expect(() => readConfig({ ...env, YOUTUBE_MAX_RETRIES: '2.5' })).toThrow('YOUTUBE_MAX_RETRIES')
    expect(() => readConfig({ ...env, YOUTUBE_MAX_RETRIES: '' })).toThrow('YOUTUBE_MAX_RETRIES')
  })

  it('rejects API keys that cannot be sent as gRPC metadata without echoing them', () => {
    const env = { YOUTUBE_LIVE_CHAT_ID: 'chat', YOUTUBE_API_KEY: 'private\nkey' }
    expect(() => readConfig(env)).toThrow('YOUTUBE_API_KEY')
    expect(() => readConfig(env)).not.toThrow('private')
  })
})
