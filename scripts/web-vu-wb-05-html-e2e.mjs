/* eslint-disable no-undef */
// VU-WB-05 HTML vertical slice through the real web bridge (ProseMirror editor):
//   S1 mount → S2 open page.html → S3 edit → S4 save (renderer-bound Cmd+S) →
//   S5 download via /api/convert (html→docx engine, OOXML verified) →
//   S6 fresh-context reopen → S7 original-engine re-parse (headless-export docx)
// Also asserts the preview-iframe CSP frame-src fix: no CSP frame errors.
// Run: WEB_TOKEN=... node scripts/web-vu-wb-05-html-e2e.mjs [baseURL]
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
const file = '/tmp/web-e2e/page.html'
const shotDir = '/tmp/web-e2e/shots-html'
mkdirSync(shotDir, { recursive: true })

const MARK = `HTML-SLICE-${Date.now()}`
const FIXTURE = 'VU-WB-05 HTML FIXTURE 서울'
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

async function editorEcho(page) {
  // the HTML app keeps a hidden CodeMirror source editor next to the visible
  // design editor — echo (and click) the VISIBLE one only
  return page.evaluate(() =>
    [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => e.innerText)
      .filter((t) => t && t.length < 2000),
  )
}
async function waitForEcho(page, text, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await editorEcho(page)
    if (last.some((v) => String(v).includes(text))) return { ok: true, echo: last.map((v) => v.slice(0, 120)) }
    await page.waitForTimeout(400)
  }
  return { ok: false, echo: last.map((v) => v.slice(0, 120)) }
}

// the '소스' toolbar tab reveals the CodeMirror source editor — the app's
// first-class editing surface (the design pane is a sandboxed preview iframe)
async function openSourceMode(page) {
  await page.getByText('소스', { exact: true }).first().click()
  await page.waitForTimeout(800)
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))

  await page.goto(withToken(`/html/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasHtmlApi: Boolean(window.htmlApi),
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
  }))
  noteStep('S1 renderer mount (Chrome)', bridge.hasClient && bridge.hasHtmlApi, bridge)

  await openSourceMode(page)
  const echo2 = await waitForEcho(page, FIXTURE)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  const inBytes = readFileSync(file)
  noteStep('S2 html open (fixture rendered)', echo2.ok, {
    fixture: file, size: inBytes.length, sha256: sha256(inBytes), echo: echo2.echo,
  })

  // S3: edit — click the source line holding 'item one', End, add a paragraph
  const clicked = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-line')]
    const target = lines.find((l) => l.innerText.includes('item one'))
    if (!target) return null
    const r = target.getBoundingClientRect()
    return { x: r.x + Math.min(r.width - 10, 60), y: r.y + r.height / 2 }
  })
  if (clicked) await page.mouse.click(clicked.x, clicked.y)
  await page.keyboard.press('End')
  await page.keyboard.type(`\n<p>${MARK}</p>`)
  await page.waitForTimeout(600)
  const echo3 = await waitForEcho(page, MARK, 8000)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 source edit in original editor', echo3.ok, { mark: MARK, echo: echo3.echo })

  // S4: Cmd+S (renderer-bound) → backing file
  await page.keyboard.press('Meta+s')
  let saved = null
  for (let i = 0; i < 40 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(file)
      const text = bytes.toString('utf8')
      if (text.includes(MARK)) saved = { bytes, text }
    } catch { /* still saving */ }
  }
  noteStep('S4 save to backing file (Cmd+S)', !!saved, saved ? {
    size: saved.bytes.length, sha256: sha256(saved.bytes),
    hasMark: true, hasFixture: saved.text.includes('VU-WB-05 HTML FIXTURE'),
  } : 'marker not on disk within 20s')

  // S5: download via /api/convert html→docx (html2docx engine)
  const savedB64 = readFileSync(file).toString('base64')
  const dl = await page.evaluate(async ({ url, b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const res = await fetch(url, { method: 'POST', body: bin })
    const disp = res.headers.get('content-disposition') ?? ''
    const buf = new Uint8Array(await res.arrayBuffer())
    let out = ''
    for (let i = 0; i < buf.length; i += 32768) out += String.fromCharCode(...buf.subarray(i, i + 32768))
    return { status: res.status, disposition: disp, len: buf.length, b64: btoa(out) }
  }, { url: withToken('/api/convert?name=page.html&to=docx'), b64: savedB64 }).catch((e) => ({ error: String(e).slice(0, 200) }))
  let dlXml = { ok: false }
  if (dl.status === 200 && dl.b64) {
    const dlBytes = Buffer.from(dl.b64, 'base64')
    writeFileSync('/tmp/web-e2e/page-download.docx', dlBytes)
    try {
      const xml = execFileSync('unzip', ['-p', '/tmp/web-e2e/page-download.docx', 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      dlXml = {
        ok: xml.includes(MARK) && xml.includes('VU-WB-05 HTML FIXTURE'),
        hasMark: xml.includes(MARK), hasFixture: xml.includes('VU-WB-05 HTML FIXTURE'),
        docxSha256: sha256(dlBytes), docxSize: dlBytes.length,
      }
    } catch (e) { dlXml = { ok: false, unzipError: String(e).slice(0, 150) } }
  }
  noteStep('S5 download via /api/convert (browser-side, html→docx)',
    dl.status === 200 && (dl.disposition ?? '').includes('attachment') && dlXml.ok === true,
    { http: { status: dl.status, disposition: dl.disposition, len: dl.len }, docx: dlXml })

  // S6: fresh-context reopen
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/html/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await openSourceMode(page2)
  const echo6 = await waitForEcho(page2, MARK)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (edited content)', echo6.ok, {
    echo: echo6.echo, fixtureStillThere: echo6.echo.some((v) => String(v).includes('VU-WB-05 HTML FIXTURE')),
  })
  await ctx2.close()

  // S7: original-engine re-parse (headless export html→docx)
  let reparse = { ok: false }
  try {
    const electronBin = require('electron')
    const out = execFileSync(
      electronBin,
      ['apps/shell', '--headless-export', file, '--to', 'docx', '--out', '/tmp/web-e2e/page-reparse.docx', '--json'],
      { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    )
    let xml = ''
    if (existsSync('/tmp/web-e2e/page-reparse.docx')) {
      xml = execFileSync('unzip', ['-p', '/tmp/web-e2e/page-reparse.docx', 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
    }
    reparse = {
      ok: xml.includes(MARK) && xml.includes('VU-WB-05 HTML FIXTURE'),
      stdout: out.trim().slice(0, 250),
      hasMark: xml.includes(MARK), hasFixture: xml.includes('VU-WB-05 HTML FIXTURE'),
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 300) } }
  noteStep('S7 original-engine re-parse (headless-export docx, OOXML)', reparse.ok === true, reparse)

  // S8: the preview-iframe CSP fix — no frame-src violations across the run
  const cspErrors = errors.filter((e) => e.includes('Content Security Policy') || e.includes('frame-src'))
  noteStep('S8 preview CSP frame-src fix (no CSP frame violations)', cspErrors.length === 0, {
    cspErrors, totalCollected: errors.length,
  })

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-05 HTML vertical slice (web bridge, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-05-html-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
