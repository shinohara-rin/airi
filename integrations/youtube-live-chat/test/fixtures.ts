import type { V3DataLiveChatMessageServiceHandlers } from '../src/generated/youtube/api/v3/V3DataLiveChatMessageService'

import { fileURLToPath } from 'node:url'

import { Server, ServerCredentials } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

/** Starts a real loopback gRPC server. Each caller must close it after its test. */
export async function openChatServer(handler: V3DataLiveChatMessageServiceHandlers['StreamList']) {
  const definition = loadSync(fileURLToPath(new URL('../proto/stream-list.proto', import.meta.url)), {
    defaults: true,
    arrays: true,
    objects: true,
    oneofs: true,
    longs: String,
    enums: String,
  })
  const service = definition['youtube.api.v3.V3DataLiveChatMessageService']
  if ('format' in service)
    throw new Error('Expected a service definition')
  const server = new Server()
  server.addService(service, { StreamList: handler })
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port))
  })
  return { address: `127.0.0.1:${port}`, close: () => server.forceShutdown() }
}
