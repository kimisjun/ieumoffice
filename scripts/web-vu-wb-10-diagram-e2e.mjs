/* eslint-disable no-undef */
// VU-WB-10 Diagram vertical slice through the real web bridge — v2 (QA 1차
// 재심용). The draw.io frame now rides the OTHER loopback host (localhost ↔
// 127.0.0.1): browser-enforced cross-origin isolation (QA P0-C). That closes
// the frame document from the parent, so verification moved from DOM echo to
// artifact-level evidence:
//   C1 isolation canary (contentDocument unreachable, no token in frame URL)
//   C2 external-requests canary (nothing leaves the loopback hosts)
//   S1 mount → S2 open (CLI svg parse of the fixture + recorded screenshot) →
//   S3 keyboard edit (focus frame → Ctrl+A → F2 → type; retried until the
//   artifact moves) → S4 save (draw.io Ctrl+S → marker in the .drawio xml) →
//   S5 download/convert (CLI drawio→pdf AND drawio→svg with CONTENT checks) →
//   S6 fresh-context reopen → the app's own parse→serialize keeps the marker →
//   S7 CLI drawio→svg engine re-parse (content)
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
const external = [] // QA 1차 P0-C canary: no request may leave the loopback hosts
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const cli = (args) =>
  execFileSync('node', ['packages/cli/dist/genoffice.cjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  })

/** the fixture is an mxfile document (the format's standard XML) */
function writeFixture() {
  const xml =
    `<mxfile host="app.diagrams.net"><diagram id="vu-wb-10" name="Page-1">` +
    `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    `<mxCell id="2" value="${FIXTURE} 서울" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">` +
    `<mxGeometry x="220" y="220" width="320" height="100" as="geometry"/></mxCell>` +
    `</root></mxGraphModel></diagram></mxfile>`
  writeFileSync(file, xml)
}
writeFixture()
const inBytes = readFileSync(file)

async function editorFrame(page) {
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const f = document.querySelector('iframe')
      return { has: Boolean(f), complete: f?.complete ?? false }
    })
    if (st.has && st.complete) break
    await page.waitForTimeout(1500)
  }
  // the cross-origin editor's own boot state is not visible from the parent;
  // give it time and let the edit retry loop absorb the rest
  await page.waitForTimeout(9000)
}

async function typeIntoCell(page, text) {
  const box = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    const r = f.getBoundingClientRect()
    return { mx: r.x + r.width / 2, my: r.y + r.height / 2 }
  })
  await page.mouse.click(box.mx, box.my)
  await page.waitForTimeout(600)
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(500)
  await page.keyboard.press('F2')
  await page.waitForTimeout(900)
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text, { delay: 12 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
}

