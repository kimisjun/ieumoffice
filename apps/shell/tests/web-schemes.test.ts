import { describe, expect, it } from 'vitest'
import { rewriteIn, rewriteOut } from '../src/web/schemes'

describe('web bridge scheme rewriting — contract fields only (QA 3차 P0-A)', () => {
  it('case 1: a body that IS a lone URL is byte-preserved', () => {
    const saved = { text: '/__mdasset://example/doc', imageSources: [] as string[], mode: 'save' }
    expect(rewriteIn('markdown', saved)).toEqual(saved)
    const desk = { text: 'md-asset://example/doc', imageSources: [] as string[], mode: 'save' }
    expect(rewriteOut('markdown', desk)).toEqual(desk)
  })

  it('case 2: prose containing a src="…" literal is byte-preserved', () => {
    const saved = { text: 'Code example: src="/__mdasset://example/doc"', mode: 'save' }
    expect(rewriteIn('markdown', saved)).toEqual(saved)
    const desk = { text: 'Code example: src="md-asset://example/doc"', mode: 'save' }
    expect(rewriteOut('markdown', desk)).toEqual(desk)
  })

  it('case 3: a fenced HTML code block is byte-preserved', () => {
    const saved = { text: '```html\n<img src="/__mdasset://example/doc">\n```', mode: 'save' }
    expect(rewriteIn('markdown', saved)).toEqual(saved)
  })

  it('case 4: an HTML TEXT NODE src="…" is byte-preserved', () => {
    const saved = { html: '<p>The example is src="/__htmlasset://example/doc" in prose.</p>' }
    expect(rewriteIn('html', saved)).toEqual(saved)
    const desk = { html: '<p>The example is src="html-asset://example/doc" in prose.</p>' }
    expect(rewriteOut('html', desk)).toEqual(desk)
  })

  it('real attributes in markup still convert (both directions)', () => {
    const saved = { html: '<img src="/__htmlasset://example/doc">' }
    expect(rewriteIn('html', saved)).toEqual({ html: '<img src="html-asset://example/doc">' })
    const desk = { html: '<a href="html-preview://v/1">x</a>' }
    expect(rewriteOut('html', desk)).toEqual({ html: '<a href="/__preview://v/1">x</a>' })
  })

  it('comments and script/style bodies are protected', () => {
    const saved = {
      html: '<!-- <img src="/__htmlasset://c"> --><script>var u = "/__htmlasset://s"</script><img src="/__htmlasset://r">',
    }
    const out = rewriteIn('html', saved) as typeof saved
    expect(out.html).toBe('<!-- <img src="/__htmlasset://c"> --><script>var u = "/__htmlasset://s"</script><img src="html-asset://r">')
  })

  it('URL fields and imageSources convert (contract shapes)', () => {
    expect(rewriteIn('markdown', { src: '/__mdasset:///notes/pic.png' })).toEqual({
      src: 'md-asset:///notes/pic.png',
    })
    const saved = { imageSources: ['/__mdasset://h/p.png', '/__mdasset://h/q.png'] }
    expect(rewriteIn('markdown', saved)).toEqual({
      imageSources: ['md-asset://h/p.png', 'md-asset://h/q.png'],
    })
    expect(rewriteOut('docs', { dataUrl: 'genoffice-docx-media://handoff/abc-uuid' })).toEqual({
      dataUrl: '/__media://handoff/abc-uuid',
    })
  })

  it('unknown fields are never touched', () => {
    const value = { note: 'text with bare md-asset and /__mdasset words', custom: 'md-asset://x' }
    expect(rewriteOut('markdown', value)).toEqual(value)
    expect(rewriteIn('markdown', value)).toEqual(value)
  })

  it('leaves other apps untouched', () => {
    const value = { src: 'genoffice-docx-media://hash/p', md: 'md-asset://x' }
    expect(rewriteOut('sheets', value)).toBe(value)
  })

  it('passes typed arrays through the rewrite unharmed', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const out = rewriteIn('docs', { data: bytes, src: '/__media://h/p' }) as {
      data: Uint8Array
      src: string
    }
    expect(out.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.data)).toEqual([1, 2, 3])
    expect(out.src).toBe('genoffice-docx-media://h/p')
  })

  it('does not double-rewrite already-rewritten literals', () => {
    const web = { src: '/__mdasset://h/p' }
    expect(rewriteOut('markdown', web)).toEqual(web)
    const desk = { src: 'md-asset://h/p' }
    expect(rewriteIn('markdown', desk)).toEqual(desk)
  })


  it('QA 4차 case 1: createDocument md content (code block) is byte-preserved', () => {
    const req = { type: 'md', title: 'T', content: '```html\n<img src="/__media://example/doc">\n```\n' }
    expect(rewriteIn('docs', req)).toEqual(req)
    const reqDesk = { type: 'md', title: 'T', content: '```html\n<img src="genoffice-docx-media://example/doc">\n```\n' }
    expect(rewriteOut('docs', reqDesk)).toEqual(reqDesk)
  })

  it('QA 4차 case 2: a src= literal INSIDE another attribute value is byte-preserved', () => {
    const req = { type: 'html', content: '<div title=\'Code example: src="/__media://example/doc"\'>text</div>' }
    expect(rewriteIn('docs', req)).toEqual(req)
  })

  it('QA 4차 case 3: textarea raw-text content is byte-preserved', () => {
    const req = { type: 'html', content: '<textarea><img src="/__media://example/doc"></textarea>' }
    expect(rewriteIn('docs', req)).toEqual(req)
  })

  it('QA 4차: real HTML attributes still convert in createDocument html content', () => {
    const req = { type: 'html', content: '<img src="/__media://example/doc">' }
    expect(rewriteIn('docs', req)).toEqual({ type: 'html', content: '<img src="genoffice-docx-media://example/doc">' })
  })

  it('round-trips mixed documents byte-identically in body text', () => {
    const mixed = {
      text: '# Doc\nLiteral /__mdasset://example/doc and md-asset://example/doc.\n```\n<img src="/__mdasset://c">\n```',
      imageSources: ['/__mdasset://img/1.png'],
    }
    const desk = rewriteIn('markdown', mixed) as typeof mixed
    expect(desk.text).toBe(mixed.text)
    expect(desk.imageSources).toEqual(['md-asset://img/1.png'])
    const web = rewriteOut('markdown', desk) as typeof mixed
    expect(web.text).toBe(mixed.text)
    expect(web.imageSources).toEqual(['/__mdasset://img/1.png'])
  })
})