import type { PhoneticVocabularyEntry, VocabularyPack } from '@proj-airi/stage-ui/libs/voice/phonetic-vocabulary'

import { errorMessageFrom } from '@moeru/std'
import { importVocabularyPack, parseVocabularyPack } from '@proj-airi/stage-ui/libs/voice/phonetic-vocabulary'
import { useLocalStorage } from '@vueuse/core'
import { computed, shallowRef } from 'vue'

/**
 * One editable vocabulary entry. The fields keep the typed text, so a trailing comma or space stays while the user types.
 *
 * - `writtenForms`: spellings separated by commas.
 * - `pronunciations`: tokens separated by spaces, and alternatives separated by `;`. Empty derives them from the written forms.
 */
export interface VocabularyRow {
  term: string
  writtenForms: string
  pronunciations: string
  description: string
}

/** What import makes of one row: the entry, or why matching cannot use the row. */
export type VocabularyRowStatus
  = | { entry: PhoneticVocabularyEntry, derived: boolean }
    | { error: string }

interface StoredVocabulary {
  source: string
  rows: VocabularyRow[]
}

function splitList(text: string, separator: string) {
  return text.split(separator).map(item => item.trim()).filter(Boolean)
}

function rowFromEntry(entry: VocabularyPack['entries'][number]): VocabularyRow {
  return {
    term: entry.term,
    writtenForms: entry.writtenForms.join(', '),
    pronunciations: entry.pronunciations?.map(tokens => tokens.join(' ')).join('; ') ?? '',
    description: entry.description,
  }
}

function entryFromRow(row: VocabularyRow): VocabularyPack['entries'][number] {
  const pronunciations = splitList(row.pronunciations, ';').map(tokens => splitList(tokens, ' '))
  return {
    term: row.term,
    writtenForms: splitList(row.writtenForms, ','),
    ...(pronunciations.length ? { pronunciations } : {}),
    description: row.description,
  }
}

function storedFromPack(pack: VocabularyPack): StoredVocabulary {
  return { source: pack.source, rows: pack.entries.map(rowFromEntry) }
}

/**
 * Edits the domain vocabulary as a table, with JSON import and export for packs.
 *
 * Each row is imported alone, so one bad row shows its own error and the other rows still match.
 * The edits stay in local storage, so a reload keeps them.
 */
export function useVocabularyEditor(sample: VocabularyPack, options: Parameters<typeof importVocabularyPack>[1]) {
  const stored = useLocalStorage<StoredVocabulary>('devtools/voice-pipeline/vocabulary', storedFromPack(sample))

  const statuses = computed(() => stored.value.rows.map((row): VocabularyRowStatus => {
    if (!row.term.trim())
      return { error: 'Add a term.' }
    try {
      const [entry] = importVocabularyPack({ source: stored.value.source || 'manual', entries: [entryFromRow(row)] }, options)
      return entry ? { entry, derived: !row.pronunciations.trim() } : { error: 'No pronunciation. Add one, or a Chinese or English written form.' }
    }
    catch (error) {
      return { error: errorMessageFrom(error) ?? 'The row is not valid' }
    }
  }))
  const entries = computed(() => statuses.value.flatMap(status => 'entry' in status ? [status.entry] : []))

  function add() {
    stored.value.rows.push({ term: '', writtenForms: '', pronunciations: '', description: '' })
  }

  function remove(index: number) {
    stored.value.rows.splice(index, 1)
  }

  function reset() {
    stored.value = storedFromPack(sample)
  }

  /** The pack as JSON, for export or for editing many rows at once. */
  const json = shallowRef('')
  const jsonError = shallowRef<string>()

  function openJson() {
    json.value = JSON.stringify({ source: stored.value.source, entries: stored.value.rows.map(entryFromRow) }, null, 2)
    jsonError.value = undefined
  }

  /** Replaces the rows with the pack in `json`. Returns false and keeps the rows when the pack is not valid. */
  function applyJson() {
    try {
      stored.value = storedFromPack(parseVocabularyPack(JSON.parse(json.value)))
      jsonError.value = undefined
      return true
    }
    catch (error) {
      jsonError.value = errorMessageFrom(error) ?? 'The pack is not valid'
      return false
    }
  }

  return { stored, statuses, entries, add, remove, reset, json, jsonError, openJson, applyJson }
}
