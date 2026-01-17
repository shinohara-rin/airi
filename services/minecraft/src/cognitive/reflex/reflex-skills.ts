import type { MineflayerWithAgents } from '../types'
import { followPlayer } from '../../skills/movement'

export interface ReflexSkills {
  followPlayer: (bot: MineflayerWithAgents, username: string) => Promise<boolean>
}

export const reflexSkills: ReflexSkills = {
  followPlayer,
}
