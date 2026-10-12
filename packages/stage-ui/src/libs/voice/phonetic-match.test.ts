import type { PhoneticVocabularyEntry } from './phonetic-vocabulary'

import { describe, expect, it } from 'vitest'

import { kwsVocabulary } from './kws-model'
import { createPhoneticMatcher, pronounceChinese } from './phonetic-match'
import { importVocabularyPack } from './phonetic-vocabulary'

const sulfurCube: PhoneticVocabularyEntry = {
  term: 'Sulfur Cube',
  writtenForms: ['硫方怪'],
  pronunciations: [['l', 'iú', 'f', 'āng', 'g', 'uài']],
  description: 'A cube-shaped Minecraft mob that lives near sulfur springs.',
  source: 'minecraft-wiki',
}

const creeper: PhoneticVocabularyEntry = {
  term: 'Creeper',
  writtenForms: ['苦力怕'],
  pronunciations: [['k', 'ǔ', 'l', 'ì', 'p', 'à']],
  description: 'A green Minecraft mob that explodes near the player.',
  source: 'minecraft-wiki',
}

describe('createPhoneticMatcher', () => {
  it('suggests 硫方怪 for the plausible mishearing 流氓怪', () => {
    const match = createPhoneticMatcher([sulfurCube, creeper])

    const [suggestion, ...rest] = match('我刚才在温泉边遇到了一只流氓怪')

    expect(rest).toEqual([])
    expect(suggestion.span).toBe('流氓怪')
    expect(suggestion.candidate).toBe('硫方怪')
    expect(suggestion.source).toBe('minecraft-wiki')
    expect(suggestion.description).toBe(sulfurCube.description)
    expect(suggestion.score).toBeGreaterThan(0.8)
  })

  it('does not suggest a term that the transcript already spells correctly', () => {
    const match = createPhoneticMatcher([sulfurCube])

    expect(match('我遇到了一只硫方怪')).toEqual([])
  })

  it('ignores text that sounds different', () => {
    const match = createPhoneticMatcher([sulfurCube, creeper])

    expect(match('今天天气很好，我们去公园散步吧')).toEqual([])
  })

  it('treats a tone change as almost the same sound', () => {
    const match = createPhoneticMatcher([creeper])

    expect(match('有个酷力爬在后面')[0]?.candidate).toBe('苦力怕')
  })

  it('returns the best non-overlapping suggestions up to the limit', () => {
    const match = createPhoneticMatcher([sulfurCube, creeper], { limit: 1 })

    const suggestions = match('流氓怪和酷力爬')

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].span).toBe('酷力爬')
  })
})

describe('importVocabularyPack', () => {
  it('derives pronunciations from Chinese written forms', () => {
    const entries = importVocabularyPack({
      source: 'minecraft-wiki',
      entries: [{ term: 'Sulfur Cube', writtenForms: ['硫方怪'], description: sulfurCube.description }],
    }, { vocabulary: kwsVocabulary, pronounce: pronounceChinese })

    expect(entries).toEqual([sulfurCube])
  })

  it('drops an entry that has no pronunciation and no Chinese written form', () => {
    const entries = importVocabularyPack({
      source: 'react',
      entries: [{ term: 'Zustand', writtenForms: [], description: 'A small React state library.' }],
    }, { vocabulary: kwsVocabulary, pronounce: pronounceChinese })

    expect(entries).toEqual([])
  })

  it('rejects a pronunciation outside the model vocabulary', () => {
    expect(() => importVocabularyPack({
      source: 'react',
      entries: [{ term: 'memoize', writtenForms: [], pronunciations: [['memo', 'ize']], description: 'Cache a function result.' }],
    }, { vocabulary: kwsVocabulary, pronounce: pronounceChinese })).toThrow('does not match the model vocabulary')
  })
})
