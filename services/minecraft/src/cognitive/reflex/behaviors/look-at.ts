import type { ReflexBehavior } from '../types/behavior'

export const lookAtBehavior: ReflexBehavior = {
  id: 'look-at',
  modes: ['idle', 'social'],
  cooldownMs: 100,

  when: (ctx) => {
    // Check if we have a recent attention signal
    const { lastSignalType, lastSignalAt } = ctx.attention
    if (!lastSignalType || !lastSignalAt)
      return false

    // Must be fresh (within 2 seconds)
    if (ctx.now - lastSignalAt > 2000)
      return false

    // Respond to entity_attention signals
    return lastSignalType === 'entity_attention'
  },

  score: () => {
    // High priority but not override-level (100)
    // Allows critical survival behaviors to take precedence
    return 50
  },

  run: (ctx, perception) => {
    const { lastSignalSourceId } = ctx.attention

    if (!lastSignalSourceId)
      return null

    // Find the entity
    const target = perception.getEntity(lastSignalSourceId)
    if (!target)
      return null

    return {
      intent: {
        type: 'look_at',
        // Approximate eye height since EntityState doesn't expose height yet
        target: target.state.position.offset(0, 1.6, 0),
      },
    }
  },
}
