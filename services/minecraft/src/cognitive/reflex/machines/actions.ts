import type { BehaviorDefinition, ReflexContextSnapshot, ReflexMachineContext } from './types'

/**
 * Update the reflex context state
 */
export function updateContextState(
  context: ReflexMachineContext,
  patch: Partial<ReflexContextSnapshot>,
): ReflexMachineContext {
  return {
    ...context,
    contextState: {
      ...context.contextState,
      ...patch,
    },
  }
}

/**
 * Update environment portion of context
 */
export function updateEnvironment(
  context: ReflexMachineContext,
  patch: Partial<ReflexContextSnapshot['environment']>,
): ReflexMachineContext {
  return {
    ...context,
    contextState: {
      ...context.contextState,
      environment: {
        ...context.contextState.environment,
        ...patch,
      },
    },
  }
}

/**
 * Update social portion of context
 */
export function updateSocial(
  context: ReflexMachineContext,
  patch: Partial<ReflexContextSnapshot['social']>,
): ReflexMachineContext {
  return {
    ...context,
    contextState: {
      ...context.contextState,
      social: {
        ...context.contextState.social,
        ...patch,
      },
    },
  }
}

/**
 * Update attention portion of context
 */
export function updateAttention(
  context: ReflexMachineContext,
  patch: Partial<ReflexContextSnapshot['attention']>,
): ReflexMachineContext {
  return {
    ...context,
    contextState: {
      ...context.contextState,
      attention: {
        ...context.contextState.attention,
        ...patch,
      },
    },
  }
}

/**
 * Increment in-flight actions count
 */
export function incrementActionsCount(
  context: ReflexMachineContext,
): ReflexMachineContext {
  return {
    ...context,
    inFlightActionsCount: context.inFlightActionsCount + 1,
  }
}

/**
 * Decrement in-flight actions count
 */
export function decrementActionsCount(
  context: ReflexMachineContext,
): ReflexMachineContext {
  return {
    ...context,
    inFlightActionsCount: Math.max(0, context.inFlightActionsCount - 1),
  }
}

/**
 * Set active behavior
 */
export function setActiveBehavior(
  context: ReflexMachineContext,
  behaviorId: string,
  durationMs?: number,
): ReflexMachineContext {
  const until = durationMs ? context.contextState.now + durationMs : null

  return {
    ...context,
    activeBehaviorId: behaviorId,
    activeBehaviorUntil: until,
  }
}

/**
 * Clear active behavior
 */
export function clearActiveBehavior(
  context: ReflexMachineContext,
): ReflexMachineContext {
  return {
    ...context,
    activeBehaviorId: null,
    activeBehaviorUntil: null,
  }
}

/**
 * Record behavior run for cooldown tracking
 */
export function recordBehaviorRun(
  context: ReflexMachineContext,
  behaviorId: string,
): ReflexMachineContext {
  const newHistory = new Map(context.runHistory)
  newHistory.set(behaviorId, { lastRunAt: context.contextState.now })

  return {
    ...context,
    runHistory: newHistory,
  }
}

/**
 * Set locked follow target for social mode
 */
export function setFollowTarget(
  context: ReflexMachineContext,
  targetName: string | null,
): ReflexMachineContext {
  return {
    ...context,
    lockedFollowTargetName: targetName,
  }
}

/**
 * Select best behavior for current mode and context
 * Returns behavior ID and score, or null if none match
 */
export function selectBehavior(
  context: ReflexMachineContext,
  mode: string,
): { behaviorId: string, score: number } | null {
  const ctx = context.contextState
  const now = ctx.now

  let best: { behavior: BehaviorDefinition, score: number } | null = null

  for (const behavior of context.behaviors) {
    // Check if behavior is valid for this mode
    if (!behavior.modes.includes(mode as any)) {
      continue
    }

    // Check behavior guard
    if (!behavior.when(ctx)) {
      continue
    }

    // Calculate score
    const score = behavior.score(ctx)
    if (score <= 0) {
      continue
    }

    // Check cooldown
    const history = context.runHistory.get(behavior.id)
    const cooldownMs = behavior.cooldownMs ?? 0
    if (history && cooldownMs > 0 && now - history.lastRunAt < cooldownMs) {
      continue
    }

    // Track best
    if (!best || score > best.score) {
      best = { behavior, score }
    }
  }

  if (!best) {
    return null
  }

  return {
    behaviorId: best.behavior.id,
    score: best.score,
  }
}
