import { describe, expect, it } from 'vitest'
import { summarize } from '../src/commands/selection'

describe('selection summary', () => {
  it('summarizes a selected mind map topic without changing its id', () => {
    expect(
      summarize({ topics: [{ id: 'topic-a', title: 'Alpha', path: ['Plan', 'Alpha'] }] }),
    ).toBe('topic topic-a: Alpha')
  })

  it('summarizes multiple selected mind map topics', () => {
    expect(
      summarize({
        topics: [
          { id: 'a', title: 'Alpha', path: ['Plan', 'Alpha'] },
          { id: 'b', title: 'Beta', path: ['Plan', 'Beta'] },
        ],
      }),
    ).toBe('topics: a, b')
  })

  it('reports an empty selection', () => {
    expect(summarize({ none: true })).toBe('nothing is selected')
    expect(summarize({ topics: [] })).toBe('nothing is selected')
  })

  it('flattens and clips a mind map title without splitting an emoji', () => {
    const title = `  ${'a'.repeat(78)}😀${'b'.repeat(20)}\nnext  `
    expect(summarize({ topics: [{ id: 'a', title, path: ['Plan', title] }] })).toBe(
      `topic a: ${'a'.repeat(78)}…`,
    )
    expect(summarize({ topics: [{ id: 'b', title: 'Two\n lines', path: [] }] })).toBe(
      'topic b: Two lines',
    )
  })

  it('previews the selected text of a block, cut to 80 characters', () => {
    const text = 'a'.repeat(100)
    expect(summarize({ blocks: [3, 3], text })).toBe(`block 3: ${'a'.repeat(79)}…`)
    expect(summarize({ blocks: [3, 5], text: 'short' })).toBe('blocks 3-5: short')
  })

  it('does not cut an emoji in half when the preview is clipped', () => {
    // the emoji straddles the cut after 79 UTF-16 units
    const text = `${'a'.repeat(78)}😀${'b'.repeat(20)}`
    const line = summarize({ page: 2, text })
    // a lone surrogate would not survive the trip through UTF-8
    expect(Buffer.from(line).toString('utf-8')).toBe(line)
    expect(line).toBe(`page 2: ${'a'.repeat(78)}…`)
  })
})
