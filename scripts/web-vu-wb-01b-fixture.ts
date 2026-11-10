/* eslint-disable no-undef */
// VU-WB-01b fixture: build report.docx on the original engine's blank template
// (buildBlankDocx from @genoffice/docx-engine) and splice in one known paragraph.
// Usage: npx tsx scripts/web-vu-wb-01b-fixture.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildBlankDocx } from '@genoffice/docx-engine'

const outDir = process.argv[2] ?? '/tmp/web-e2e'
const FIXTURE_TEXT = 'Hello from the browser bridge test — VU-WB-01b fixture 서울'

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true })

  const blank = await buildBlankDocx({ application: 'IeumOffice', appVersion: '0.12.11' })
  const zip = await JSZip.loadAsync(blank)
  const docXml = await zip.file('word/document.xml').async('string')

  const para =
    `<w:p w14:paraId="00000001"><w:pPr><w:pStyle w:val="Normal"/></w:pPr>` +
    `<w:r><w:rPr><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr>` +
    `<w:t xml:space="preserve">${FIXTURE_TEXT}</w:t></w:r></w:p>`

  if (!docXml.includes('<w:body>')) throw new Error('unexpected document.xml: no <w:body>')
  const patched = docXml.replace('<w:body>', `<w:body>${para}`)
  zip.file('word/document.xml', patched)

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  const outPath = join(outDir, 'report.docx')
  writeFileSync(outPath, bytes)

  const { createHash } = await import('node:crypto')
  console.log(
    JSON.stringify({
      outPath,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      fixtureText: FIXTURE_TEXT,
    }),
  )
}

void main()
