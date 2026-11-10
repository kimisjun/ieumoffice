/* eslint-disable no-undef */
// VU-WB-10 Diagram vertical slice through the real web bridge.
// The diagram app hosts draw.io in an iframe. In web mode the draw.io bundle
// is mirrored over HTTP at /__drawio/ (static.ts, same refusal rules as
// drawio-protocol.ts, bridge script injected) and the origin plumbing runs on
// the page origin (drawio-start.ts / frame-client.ts / bridge-protocol.ts).
// The frame document is same-origin: shape text is machine-readable
// (foreignObject divs). Slice:
//   S1 mount → S2 open (fixture shape echo) → S3 edit in draw.io (echo) →
//   S4 save (draw.io's own Ctrl+S → bridge → app writes the .drawio) →
//   S5 download/convert (CLI drawio→pdf) → S6 fresh-context reopen (echo) →
//   S7 original-engine re-parse (CLI drawio→png headless)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-10-diagram-e2e.mjs [baseURL]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const file = '/tmp/web-e2e/diagram.drawio'
const shotDir = '/tmp/web-e2e/shots-diagram'
mkdirSync(shotDir, { recursive: true })

const MARK = `DGM-SLICE-${Date.now()}`
const FIXTURE = 'VU-WB-10 DIAGRAM FIXTURE'
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

async function shapeTexts(page) {
  return page.evaluate(() => {
    const f = document.querySelector('iframe')
    if (!f?.contentDocument) return []
    return [...f.contentDocument.querySelectorAll('foreignObject div')]
      .map((e) => e.textContent.trim())
      .filter(Boolean)
  })
}
async function editorReady(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      return {
        loading: document.body.innerText.includes('여는 중'),
        doc: Boolean(f?.contentDocument),
        title: f?.contentDocument?.title ?? '',
      }
    })
    if (!s.loading && s.doc && s.title.includes('draw.io')) return { ok: true, ...s }
    await page.waitForTimeout(1500)
  }
  return { ok: false }
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`HTTP${res.status()} ${res.url().slice(-110)}`) })

  await page.goto(withToken(`/diagram/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const ready = await editorReady(page)
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasDiagramApi: typeof (window.diagramApi && window.diagramApi.consumePending) === 'function',
  }))
  noteStep('S1 renderer + draw.io mount (Chrome, HTTP-mirrored bundle)',
    bridge.hasClient && bridge.hasDiagramApi && ready.ok, { bridge, ready })

  // S2: the seeded diagram's shape text (machine echo through the same-origin frame)
  const inBytes = readFileSync(file)
  const texts2 = await shapeTexts(page)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  noteStep('S2 diagram open (shape echo)', texts2.some((t) => t.includes(FIXTURE)), {
    fixture: file, size: inBytes.length, sha256: sha256(inBytes), shapeTexts: texts2.slice(0, 4),
  })

  // S3: fit the page (draw.io's Ctrl+Shift+H) so the seeded shape is fully in
  // view, double-click it → the cell editor → replace the title, retry once
  const clickShape = async () => {
    const box = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      const fr = f.getBoundingClientRect()
      // the shape's own label, not the big wrappers that merely contain it:
      // pick the smallest box whose text carries the fixture
      const hits = [...f.contentDocument.querySelectorAll('foreignObject div')]
        .filter((e) => (e.textContent || '').includes('VU-WB-10'))
        .map((e) => ({ el: e, r: e.getBoundingClientRect() }))
        .filter((h) => h.r.width > 10 && h.r.height > 5 && h.r.height < 400 && h.r.width < 600)
        .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)
      const hit = hits[0]
      if (!hit) return null
      return { mx: fr.x + hit.r.x + hit.r.width / 2, my: fr.y + hit.r.y + hit.r.height / 2 }
    })
    if (!box) return false
    await page.mouse.dblclick(box.mx, box.my)
    await page.waitForTimeout(900)
    return true
  }
  await page.keyboard.press('Control+Shift+h')
  await page.waitForTimeout(900)
  for (let attempt = 0; attempt < 2; attempt++) {
    await clickShape()
    await page.keyboard.press('Control+a')
    await page.keyboard.type(`${FIXTURE} ${MARK}`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    if ((await shapeTexts(page)).some((t) => t.includes(MARK))) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  const texts3 = await shapeTexts(page)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 edit in draw.io (shape echo)', texts3.some((t) => t.includes(MARK)), {
    mark: MARK, echo: texts3.some((t) => t.includes(MARK)) ? 'machine' : 'MISSING',
  })

  // S4: draw.io's own Ctrl+S → the bridge's redirected save → the app writes
  await page.keyboard.press('Control+s')
  let saved = null
  for (let i = 0; i < 30 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(file)
      if (!bytes.equals(inBytes)) {
        const xml = bytes.toString('utf8')
        saved = { bytes, hasMark: xml.includes(MARK), hasFixture: xml.includes('VU-WB-10') }
      }
    } catch { /* still saving */ }
  }
  noteStep('S4 save to backing file (draw.io Ctrl+S → bridge)', !!(saved && saved.hasMark), saved ? {
    size: saved.bytes.length, sha256: sha256(saved.bytes),
    markerInXml: saved.hasMark, fixtureKept: saved.hasFixture,
  } : { detail: 'file unchanged or marker missing within 15s' })

  // S5: download/convert leg — draw.io IS a CLI convert source
  const out5 = '/tmp/web-e2e/diagram-download.pdf'
  let conv = { ok: false }
  try {
    execFileSync('node', ['packages/cli/dist/genoffice.cjs', 'convert', file, '--to', 'pdf', '--out', out5, '--force'],
      { cwd: root, encoding: 'utf8', timeout: 120000 })
    const bytes = readFileSync(out5)
    conv = { ok: bytes.length > 400, size: bytes.length, sha256: sha256(bytes) }
  } catch (e) { conv = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S5 download/convert (CLI drawio→pdf)', conv.ok === true, conv)

  // S6: fresh-context reopen → shape echo
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/diagram/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await editorReady(page2)
  const texts6 = await shapeTexts(page2)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (shape echo)',
    texts6.some((t) => t.includes(MARK)) && texts6.some((t) => t.includes(FIXTURE)), {
      shapeTexts: texts6.slice(0, 4),
    })
  await ctx2.close()

  // S7: original-engine re-parse (headless export reads the saved xml)
  const out7 = '/tmp/web-e2e/diagram-reparse.png'
  let rep = { ok: false }
  try {
    execFileSync('node', ['packages/cli/dist/genoffice.cjs', 'convert', file, '--to', 'png', '--page', 'Page-1', '--out', out7, '--force'],
      { cwd: root, encoding: 'utf8', timeout: 120000 })
    const bytes = readFileSync(out7)
    rep = { ok: bytes.length > 400, size: bytes.length, sha256: sha256(bytes) }
  } catch (e) { rep = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S7 original-engine re-parse (CLI drawio→png headless)', rep.ok === true, rep)

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-10 Diagram vertical slice (web bridge, HTTP-mirrored draw.io, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-10-diagram-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
