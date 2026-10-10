import type { InferOutput } from 'valibot'

import { boolean, check, integer, maxValue, minLength, minValue, object, optional, pipe, regex, safeParse, string, transform, trim } from 'valibot'

const nonempty = pipe(string(), trim(), minLength(1))
const configSchema = object({
  YOUTUBE_LIVE_CHAT_ID: nonempty,
  // Reject malformed keys before grpc-js can report their contents in a metadata error.
  YOUTUBE_API_KEY: pipe(nonempty, regex(/^[\w-]+$/)),
  YOUTUBE_INCLUDE_HISTORY: optional(pipe(string(), check(value => value === 'true' || value === 'false'), transform(value => value === 'true'), boolean()), 'false'),
  YOUTUBE_MAX_RETRIES: optional(pipe(nonempty, transform(Number), integer(), minValue(0), maxValue(20)), '5'),
  AIRI_WS_URL: optional(pipe(string(), check((value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password
    }
    catch {
      return false
    }
  })), 'ws://localhost:6121/ws'),
  AIRI_TOKEN: optional(nonempty),
})

/** Validated process configuration. Credentials remain local to the network clients. */
export interface ConnectorConfig {
  liveChatId: string
  apiKey: string
  airiUrl: string
  airiToken?: string
  includeHistory: boolean
  maxRetries: number
}

/** Reads environment settings and reports field names without echoing secrets or invalid values. */
export function readConfig(env: Record<string, string | undefined>): ConnectorConfig {
  const result = safeParse(configSchema, env)
  if (!result.success) {
    const fields = new Set(result.issues.map(issue => issue.path?.[0]?.key))
    throw new Error(`Invalid configuration: ${[...fields].join(', ')}`)
  }
  const value: InferOutput<typeof configSchema> = result.output
  return {
    liveChatId: value.YOUTUBE_LIVE_CHAT_ID,
    apiKey: value.YOUTUBE_API_KEY,
    airiUrl: value.AIRI_WS_URL,
    airiToken: value.AIRI_TOKEN,
    includeHistory: value.YOUTUBE_INCLUDE_HISTORY,
    maxRetries: value.YOUTUBE_MAX_RETRIES,
  }
}
