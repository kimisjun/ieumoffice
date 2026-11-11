/**
 * Engine re-parse probe (QA 1차 P1-B): opens a container with the ORIGINAL
 * app engines — xmind-engine's openXmind / epub-engine's openEpub — and prints
 * the parsed structure as JSON, so the E2E harness can assert on what the
 * ENGINE parsed (labels under parents, chapter titles) instead of grepping
 * zip bytes.
 *
 * Run: npx tsx scripts/engine-parse-vu.ts <xmind|epub> <file>
 */
import { readFileSync } from 'node:fs'

async function main(): Promise<void> {
  const [kind, file, needle] = process.argv.slice(2)
  const bytes = new Uint8Array(readFileSync(file))
  /** the harness passes a needle; the engine's parse output reports where it
   *  shows up — content evidence from the parser, not from zip grepping */
  const needles = needle ? { [needle]: false } : {}
  if (kind === 'xmind') {
    const { openXmind } = await import('../packages/xmind-engine/src/open')
    const result = await openXmind(bytes)
    if (result.status !== 'ok') {
      console.log(JSON.stringify({ status: result.status, detail: result.detail }))
      return
    }
    // XmindDocument: sheets → root topic tree
    const titles: string[] = []
    const walk = (t: { title?: unknown; children?: { attached?: unknown[] } }): void => {
      if (typeof t.title === 'string') titles.push(t.title)
      for (const c of (t.children?.attached ?? []) as { title?: unknown; children?: unknown }[]) {
        walk(c as never)
      }
    }
    const doc = result.document as unknown as {
      sheets?: { title?: string; rootTopic?: { title?: unknown; children?: { attached?: unknown[] } } }[]
    }
    for (const sheet of doc.sheets ?? []) {
      if (typeof sheet.title === 'string') titles.push(`sheet:${sheet.title}`)
      if (sheet.rootTopic) walk(sheet.rootTopic as never)
    }
    if (needle) needles[needle] = titles.some((t) => t.includes(needle))
    console.log(JSON.stringify({ status: 'ok', titles, needles }))
    return
  }
  if (kind === 'epub') {
    const { openEpub, openedArchive } = await import('../packages/epub-engine/src/open')
    const result = await openEpub(bytes)
    if (!('book' in (result as object))) {
      console.log(JSON.stringify({ status: (result as { status?: string }).status ?? 'error' }))
      return
    }
    const book = (result as { book: unknown }).book as {
      title?: string
      spine?: { items?: { title?: string; id?: string; href?: string }[] }
    }
    // chapter text comes from the ENGINE's own opened archive (its parse),
    // not from an external zip listing
    const archive = openedArchive(book as never)
    const chapterTexts: string[] = []
    const spineHrefs = (book.spine?.items ?? [])
      .map((i) => (i as { href?: string }).href ?? '')
      .filter(Boolean)
    if (archive) {
      // resolve spine hrefs against the archive (they are OPF-relative)
      const names = Object.keys(archive.files).filter((n) => n.endsWith('.xhtml') || n.endsWith('.html'))
      const wanted = spineHrefs.length
        ? names.filter((n) =>
            spineHrefs.some((h) => n.endsWith(decodeURIComponent(h).replace(/^\.\//, ''))),
          )
        : names
      // QA 2차 P1-B: when the spine is known, ONLY spine documents count —
      // falling back to every xhtml would make markers outside the reading
      // order false-positive (the QA's negative control). An unresolved spine
      // is an ERROR, never a wider scan.
      if (spineHrefs.length && wanted.length === 0) {
        console.log(
          JSON.stringify({ status: 'error', error: 'spine hrefs resolved to no archive documents', spineHrefs }),
        )
        return
      }
      for (const name of wanted) {
        const entry = archive.file(name)
        if (entry) chapterTexts.push(await entry.async('string'))
      }
    }
    const joined = chapterTexts.join('\n')
    if (needle) needles[needle] = joined.includes(needle)
    console.log(
      JSON.stringify({
        status: 'ok',
        title: book.title ?? null,
        spineTitles: (book.spine?.items ?? []).map((i) => i.title ?? i.id ?? ''),
        chapterCount: chapterTexts.length,
        textLength: joined.length,
        needles,
      }),
    )
    return
  }
  console.log(JSON.stringify({ status: 'error', detail: `unknown kind: ${kind}` }))
}

main().catch((e) => {
  console.log(JSON.stringify({ status: 'error', detail: String(e).slice(0, 300) }))
})
