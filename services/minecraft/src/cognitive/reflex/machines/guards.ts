import type { ReflexContextSnapshot, ReflexMachineContext } from './types'

/**
 * Check if we should transition to social mode
 */
export function canEnterSocial(ctx: ReflexContextSnapshot): boolean {
  // Social mode requires recent chat activity
  if (!ctx.social.lastMessageAt) {
    return false
  }

  const timeSinceMessage = ctx.now - ctx.social.lastMessageAt
  if (timeSinceMessage > 30_000) { // 30 seconds
    return false
  }

  // Need nearby players
  return ctx.environment.nearbyPlayers.length > 0
}

/**
 * Check if we should transition to alert mode
 */
export function canEnterAlert(ctx: ReflexContextSnapshot): boolean {
  // Alert mode for low health or active threats
  if (ctx.self.health < 10) {
    return true
  }

  if (ctx.threat.threatScore > 5) {
    return true
  }

  return false
}

/**
 * Check if a behavior can run (not on cooldown)
 */
export function behaviorReady(
  context: ReflexMachineContext,
  behaviorId: string,
  cooldownMs: number,
): boolean {
  const history = context.runHistory.get(behaviorId)
  if (!history) {
    return true
  }

  const timeSinceRun = context.contextState.now - history.lastRunAt
  return timeSinceRun >= cooldownMs
}

/**
 * Check if there are in-flight actions
 */
export function hasActiveActions(context: ReflexMachineContext): boolean {
  return context.inFlightActionsCount > 0
}

/**
 * Check if active behavior should continue
 */
export function behaviorShouldContinue(context: ReflexMachineContext): boolean {
  if (!context.activeBehaviorUntil) {
    return false
  }

  return context.contextState.now < context.activeBehaviorUntil
}
