/* eslint-disable no-undef */
// VU-WB-03 fixture: minimal REAL .xlsx (valid OOXML package) with known cells:
// A1 "hello", A2 "주일학교", B1 42, C1 =B1+1 (cached 43), D1 3.14, E1 true.
// Structure follows the Track C fixture contract (reuse of verified knowledge),
// generated independently in this worktree. Usage: node scripts/web-vu-wb-03-make-fixture.mjs
import { createRequire } from 'node:module'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const JSZip = require('jszip')

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1"><f>B1+1</f><v>43</v></c><c r="D1"><v>3.14</v></c><c r="E1" t="b"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c></row>
</sheetData>
</worksheet>`

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>hello</t></si><si><t>주일학교</t></si>
</sst>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="1"><xf xfId="0"/></cellXfs>
</styleSheet>`

const zip = new JSZip()
zip.file('[Content_Types].xml', CONTENT_TYPES)
zip.file('_rels/.rels', ROOT_RELS)
zip.file('xl/workbook.xml', WORKBOOK)
zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS)
zip.file('xl/worksheets/sheet1.xml', SHEET1)
zip.file('xl/sharedStrings.xml', SHARED_STRINGS)
zip.file('xl/styles.xml', STYLES)
const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

const outDir = process.argv[2] ?? '/tmp/web-e2e'
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'book.xlsx')
writeFileSync(outPath, bytes)
console.log(JSON.stringify({
  outPath,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  expected: { A1: 'hello', A2: '주일학교', B1: 42, C1: '=B1+1 (cached 43)', D1: 3.14, E1: true },
}))
