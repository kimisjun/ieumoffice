import { describe, expect, it } from 'vitest'
import { rewriteIn, rewriteOut } from '../src/web/schemes'

describe('web bridge scheme rewriting', () => {
  it('rewrites scheme literals to same-origin paths for docs payloads', () => {
    const reply = {
      dataUrl: 'genoffice-docx-media://handoff/abc-uuid',
      nested: { list: ['genoffice-docx-media://hash/media/image1.png'] },
    }
    expect(rewriteOut('docs', reply)).toEqual({
      dataUrl: '/__media://handoff/abc-uuid',
      nested: { list: ['/__media://hash/media/image1.png'] },
    })
  })

  it('maps paths back to scheme literals on the way in', () => {
    expect(rewriteIn('markdown', { src: '/__mdasset:///notes/pic.png' })).toEqual({
      src: 'md-asset:///notes/pic.png',
    })
  })

  it('rewrites every html scheme in one payload', () => {
    const out = rewriteOut('html', {
      frame: 'html-preview://view-9/',
      img: 'html-asset://local/notes/a/',
    })
    expect(out).toEqual({ frame: '/__preview://view-9/', img: '/__htmlasset://local/notes/a/' })
  })

  it('leaves other apps untouched', () => {
    const value = { src: 'genoffice-docx-media://hash/p', md: 'md-asset://x' }
    expect(rewriteOut('sheets', value)).toBe(value)
  })

  it('passes typed arrays through the rewrite unharmed', () => {
    // document bytes ride next to strings in the same payload; index-key
    // reconstruction would turn them into {0:1, 1:2, …} and handlers'
    // Buffer.from(data) would throw
    const bytes = new Uint8Array([1, 2, 3])
    const out = rewriteIn('docs', { data: bytes, url: '/__media://h/p' }) as {
      data: Uint8Array
      url: string
    }
    expect(out.data).toBe(bytes)
    expect(out.url).toBe('genoffice-docx-media://h/p')
  })

  it('keeps classed instances (Date) intact', () => {
    const date = new Date(0)
    const out = rewriteOut('docs', { when: date })
    expect((out as { when: Date }).when).toBe(date)
  })

  // QA 1차 P0-A: rewriting must be scoped to the URL form — document text
  // carrying bare scheme names or web prefixes round-trips byte-identically
  it('leaves document text with bare scheme names untouched (lossless round-trip)', () => {
    const body = 'Literal /__mdasset and md-asset. Also __media and genoffice-docx-media.'
    expect(rewriteOut('markdown', body)).toBe(body)
    expect(rewriteIn('markdown', body)).toBe(body)
    expect(rewriteIn('markdown', rewriteOut('markdown', body))).toBe(body)
    expect(rewriteOut('docs', body)).toBe(body)
  })

  it('still rewrites URL fields inside a mixed payload', () => {
    const mixed = {
      note: 'text with bare md-asset and /__mdasset words',
      src: 'md-asset://h/p.png',
    }
    const out = rewriteOut('markdown', mixed) as typeof mixed
    expect(out.note).toBe('text with bare md-asset and /__mdasset words')
    expect(out.src).toBe('/__mdasset://h/p.png')
  })

  it('does not double-rewrite already-rewritten literals', () => {
    const web = { src: '/__mdasset://h/p' }
    expect(rewriteOut('markdown', web)).toEqual(web) // already web form
    const desk = { src: 'md-asset://h/p' }
    expect(rewriteIn('markdown', desk)).toEqual(desk) // already scheme form
  })
})
