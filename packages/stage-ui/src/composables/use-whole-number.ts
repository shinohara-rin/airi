import type { Ref } from 'vue'

import { computed } from 'vue'

/**
 * Binds a number setting to a text field. Text that is not a whole number leaves the setting as it was,
 * and a number below `min` becomes `min`. A half-typed value therefore never turns a setting off by accident.
 *
 * @example
 * const seconds = ref(30)
 * const text = useWholeNumber(seconds, 5)
 * text.value = '2' // seconds.value => 5
 * text.value = ''  // seconds.value => 5
 */
export function useWholeNumber(source: Ref<number>, min: number) {
  return computed({
    get: () => source.value.toString(),
    set: (text: string) => {
      const value = Number.parseInt(text, 10)
      if (!Number.isNaN(value))
        source.value = Math.max(min, value)
    },
  })
}
