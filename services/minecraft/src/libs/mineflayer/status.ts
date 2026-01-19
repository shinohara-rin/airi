import type { Mineflayer } from './core'
import type { OneLinerable } from './types'

export class Status implements OneLinerable {
  public position: string
  public health: string
  public weather: string
  public timeOfDay: string

  constructor() {
    this.position = ''
    this.health = ''
    this.weather = ''
    this.timeOfDay = ''
  }

  public update(mineflayer: Mineflayer) {
    if (!mineflayer.ready)
      return

    Object.assign(this, Status.from(mineflayer))
  }

  static from(mineflayer: Mineflayer): Status {
    if (!mineflayer.ready)
      return new Status()

    const pos = mineflayer.bot.entity.position
    const weather = mineflayer.bot.isRaining ? 'Rain' : mineflayer.bot.thunderState ? 'Thunderstorm' : 'Clear'
    const timeOfDay = Status.formatMinecraftTime12h(mineflayer.bot.time.timeOfDay)

    const status = new Status()
    status.position = `x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`
    status.health = `${Math.round(mineflayer.bot.health)} / 20`
    status.weather = weather
    status.timeOfDay = timeOfDay

    return status
  }

  public static formatMinecraftTime12h(timeOfDayTicks: number): string {
    const ticks = ((timeOfDayTicks % 24000) + 24000) % 24000
    const shifted = (ticks + 6000) % 24000
    const totalMinutes = Math.floor((shifted * 60) / 1000)
    const hour24Raw = Math.floor(totalMinutes / 60)
    const minute = totalMinutes % 60

    const hour24 = (hour24Raw + (minute >= 30 ? 1 : 0)) % 24
    const suffix = hour24 >= 12 ? 'PM' : 'AM'
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
    return `${hour12} ${suffix}`
  }

  public static weatherKind(weather: string): 'clear' | 'rain' | 'thunder' {
    return weather === 'Rain'
      ? 'rain'
      : weather === 'Thunderstorm'
        ? 'thunder'
        : 'clear'
  }

  public toOneLiner(): string {
    return Object.entries(this).map(([key, value]) => `${key}: ${value}`).join('\n')
  }
}
