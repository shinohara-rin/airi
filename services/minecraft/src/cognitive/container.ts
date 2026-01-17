import type { Logg } from '@guiiai/logg'
import type { Neuri } from 'neuri'

import type { EventBus, RuleEngine } from './os'
import type { PerceptionAPI } from './perception/perception-api'
import type { ReflexExecutor } from './reflex/reflex-executor'
import type { ReflexSkills } from './reflex/reflex-skills'

import { useLogg } from '@guiiai/logg'
import { asClass, asFunction, asValue, createContainer, InjectionMode } from 'awilix'

import { ActionAgentImpl } from '../agents/action'
import { ChatAgentImpl } from '../agents/chat'
import { PlanningAgentImpl } from '../agents/planning'
import { TaskExecutor } from './action/task-executor'
import { Brain } from './conscious/brain'
import { createEventBus, createRuleEngine } from './os'
import { PerceptionPipeline } from './perception/pipeline'
import { ReflexExecutor as ReflexExecutorImpl } from './reflex/reflex-executor'
import { ReflexManager } from './reflex/reflex-manager'
import { reflexSkills } from './reflex/reflex-skills'

export interface ContainerServices {
  logger: Logg
  eventBus: EventBus
  ruleEngine: RuleEngine
  actionAgent: ActionAgentImpl
  planningAgent: PlanningAgentImpl
  chatAgent: ChatAgentImpl
  neuri: Neuri
  perceptionPipeline: PerceptionPipeline
  perception: PerceptionAPI
  taskExecutor: TaskExecutor
  brain: Brain
  reflexManager: ReflexManager
  executor: ReflexExecutor
  skills: ReflexSkills
}

export function createAgentContainer(options: {
  neuri: Neuri
  model?: string
}) {
  const container = createContainer<ContainerServices>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  })

  // Register services
  container.register({
    // Create independent logger for each agent
    logger: asFunction(() => useLogg('agent').useGlobalConfig()).singleton(),

    // Register neuri client
    neuri: asFunction(() => options.neuri).singleton(),

    // Register EventBus (Cognitive OS core)
    eventBus: asFunction(() =>
      createEventBus({
        logger: useLogg('eventBus').useGlobalConfig(),
        config: { historySize: 10000 },
      }),
    ).singleton(),

    // Register RuleEngine (YAML rules processing)
    ruleEngine: asFunction(({ eventBus }) => {
      const engine = createRuleEngine({
        eventBus,
        logger: useLogg('ruleEngine').useGlobalConfig(),
        config: {
          rulesDir: new URL('./rules', import.meta.url).pathname,
          slotMs: 20,
        },
      })
      engine.init()
      return engine
    }).singleton(),

    // Register agents
    actionAgent: asClass(ActionAgentImpl)
      .singleton()
      .inject(() => ({
        id: 'action',
        type: 'action' as const,
      })),

    planningAgent: asClass(PlanningAgentImpl)
      .singleton()
      .inject(() => ({
        id: 'planning',
        type: 'planning' as const,
        llm: {
          agent: options.neuri,
          model: options.model,
        },
      })),

    chatAgent: asClass(ChatAgentImpl)
      .singleton()
      .inject(() => ({
        id: 'chat',
        type: 'chat' as const,
        llm: {
          agent: options.neuri,
          model: options.model,
        },
        maxHistoryLength: 50,
        idleTimeout: 5 * 60 * 1000, // 5 minutes
      })),

    perceptionPipeline: asClass(PerceptionPipeline).singleton(),

    // Expose PerceptionAPI directly for injection
    perception: asFunction(({ perceptionPipeline }) => perceptionPipeline.getPerceptionAPI()),

    taskExecutor: asClass(TaskExecutor).singleton(),

    brain: asClass(Brain).singleton(),

    // Reflex Services
    executor: asClass(ReflexExecutorImpl).singleton(),
    skills: asValue(reflexSkills),

    // Reflex Manager (Reactive Layer)
    reflexManager: asClass(ReflexManager).singleton(),
  })

  return container
}
