import process from 'node:process'

import { errorMessageFrom } from '@moeru/std'
import { Client } from '@proj-airi/server-sdk'
import { injeca } from 'injeca'

import { readConfig } from './config'
import { LiveChatConnector } from './connector'
import { createYouTubeClient } from './youtube'

/**
 * Runs one inbound chat connector. SIGINT and SIGTERM cancel its work before transport cleanup.
 * Network clients are composed here. The connector owns their shutdown after resolution.
 *
 * Call stack:
 * main
 *   -> {@link readConfig}
 *   -> {@link createYouTubeClient}
 *   -> {@link LiveChatConnector.run}
 *     -> YouTube StreamList -> AIRI Client.send
 */
async function main() {
  const config = readConfig(process.env)
  const youtube = injeca.provide('youtube:client', () => createYouTubeClient())
  const airi = injeca.provide('airi:client', () => new Client({
    name: 'youtube-live-chat',
    url: config.airiUrl,
    token: config.airiToken,
    autoConnect: false,
    autoReconnect: false,
    possibleEvents: ['input:text'],
    // Transport diagnostics can contain endpoint details. The connector reports a sanitized
    // terminal error after its retry budget. It never prints viewer text or API credentials.
    onError: () => {},
  }))
  const clients = await injeca.resolve({ youtube, airi })
  const connector = new LiveChatConnector(config, clients.youtube, clients.airi)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    console.info('YouTube live chat connector starting')
    await connector.run(controller.signal)
    console.info('YouTube live chat connector stopped')
  }
  finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

main().catch((error) => {
  console.error(errorMessageFrom(error) ?? 'YouTube live chat connector failed')
  process.exitCode = 1
})
