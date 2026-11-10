/* eslint-disable no-undef */
// VU-WB-03 XLSX vertical slice through the real web bridge (Univer canvas editor):
//   S1 mount → S2 open book.xlsx (cell content proof) → S3 real-canvas edit →
//   S4 save (Cmd+S → backing file + OOXML diff evidence) →
//   S5 download via /api/convert (browser fetch) → S6 fresh-context reopen →
//   S7 original-engine re-parse (headless-export pdf)
// Cell content is verified selector-agnostic: after clicking a cell, every DOM
// input value is scanned (Univer formula bar) — no brittle formula-bar selector.
// Run: WEB_TOKEN=... node scripts/web-vu-wb-03-xlsx-e2e.mjs [baseURL]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')
const JSZip = require('jszip')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const book = '/tmp/web-e2e/book.xlsx'
const shotDir = '/tmp/web-e2e/shots-xlsx'
mkdirSync(shotDir, { recursive: true })

const MARK = `XLSX-SLICE-${Date.now()}`
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

// QA 1차 P1-A: a vision-dependent leg never auto-PASSES. It waits until an
// independent adjudication file carries THIS run's screenshot hash.
const visionAdjudications = (() => {
  try { return JSON.parse(readFileSync('/tmp/web-e2e/vision-adjudication.json', 'utf8')) } catch { return {} }
})()
function visionLeg(step, machineOk, shotPath, expectations, detail = {}) {
  const sha = sha256(readFileSync(shotPath))
  const adj = visionAdjudications[sha]
  if (!machineOk) {
    noteStep(step, false, { ...detail, vision: { sha256: sha, expectations } })
    return
  }
  if (adj && adj.verdict === 'ok') {
    noteStep(step, true, {
      ...detail,
      vision: { sha256: sha, verdict: adj.verdict, reader: adj.reader ?? 'vision_analyze', expectations },
    })
    return
  }
  noteStep(`${step}: PENDING_VISION`, false, {
    ...detail,
    vision: {
      sha256: sha,
      status: adj ? adj.verdict : 'PENDING_VISION',
      expectations,
      note: 'automatic PASS withheld until an independent vision adjudication bound to this screenshot hash exists',
    },
  })
}

// click the largest canvas at a grid offset; return after settle
async function canvasClick(page, dx, dy) {
  const box = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')]
    const c = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0]
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, count: canvases.length }
  })
  await page.mouse.click(box.x + dx, box.y + dy)
  await page.waitForTimeout(500)
  return box
}

// selector-agnostic: all DOM input values + visible short texts
async function readCellEcho(page) {
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input, textarea')].map((i) => i.value).filter(Boolean)
    const editables = [...document.querySelectorAll('[contenteditable="true"]')]
      .map((e) => e.innerText)
      .filter((t) => t && t.length < 200)
    return [...inputs, ...editables].slice(0, 30)
  })
}

