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
      metadata?: { title?: string | null }
      spine?: { items?: { path?: string; title?: string; id?: string }[] }
      readText?: (path: string) => Promise<{ text?: string } | string | null>
    }
    // QA 3차 P1-B: the spine contract field is `path` (zip entry path) and the
    // text comes from the engine's own `readText(path)` — reading `href` left
    // the spine list empty and fell back to EVERY xhtml, so markers outside
    // the reading order were false positives (the QA's negative control).
    // An unresolved spine is an ERROR, never a wider scan.
    const spinePaths = (book.spine?.items ?? [])
      .map((i) => (i as { path?: string }).path ?? '')
      .filter(Boolean)
    if (spinePaths.length === 0) {
      console.log(JSON.stringify({ status: 'error', error: 'spine has no items' }))
      return
    }
    const chapterTexts: string[] = []
    for (const path of spinePaths) {
      const decoded = book.readText ? await book.readText(path) : null
      const text =
        typeof decoded === 'string' ? decoded : String((decoded as { text?: string } | null)?.text ?? '')
      chapterTexts.push(text)
    }
    const joined = chapterTexts.join('\n')
    if (needle) needles[needle] = joined.includes(needle)
    console.log(
      JSON.stringify({
        status: 'ok',
        title: book.metadata?.title ?? book.title ?? null,
        spineTitles: (book.spine?.items ?? []).map((i) => i.title ?? i.id ?? ''),
        spinePaths,
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
