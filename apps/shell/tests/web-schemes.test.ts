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

  // QA 2차 P0-A: URL-FORM literals inside document prose must round-trip
  // byte-identically — this is the exact reproduce.mjs repro from the report
  it('QA repro: URL-form body literals round-trip byte-identically', () => {
    const body = 'Literal /__mdasset://example/doc and md-asset://example/doc.'
    expect(rewriteOut('markdown', body)).toBe(body)
    expect(rewriteIn('markdown', body)).toBe(body)
    expect(rewriteIn('markdown', rewriteOut('markdown', { text: body }))).toEqual({ text: body })
    const htmlBody = 'See /__preview://example/doc and html-asset://example/doc.'
    expect(rewriteIn('html', rewriteOut('html', { body: htmlBody }))).toEqual({ body: htmlBody })
    const docsBody = 'See /__media://example/doc and genoffice-docx-media://example/doc.'
    expect(rewriteIn('docs', rewriteOut('docs', { text: docsBody }))).toEqual({ text: docsBody })
  })

  it('QA repro: markdown save body with URL-form text and imageSources is lossless', () => {
    const req = {
      text: 'Literal /__mdasset://example/doc and md-asset://example/doc.\n\n![](md-asset://img/1.png)',
      imageSources: ['/__mdasset://img/1.png'], // browser form: the renderer fetches these
      mode: 'save',
    }
    const toServer = rewriteIn('markdown', req)
    // the body travels untouched; only the URL FIELD is mapped
    expect(toServer.text).toBe(req.text)
    expect(toServer.imageSources).toEqual(['md-asset://img/1.png']) // server form
    expect(rewriteOut('markdown', toServer)).toEqual(req)
  })

  it('rewrites HTML URL attribute values but never text nodes', () => {
    const html = '<p>keep md-asset://x as prose</p><img src="html-asset://y/a.png"><a href="html-preview://v/">t</a>'
    const out = rewriteOut('html', html) as string
    expect(out).toBe(
      '<p>keep md-asset://x as prose</p><img src="/__htmlasset://y/a.png"><a href="/__preview://v/">t</a>',
    )
    expect(rewriteIn('html', out)).toBe(html)
  })
})