// the Univer formula bar updates asynchronously after selection — poll for it
async function waitForEcho(page, text, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await readCellEcho(page)
    if (last.some((v) => String(v).includes(text))) return { ok: true, echo: last }
    await page.waitForTimeout(400)
  }
  return { ok: false, echo: last }
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))

  await page.goto(withToken(`/sheets/?path=${encodeURIComponent(book)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasDesktopApi: Boolean(window.desktopApi),
    canvases: document.querySelectorAll('canvas').length,
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
  }))
  noteStep('S1 renderer mount (Chrome, Univer)', bridge.hasClient && bridge.canvases > 0, bridge)

  // wait for the grid to settle, then click cell A1 (row header ~46px + col 88px/2, col header + row/2)
  await page.waitForTimeout(6000)
  // Univer renders the formula bar outside the scanned DOM (canvas/shadow) —
  // the machine check here is click targeting (name box shows A1); the CONTENT
  // is adjudicated by independent vision reading of s2-open.png (grid shows
  // hello/주일학교/42/43/3.14/TRUE, formula bar shows 'hello') and by the S5
  // engine CSV of the same workbook. Recorded as such — not an echo check.
  const box = await canvasClick(page, 46 + 44, 20 + 12)
  const echoA1 = await waitForEcho(page, 'A1')
  const a1Shown = echoA1.ok
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  const inBytes = readFileSync(book)
  visionLeg('S2 xlsx open (A1 targeted; content vision-verified + S5 engine CSV)', a1Shown,
    join(shotDir, 's2-open.png'),
    'grid shows hello/42/43/3.14/TRUE/주일학교 and the formula bar shows hello',
    {
      fixture: book, size: inBytes.length, sha256: sha256(inBytes), echo: echoA1, canvasCount: box.count,
    })

  // S3: click an empty region (right/below fixture cells) and type two values
  await canvasClick(page, Math.min(46 + 5 * 88 + 44, box.w - 40), Math.min(20 + 8 * 24 + 12, box.h - 40))
  await page.keyboard.type(MARK)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  await page.keyboard.type('777')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 real-canvas edit', true, { mark: MARK, second: '777' })

  // S4: Cmd+S → backing file gains the marker
  await page.keyboard.press('Meta+s')
  let savedZip = null
  for (let i = 0; i < 40 && !savedZip; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(book)
      const z = await JSZip.loadAsync(bytes)
      const sheet = z.file('xl/worksheets/sheet1.xml') ? await z.file('xl/worksheets/sheet1.xml').async('string') : ''
      const sst = z.file('xl/sharedStrings.xml') ? await z.file('xl/sharedStrings.xml').async('string') : ''
      if (sheet.includes(MARK) || sst.includes(MARK)) savedZip = { bytes, z, sheet, sst }
    } catch { /* still saving */ }
  }
  if (savedZip) {
    // OOXML integrity: fixture values must survive; record which parts changed
    const before = await JSZip.loadAsync(inBytes)
    const changed = []
    for (const [name, f] of Object.entries(before.files)) {
      if (f.dir) continue
      const a = await f.async('nodebuffer')
      const b = savedZip.z.file(name) ? await savedZip.z.file(name).async('nodebuffer') : null
      if (!b || !a.equals(b)) changed.push(name)
    }
    for (const name of Object.keys(savedZip.z.files)) {
      if (!before.file(name) && !savedZip.z.files[name].dir) changed.push(`+${name}`)
    }
    const all = savedZip.sheet + savedZip.sst
    const fixtureValuesKept = all.includes('42') && all.includes('3.14') && all.includes('B1+1') && all.includes('주일학교')
    // QA 1차 P1-G: preservation and the changed-part allowlist are ASSERTS,
    // not records — anything outside the workbook's data parts fails the leg
    const allowedChanged = (name) =>
      name === 'xl/worksheets/sheet1.xml' || name === 'xl/sharedStrings.xml' ||
      name === 'xl/calcChain.xml' || name.startsWith('+xl/calcChain') ||
      name.startsWith('docProps/')
    const unexpected = changed.filter((n) => !allowedChanged(n))
    noteStep('S4 save to backing file (Cmd+S)',
      fixtureValuesKept && unexpected.length === 0, {
        size: savedZip.bytes.length, sha256: sha256(savedZip.bytes),
        hasMark: true,
        fixtureValuesKept,
        changedParts: changed,
        unexpectedChangedParts: unexpected,
      })
  } else {
    noteStep('S4 save to backing file (Cmd+S)', false, 'marker not in sheet1.xml/sharedStrings.xml within 20s')
  }

  // S5: download through the browser via /api/convert xlsx→csv
  const savedB64 = readFileSync(book).toString('base64')
  const dl = await page.evaluate(async ({ url, b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const res = await fetch(url, { method: 'POST', body: bin })
    const disp = res.headers.get('content-disposition') ?? ''
    const text = await res.text()
    return { status: res.status, disposition: disp, len: text.length, head: text.slice(0, 300) }
  }, { url: withToken('/api/convert?name=book.xlsx&to=csv'), b64: savedB64 }).catch((e) => ({ error: String(e).slice(0, 200) }))
  noteStep('S5 download via /api/convert (browser-side, xlsx→csv)',
    dl.status === 200 && (dl.disposition ?? '').includes('attachment') && (dl.head ?? '').includes(MARK),
    dl)

  // S6: fresh-context reopen → click the edit cell again → content echo
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/sheets/?path=${encodeURIComponent(book)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await page2.waitForTimeout(8000)
  // same honest split as S2: machine check = the reopened tab targets G11
  // (name box), content = vision reading of s6-reopen.png (G11 shows the edit
  // marker, G12 '777', formula bar shows the marker, fixture values intact).
  await canvasClick(page2, Math.min(46 + 5 * 88 + 44, 1200), Math.min(20 + 8 * 24 + 12, 800))
  const echo2 = await waitForEcho(page2, 'G11')
  const reopenOk = echo2.ok
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  visionLeg('S6 fresh-context reopen (G11 targeted; content vision-verified)', reopenOk,
    join(shotDir, 's6-reopen.png'),
    'G11 shows the XLSX-SLICE marker, G12 shows 777, the formula bar shows the marker, fixture values intact',
    { echo: echo2 })
  await ctx2.close()

  // S7: original-engine re-parse via the app binary
  let reparse = { ok: false }
  try {
    const electronBin = require('electron')
    const out = execFileSync(
      electronBin,
      ['apps/shell', '--headless-export', book, '--to', 'pdf', '--out', '/tmp/web-e2e/book-reparse.pdf', '--json'],
      { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    )
    const pdf = existsSync('/tmp/web-e2e/book-reparse.pdf') ? readFileSync('/tmp/web-e2e/book-reparse.pdf') : null
    reparse = {
      ok: !!pdf && pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 500,
      stdout: out.trim().slice(0, 300),
      pdfSize: pdf ? pdf.length : 0, pdfSha256: pdf ? sha256(pdf) : null,
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 300) } }
  noteStep('S7 original-engine re-parse (headless-export pdf)', reparse.ok === true, reparse)

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-03 XLSX vertical slice (web bridge, Univer, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-03-xlsx-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
