import process from 'node:process'

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

/** What the mod writes to its discovery file on every launch. */
interface BridgeState {
  port: number
  token: string
}

/** No answer from the bridge: the game is not running, or it restarted with a new port and token. */
export class BridgeUnreachable extends Error {}

/** The bridge answered with an error status. */
export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface BridgeEvent {
  seqNo: number
  type: string
  payload?: Record<string, unknown>
}

export interface EventFeed {
  oldestSeqNo: number
  latestSeqNo: number
  /** The buffer dropped events between the requested cursor and `oldestSeqNo`. */
  truncated: boolean
  events: BridgeEvent[]
}

export interface BridgeClientOptions {
  /** Path of the discovery file. @default $AIRICRAFT_BRIDGE_STATE_FILE, then ~/.airicraft/bridge-state.json */
  stateFile?: string
  fetchImpl?: typeof fetch
}

function readBridgeState(file: string): BridgeState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  }
  catch {
    throw new BridgeUnreachable(`bridge state file not found: ${file}`)
  }

  let parsed: Partial<BridgeState>
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new BridgeUnreachable(`bridge state file is malformed: ${file}`)
  }

  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string')
    throw new BridgeUnreachable(`bridge state file is malformed: ${file}`)

  return { port: parsed.port, token: parsed.token }
}

/**
 * Client for the airicraft localhost bridge.
 *
 * State model: the port and token are cached from the discovery file. The mod rewrites that file with a new
 * port and token on every launch, so the cache is dropped after a failed request or a 401 and the next call
 * reads the file again.
 */
export class BridgeClient {
  private cached: BridgeState | undefined
  private readonly doFetch: typeof fetch

  constructor(private readonly options: BridgeClientOptions = {}) {
    this.doFetch = options.fetchImpl ?? fetch
  }

  private state() {
    this.cached ??= readBridgeState(this.options.stateFile || process.env.AIRICRAFT_BRIDGE_STATE_FILE || join(homedir(), '.airicraft', 'bridge-state.json'))
    return this.cached
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const state = this.state()
    let response: Response
    try {
      response = await this.doFetch(`http://127.0.0.1:${state.port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    }
    catch (error) {
      if (signal?.aborted)
        throw error
      this.cached = undefined
      throw new BridgeUnreachable(errorMessageFrom(error) ?? 'request failed')
    }

    const text = await response.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? JSON.parse(text) : {}
    }
    catch {
      // A body that is not JSON falls through to the status check below.
    }

    if (response.status === 401)
      this.cached = undefined

    if (!response.ok)
      throw new BridgeError(response.status, String(json.error ?? json.errorCode ?? 'http_error'), String(json.message ?? (text || response.statusText)))

    return json
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const json = await this.request('GET', '/v1/agent/tools')
    const entries = Array.isArray(json.tools) ? json.tools : []
    return entries.flatMap((entry: { function?: Partial<ToolDescriptor> } & Partial<ToolDescriptor>) => {
      const fn = entry.function ?? entry
      if (typeof fn.name !== 'string')
        return []
      return [{ name: fn.name, description: fn.description ?? '', parameters: fn.parameters ?? { type: 'object', properties: {} } }]
    })
  }

  /** Runs one tool. The mod reports its own failures as result text that starts with `TOOL_ERROR:`. */
  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number, signal?: AbortSignal }) {
    const json = await this.request('POST', '/v1/agent/tools', { name, arguments: args, timeoutMs: options.timeoutMs }, options.signal)
    return {
      text: typeof json.result === 'string' ? json.result : '',
      imageAttached: json.imageAttached === true,
    }
  }

  /** `since` of `null` asks for what the buffer still holds. Otherwise the feed has events with `seqNo > since`. */
  async recentEvents(since: number | null, signal?: AbortSignal): Promise<EventFeed> {
    const json = await this.request('GET', `/v1/agent/events/recent${since === null ? '' : `?since=${since}`}`, undefined, signal)
    return {
      oldestSeqNo: typeof json.oldestSeqNo === 'number' ? json.oldestSeqNo : 0,
      latestSeqNo: typeof json.latestSeqNo === 'number' ? json.latestSeqNo : 0,
      truncated: json.truncated === true,
      events: Array.isArray(json.events) ? json.events : [],
    }
  }
}
