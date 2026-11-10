import { readFileSync } from 'node:fs'

async function main(): Promise<void> {
  const { openEpub, openedArchive } = await import('../packages/epub-engine/src/open')
  const r = (await openEpub(new Uint8Array(readFileSync('/tmp/web-e2e/book.epub')))) as {
    book?: Record<string, unknown>
    status?: string
  }
  if (!r.book) {
    console.log('no book:', r.status)
    return
  }
  console.log('book keys:', Object.keys(r.book))
  console.log('spine:', JSON.stringify(r.book.spine, null, 1).slice(0, 600))
  const a = openedArchive(r.book as never)
  console.log('archive files:', a ? Object.keys(a.files).slice(0, 14) : null)
}
main()
