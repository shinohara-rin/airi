import type { ReflexBehavior } from '../types/behavior'

export const teabagBehavior: ReflexBehavior = {
  id: 'teabag',
  modes: ['social', 'idle'],
  cooldownMs: 5000,

  when: (_ctx, perception) => {
    // Check if any player is teabagging with high confidence
    const teabaggers = perception.entitiesWithBelief('teabag', 0.6)
    return teabaggers.length > 0
  },

  score: (_ctx, perception) => {
    const teabaggers = perception.entitiesWithBelief('teabag', 0.6)
    if (teabaggers.length === 0)
      return 0
    // Use highest confidence as score boost
    const maxConfidence = Math.max(...teabaggers.map(e => e.beliefs.teabag?.confidence ?? 0))
    return 60 + (maxConfidence * 20)
  },

  run: () => {
    return {
      intent: { type: 'teabag' },
    }
  },
}