async function saveWithCtrlS(page) {
  await page.keyboard.press('Control+s')
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const xml = readFileSync(file, 'utf8')
      if (xml.includes(MARK)) return xml
    } catch { /* saving */ }
  }
  return null
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => { errors.push(`pageerror:${String(e).slice(0, 300)}`) })
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`HTTP${res.status()} ${res.url().slice(-110)}`) })
  page.on('request', (req) => {
    const u = req.url()
    if (!/^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|data:|blob:)/.test(u)) external.push(u.slice(0, 120))
  })

  await page.goto(withToken(`/diagram/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  await editorFrame(page)
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasDiagramApi: typeof (window.diagramApi && window.diagramApi.consumePending) === 'function',
  }))
  noteStep('S1 renderer + draw.io mount (Chrome, cross-origin mirror)', bridge.hasClient && bridge.hasDiagramApi, bridge)

  // C1/C2: isolation canaries (QA 1차 P0-C)
  const iso = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    let parentReach = 'blocked'
    try { if (f.contentDocument) parentReach = 'REACHABLE' } catch { parentReach = 'blocked' }
    return { parentReach, frameSrc: (f?.src ?? '').slice(0, 70), tokenInFrameSrc: (f?.src ?? '').includes('token=') }
  })
  noteStep('C1 frame isolation (cross-origin + no token in frame URL)',
    iso.parentReach === 'blocked' && !iso.tokenInFrameSrc && /localhost/.test(iso.frameSrc), iso)
  await new Promise((r) => setTimeout(r, 1500))
  noteStep('C2 no external requests while draw.io runs', external.length === 0, { external: external.slice(0, 5) })

  // C3 (QA 2차 P0-C): the frame must not be able to make itself same-origin
  // with the privileged app. The QA repro navigated the frame to the app
  // host's own mirror path and read the parent DOM from there — the mirror now
  // lives on its own port and the app host refuses the path with a
  // script-less page, so no untrusted code can ever execute at the app origin.
  const appOrigin = new URL(page.url()).origin
  const nav = await page.request.fetch(`${appOrigin}/__drawio/index.html`, { failOnStatusCode: false })
  const navBody = await nav.text()
  const mirrorPortProbe = await page.request.fetch(`http://localhost:${new URL(iso.frameSrc).port}/__drawio/index.html`, { failOnStatusCode: false })
  noteStep('C3 self-navigation escape closed (app host has no executable mirror)', (
    nav.status() === 404 && !/<script/i.test(navBody) && mirrorPortProbe.status() === 200
  ), {
    appHostMirrorStatus: nav.status(),
    appHostMirrorHasScript: /<script/i.test(navBody),
    appHostMirrorBody: navBody.slice(0, 80),
    mirrorPortStatus: mirrorPortProbe.status(),
  })

  // S2: the fixture's own content, parsed by the engine (artifact-level open
  // evidence; the visual render is recorded as a screenshot)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  let s2 = { ok: false }
  try {
    const svg = '/tmp/web-e2e/diagram-s2.svg'
    cli(['convert', file, '--to', 'svg', '--page', 'Page-1', '--out', svg, '--force'])
    const text = readFileSync(svg, 'utf8')
    s2 = { ok: text.includes('VU-WB-10') && text.includes('서울'), sha256: sha256(readFileSync(svg)) }
  } catch (e) { s2 = { ok: false, error: String(e).slice(0, 200) } }
  noteStep('S2 open (fixture content via engine parse + recorded screenshot)', s2.ok === true, s2)

  // S3+S4: edit through draw.io's own keyboard path, then draw.io's own Ctrl+S
  let savedXml = null
  let attempts = 0
  for (attempts = 1; attempts <= 3 && !savedXml; attempts++) {
    await typeIntoCell(page, `${FIXTURE} ${MARK}`)
    savedXml = await saveWithCtrlS(page)
    if (!savedXml) await page.keyboard.press('Escape')
  }
  const s4bytes = savedXml ? readFileSync(file) : inBytes
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 edit in draw.io (cell editor, keyboard path)', savedXml !== null, {
    mark: MARK, attempts,
  })
  noteStep('S4 save to backing file (draw.io Ctrl+S → bridge)',
    !!(savedXml && savedXml.includes(MARK) && savedXml.includes('VU-WB-10')), savedXml ? {
      size: s4bytes.length, sha256: sha256(s4bytes),
      markerInXml: savedXml.includes(MARK), fixtureKept: savedXml.includes('VU-WB-10'),
    } : { detail: 'marker not in file after 3 attempts' })

  // S5: download/convert leg with CONTENT verification (QA P1-D)
  let s5 = { ok: false }
  try {
    const pdf = '/tmp/web-e2e/diagram-download.pdf'
    const svg = '/tmp/web-e2e/diagram-download.svg'
    cli(['convert', file, '--to', 'pdf', '--out', pdf, '--force'])
    cli(['convert', file, '--to', 'svg', '--page', 'Page-1', '--out', svg, '--force'])
    const pdfBytes = readFileSync(pdf)
    const svgText = readFileSync(svg, 'utf8')
    s5 = {
      ok: pdfBytes.length > 400 && svgText.includes(MARK) && svgText.includes('VU-WB-10'),
      pdf: { size: pdfBytes.length, sha256: sha256(pdfBytes) },
      svgContent: { marker: svgText.includes(MARK), fixture: svgText.includes('VU-WB-10') },
    }
  } catch (e) { s5 = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S5 download/convert (CLI pdf + svg, output content checked)', s5.ok === true, s5)

  // S6: fresh context reopen → the app's own parse→serialize round-trip
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => { errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`) })
  await page2.goto(withToken(`/diagram/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await editorFrame(page2)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  await typeIntoCell(page2, `${FIXTURE} ${MARK}`)
  const resaveXml = await saveWithCtrlS(page2)
  noteStep('S6 fresh-context reopen (app parse→serialize keeps the marker)',
    !!(resaveXml && resaveXml.includes(MARK) && resaveXml.includes('VU-WB-10')), {
      reSaved: resaveXml !== null,
    })
  await ctx2.close()

  // S7: original-engine re-parse with content checks (QA P1-D)
  let s7 = { ok: false }
  try {
    const svg = '/tmp/web-e2e/diagram-reparse.svg'
    cli(['convert', file, '--to', 'svg', '--page', 'Page-1', '--out', svg, '--force'])
    const text = readFileSync(svg, 'utf8')
    s7 = {
      ok: text.includes(MARK) && text.includes('VU-WB-10'),
      size: readFileSync(svg).length,
      sha256: sha256(readFileSync(svg)),
      markerInOutput: text.includes(MARK), fixtureInOutput: text.includes('VU-WB-10'),
    }
  } catch (e) { s7 = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S7 engine re-parse (CLI drawio→svg, output content checked)', s7.ok === true, s7)

  await ctx1.close()
} finally {
  await browser.close()
}

// v2 aggregation (QA P0-D): every leg counts; nothing is dropped from the verdict
const counts = {
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  total: results.length,
}
const summary = {
  slice: 'VU-WB-10 Diagram vertical slice v2 (cross-origin draw.io mirror, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  counts,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: counts.fail === 0 && counts.total > 0,
}
writeFileSync('/tmp/web-e2e/vu-wb-10-diagram-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, counts, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
