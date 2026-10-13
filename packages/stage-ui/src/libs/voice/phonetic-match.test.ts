import type { PhoneticVocabularyEntry } from './phonetic-vocabulary'

import { describe, expect, it } from 'vitest'

import { kwsVocabulary } from './kws-model'
import { english, pronounceEnglish } from './phonetic-english'
import { mandarin, pronounceChinese } from './phonetic-mandarin'
import { createPhoneticMatcher } from './phonetic-match'
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
    const match = createPhoneticMatcher([sulfurCube, creeper], [mandarin])

    const [suggestion, ...rest] = match('我刚才在温泉边遇到了一只流氓怪')

    expect(rest).toEqual([])
    expect(suggestion.span).toBe('流氓怪')
    expect(suggestion.candidate).toBe('硫方怪')
    expect(suggestion.source).toBe('minecraft-wiki')
    expect(suggestion.description).toBe(sulfurCube.description)
    expect(suggestion.score).toBeGreaterThan(0.8)
  })

  it('does not suggest a term that the transcript already spells correctly', () => {
    const match = createPhoneticMatcher([sulfurCube], [mandarin])

    expect(match('我遇到了一只硫方怪')).toEqual([])
  })

  it('ignores text that sounds different', () => {
    const match = createPhoneticMatcher([sulfurCube, creeper], [mandarin])

    expect(match('今天天气很好，我们去公园散步吧')).toEqual([])
  })

  it('treats a tone change as almost the same sound', () => {
    const match = createPhoneticMatcher([creeper], [mandarin])

    expect(match('有个酷力爬在后面')[0]?.candidate).toBe('苦力怕')
  })

  it('skips a pronunciation in the tokens of another language', () => {
    const match = createPhoneticMatcher([{ ...creeper, pronunciations: [['K', 'R', 'IY1', 'P', 'ER0']] }], [mandarin])

    expect(match('有个酷力爬在后面')).toEqual([])
  })

  it('returns the best non-overlapping suggestions up to the limit', () => {
    const match = createPhoneticMatcher([sulfurCube, creeper], [mandarin], { limit: 1 })

    const suggestions = match('流氓怪和酷力爬')

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].span).toBe('酷力爬')
  })
})

describe('createPhoneticMatcher with English', () => {
  const zustand: PhoneticVocabularyEntry = {
    term: 'Zustand',
    writtenForms: ['Zustand'],
    pronunciations: [['Z', 'UW1', 'S', 'T', 'AE2', 'N', 'D']],
    description: 'A small state library for React.',
    source: 'llm-guess',
  }
  const memoize: PhoneticVocabularyEntry = {
    term: 'memoize',
    writtenForms: ['memoize'],
    pronunciations: [['M', 'EH1', 'M', 'AH0', 'AY2', 'Z']],
    description: 'Cache the result of a function for the same inputs.',
    source: 'llm-guess',
  }

  it('matches a term that the recognizer split into common words', () => {
    const match = createPhoneticMatcher([zustand, memoize], [mandarin, english])

    const suggestions = match('I keep my state in zoo stand, and I memo eyes the selectors.')

    expect(suggestions.map(item => [item.span, item.candidate])).toEqual([
      ['zoo stand', 'Zustand'],
      ['memo eyes', 'memoize'],
    ])
  })

  it('matches English words inside a Chinese transcript', () => {
    const match = createPhoneticMatcher([zustand, sulfurCube], [mandarin, english])

    const suggestions = match('我用 zoo stand 管理状态，还遇到了流氓怪')

    expect(suggestions.map(item => item.candidate).sort()).toEqual(['Zustand', '硫方怪'])
  })

  it('ignores ordinary English text', () => {
    const match = createPhoneticMatcher([zustand, memoize], [mandarin, english])

    expect(match('I use React with a reducer and a context provider.')).toEqual([])
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

  it('derives pronunciations from English written forms in the dictionary', () => {
    const entries = importVocabularyPack({
      source: 'minecraft-wiki',
      entries: [{ term: 'Sulfur Cube', writtenForms: ['Sulfur Cube'], description: sulfurCube.description }],
    }, { vocabulary: kwsVocabulary, pronounce: pronounceEnglish })

    expect(entries[0].pronunciations).toEqual([['S', 'AH1', 'L', 'F', 'ER0', 'K', 'Y', 'UW1', 'B']])
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
