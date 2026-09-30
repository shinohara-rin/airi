import { describe, expect, it } from 'vitest'
import { ref } from 'vue'

import { useWholeNumber } from './use-whole-number'

describe('useWholeNumber', () => {
  it('shows the setting as text and writes whole numbers back', () => {
    const seconds = ref(30)
    const text = useWholeNumber(seconds, 5)

    expect(text.value).toBe('30')
    text.value = '45'

    expect(seconds.value).toBe(45)
  })

  it('raises a number below the minimum to the minimum', () => {
    const seconds = ref(30)
    const text = useWholeNumber(seconds, 5)

    text.value = '2'

    expect(seconds.value).toBe(5)
    expect(text.value).toBe('5')
  })

  it.each(['', 'abc', '-'])('keeps the setting when the text is %j', (input) => {
    const seconds = ref(30)
    const text = useWholeNumber(seconds, 5)

    text.value = input

    expect(seconds.value).toBe(30)
  })
})
