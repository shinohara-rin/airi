import type { ProtoGrpcType } from './generated/stream-list'

import { fileURLToPath } from 'node:url'

import { credentials, loadPackageDefinition } from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

/**
 * Opens the published YouTube gRPC service. The caller owns client shutdown.
 * The insecure option is for local protocol fixtures, never for YouTube credentials over a network.
 *
 * @param address - gRPC authority. Defaults to YouTube's public endpoint.
 * @param secure - Enables TLS. Defaults to true.
 */
export function createYouTubeClient(address = 'youtube.googleapis.com:443', secure = true) {
  const definition = loadSync(fileURLToPath(new URL('../proto/stream-list.proto', import.meta.url)), {
    defaults: true,
    arrays: true,
    objects: true,
    oneofs: true,
    longs: String,
    enums: String,
  })
  // grpc-js has no typed overload for its dynamic loader. Generated types and runtime decoding
  // use the same vendored protocol and options. Keep the required cast at this external boundary.
  // eslint-disable-next-line slop/no-chained-type-assertions -- grpc-js GrpcObject cannot express generated service constructors.
  const protocol = loadPackageDefinition(definition) as unknown as ProtoGrpcType
  const Service = protocol.youtube.api.v3.V3DataLiveChatMessageService
  return new Service(address, secure ? credentials.createSsl() : credentials.createInsecure())
}
