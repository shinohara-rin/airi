import type { MineflayerWithAgents } from '../types'
import type { ReflexIntent } from './types/intents'

export class ReflexExecutor {
  public async execute(intent: ReflexIntent, bot: MineflayerWithAgents): Promise<void> {
    switch (intent.type) {
      case 'chat':
        if (intent.message) {
          bot.bot.chat(intent.message)
        }
        break

      case 'look_at':
        if (intent.target) {
          await bot.bot.lookAt(intent.target, true)
        }
        break

      case 'teabag':
        for (let i = 0; i < 4; i++) {
          bot.bot.setControlState('sneak', true)
          await new Promise(resolve => setTimeout(resolve, 150))
          bot.bot.setControlState('sneak', false)
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        break
    }
  }
}
