import { describe, expect, it } from 'vitest'

import { deliveryFor, eventText } from '../src/events'

describe('deliveryFor', () => {
  it.each([
    ['reflex.started', 'preempt'],
    ['player.died', 'flush'],
    ['task.failed', 'flush'],
    ['social.player_addressed_agent', 'flush'],
    ['perception.entity_noticed', 'debounce'],
    ['combat.damage_taken', 'debounce'],
    ['action_graph.goal_started', 'archive'],
    ['planner.response_applied', 'archive'],
    ['food.eaten', 'piggyback'],
    ['something.unknown', 'piggyback'],
  ])('%s -> %s', (type, expected) => {
    expect(deliveryFor(type)).toBe(expected)
  })

  it('wakes the agent only for a top-level job that reached a final state', () => {
    expect(deliveryFor('work.changed', { state: 'SUCCEEDED' })).toBe('flush')
    expect(deliveryFor('work.changed', { state: 'FAILED' })).toBe('flush')
    expect(deliveryFor('work.changed', { state: 'RUNNING' })).toBe('piggyback')
    expect(deliveryFor('work.changed', { state: 'SUCCEEDED', parentWorkId: 'w1' })).toBe('piggyback')
  })

  it('keeps the dashboard announcement away from the agent', () => {
    expect(deliveryFor('social.system_message', { text: 'Debug dashboard: http://localhost:1234' })).toBe('archive')
    expect(deliveryFor('social.system_message', { text: 'Server restarting' })).toBe('debounce')
  })
})

describe('eventText', () => {
  it('states the type and the payload fields the mod reported', () => {
    expect(eventText({ seqNo: 1, type: 'task.failed', payload: { reason: 'no path', empty: '', gone: null } }))
      .toBe('[airicraft] task.failed reason=no path')
  })

  it('shows only the listed fields of a work event', () => {
    expect(eventText({ seqNo: 2, type: 'work.changed', payload: { label: 'mine', state: 'SUCCEEDED', internal: 'x' } }))
      .toBe('[airicraft] work.changed label=mine state=SUCCEEDED')
  })

  it('cuts long values and long text', () => {
    const text = eventText({ seqNo: 3, type: 'social.player_spoke', payload: { message: 'x'.repeat(500) } })

    expect(text).toContain(`${'x'.repeat(120)}…`)
    expect(text.length).toBeLessThanOrEqual(601)
  })

  it('names the type alone when there is no payload', () => {
    expect(eventText({ seqNo: 4, type: 'food.eaten' })).toBe('[airicraft] food.eaten')
  })
})
