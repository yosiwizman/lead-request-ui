import { describe, it, expect } from 'vitest'

describe('smoke test', () => {
  it('should pass', () => {
    expect(true).toBe(true)
  })

  it('should do basic math', () => {
    expect(1 + 1).toBe(2)
  })
})
