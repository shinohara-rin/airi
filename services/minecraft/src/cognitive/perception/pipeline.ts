import type { Logg } from '@guiiai/logg'

import type { EventBus } from '../os'
import type { MineflayerWithAgents } from '../types'
import type { PerceptionFrame } from './frame'
import type { PerceptionActor } from './machines'
import type { RawPerceptionEvent } from './types/raw-events'
import type { PerceptionSignal } from './types/signals'
import type { PerceptionStage } from './types/stage'

import { DebugService } from '../../debug'
import { createPerceptionFrameFromRawEvent } from './frame'
import { createPerceptionActor } from './machines'
import { MineflayerPerceptionCollector } from './mineflayer-perception-collector'
import { PerceptionAPI } from './perception-api'

export class PerceptionPipeline {
  private readonly perception: PerceptionAPI
  private perceptionActor: PerceptionActor | null = null
  private collector: MineflayerPerceptionCollector | null = null
  private initialized = false

  private readonly stages: PerceptionStage[]

  private currentFrame: PerceptionFrame | null = null
  private saliencyEmitTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: {
      eventBus: EventBus
      logger: Logg
    },
  ) {
    this.perception = new PerceptionAPI({ logger: this.deps.logger })

    this.stages = [
      {
        name: 'entity_update',
        handle: (frame) => {
          if (frame.kind !== 'world_raw')
            return frame

          const raw = frame.raw as RawPerceptionEvent

          // Feed entity updates to PerceptionAPI
          if ('entityId' in raw && 'entityType' in raw) {
            const entityRaw = raw as RawPerceptionEvent & { entityId: string, entityType: string, displayName?: string, pos?: { x: number, y: number, z: number } }
            if (entityRaw.entityType === 'player') {
              this.perception.updateEntity(entityRaw.entityId, {
                id: entityRaw.entityId,
                type: 'player',
                name: entityRaw.displayName,
                position: entityRaw.pos as any,
                isSneaking: 'sneaking' in entityRaw ? (entityRaw as any).sneaking : undefined,
              })
            }
          }

          return frame
        },
      },
      {
        name: 'attention',
        handle: (frame) => {
          if (frame.kind !== 'world_raw')
            return frame

          this.currentFrame = frame
          try {
            const raw = frame.raw as RawPerceptionEvent

            // Also emit to EventBus for rule processing
            this.emitRawToEventBus(raw)
          }
          finally {
            this.currentFrame = null
          }
          return frame
        },
      },
      {
        name: 'router',
        handle: (frame) => {
          // Emit all perception signals centrally as BotEvents
          for (const signalWrapper of frame.signals) {
            if (signalWrapper.type !== 'perception_signal')
              continue

            const signal = signalWrapper.payload as PerceptionSignal

            this.deps.eventBus.emit<PerceptionSignal>({
              type: 'perception',
              payload: signal,
              source: { component: 'perception', id: 'perception' },
            })
          }

          return frame
        },
      },
    ]
  }

  public init(bot: MineflayerWithAgents): void {
    this.initialized = true

    this.deps.logger.withFields({ maxDistance: 32 }).log('PerceptionPipeline: init')

    // Create and start perception machine actor
    this.perceptionActor = createPerceptionActor({
      slotMs: 20,
      maxDistance: 32,
      onSignal: (signal) => {
        // Attach signals to current frame for router stage emission
        this.currentFrame?.signals.push({
          type: 'perception_signal',
          payload: signal,
        })
      },
    })
    this.perceptionActor.start()
    this.perceptionActor.send({ type: 'START' })

    // Emit saliency snapshot for debug dashboard
    this.saliencyEmitTimer = setInterval(() => {
      if (!this.initialized || !this.perceptionActor)
        return

      const snapshot = this.perceptionActor.getSnapshot()
      DebugService.getInstance().emit('saliency', this.getDebugSnapshot(snapshot.context))
    }, 100)

    this.collector = new MineflayerPerceptionCollector({
      logger: this.deps.logger,
      emitRaw: (event) => {
        this.ingest(createPerceptionFrameFromRawEvent(event))
      },
      maxDistance: 32,
    })
    this.collector.init(bot)
  }

  public destroy(): void {
    this.deps.logger.log('PerceptionPipeline: destroy')
    this.collector?.destroy()
    this.collector = null

    if (this.saliencyEmitTimer) {
      clearInterval(this.saliencyEmitTimer)
      this.saliencyEmitTimer = null
    }

    // Stop perception machine
    if (this.perceptionActor) {
      this.perceptionActor.send({ type: 'STOP' })
      this.perceptionActor.stop()
      this.perceptionActor = null
    }

    this.initialized = false
  }

  /**
   * Get the PerceptionAPI for querying entity beliefs
   */
  public getPerceptionAPI(): PerceptionAPI {
    return this.perception
  }

  /**
   * Get debug snapshot from machine context for visualization
   */
  private getDebugSnapshot(context: any) {
    const counters = []
    for (const [key, counter] of context.counters.entries()) {
      counters.push({
        key,
        total: counter.total,
        window: this.exportWindow(counter),
        triggers: this.exportTriggers(counter),
        lastFireSlot: counter.lastFireSlot,
        lastFireTotal: counter.lastFireTotal,
      })
    }
    return {
      slot: context.currentSlot,
      counters,
    }
  }

  /**
   * Export window data in chronological order (oldest -> newest)
   */
  private exportWindow(counter: any): number[] {
    const windowSize = counter.counts.length
    const out = new Array<number>(windowSize)
    for (let i = 0; i < windowSize; i++) {
      const idx = (counter.head + 1 + i) % windowSize
      out[i] = counter.counts[idx] ?? 0
    }
    return out
  }

  /**
   * Export trigger markers in chronological order (oldest -> newest)
   */
  private exportTriggers(counter: any): number[] {
    const windowSize = counter.triggers.length
    const out = new Array<number>(windowSize)
    for (let i = 0; i < windowSize; i++) {
      const idx = (counter.head + 1 + i) % windowSize
      out[i] = counter.triggers[idx] ?? 0
    }
    return out
  }

  public ingest(frame: PerceptionFrame): void {
    if (!this.initialized)
      return

    let current: PerceptionFrame | null = frame
    for (const stage of this.stages) {
      if (!current)
        break
      try {
        current = stage.handle(current)
      }
      catch (err) {
        this.deps.logger.withError(err as Error).error('PerceptionPipeline: stage error')
        break
      }
    }
  }

  /**
   * Emit a raw perception event to the EventBus
   * This bridges the perception system to the rule engine
   */
  private emitRawToEventBus(raw: RawPerceptionEvent): void {
    const eventType = `raw:${raw.modality}:${raw.kind}`

    this.deps.eventBus.emit({
      type: eventType,
      payload: Object.freeze(raw),
      source: {
        component: 'perception',
        id: raw.source,
      },
    })
  }
}
