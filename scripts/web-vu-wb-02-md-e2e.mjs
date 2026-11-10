/* eslint-disable no-undef */
// VU-WB-02 Markdown vertical slice through the real web bridge:
//   S1 mount → S2 open note.md → S3 edit → S4 save (Cmd+S) →
//   S5 download via /api/convert (browser fetch) → S6 fresh-context reopen →
//   S7 file verification + original-engine re-parse (headless-export pdf)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-02-md-e2e.mjs [baseURL]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const note = '/tmp/web-e2e/note.md'
const shotDir = '/tmp/web-e2e/shots-md'
mkdirSync(shotDir, { recursive: true })

const MARK = `MD-SLICE-${Date.now()}`
const FIXTURE = 'Web E2E Report'
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const errors = []
const browser = await chromium.launch({ executablePath, headless: true })

try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))

  await page.goto(withToken(`/markdown/?path=${encodeURIComponent(note)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasMarkdownApi: Boolean(window.markdownApi),
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
  }))
  noteStep('S1 renderer mount (Chrome)', bridge.hasClient && bridge.hasMarkdownApi && bridge.rootChildren > 0, bridge)

  await page.waitForFunction(
    (ft) => {
      const el = document.querySelector('.ProseMirror')
      return (el?.innerText ?? '').includes(ft) && (el?.innerText ?? '').includes('item one')
    },
    FIXTURE, { timeout: 90000 },
  )
  const inBytes = readFileSync(note)
  noteStep('S2 markdown open (fixture rendered)', true, { fixture: note, size: inBytes.length, sha256: sha256(inBytes) })

  await page.locator('.ProseMirror').first().click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(` ${MARK}`)
  await page.waitForFunction(
    (mark) => (document.querySelector('.ProseMirror')?.innerText ?? '').includes(mark),
    MARK, { timeout: 15000 },
  )
  const unsplit = await page.evaluate(
    (ft) => (document.querySelector('.ProseMirror')?.innerText ?? '').includes(ft), FIXTURE,
  )
  noteStep('S3 text edit in original editor', unsplit, { mark: MARK, fixtureUnsplit: unsplit })
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })

  await page.keyboard.press('Meta+s')
  let saved = null
  for (let i = 0; i < 40 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(note)
      const text = bytes.toString('utf8')
      if (text.includes(MARK)) saved = { bytes, text }
    } catch { /* still saving */ }
  }
  if (saved) {
    noteStep('S4 save to backing file (Cmd+S)', true, {
      size: saved.bytes.length, sha256: sha256(saved.bytes),
      hasMark: true, hasFixture: saved.text.includes(FIXTURE),
    })
  } else {
    noteStep('S4 save to backing file (Cmd+S)', false, 'marker not on disk within 20s')
  }

  // S5 download through the browser: md -> docx via /api/convert (CLI engine)
  const savedB64 = readFileSync(note).toString('base64')
  const dl = await page.evaluate(async ({ url, b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const res = await fetch(url, { method: 'POST', body: bin })
    const disp = res.headers.get('content-disposition') ?? ''
    const buf = await res.arrayBuffer()
    let b64out = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 32768) {
      b64out += String.fromCharCode(...bytes.subarray(i, i + 32768))
    }
    return { status: res.status, disposition: disp, len: bytes.length, b64: btoa(b64out) }
  }, { url: withToken('/api/convert?name=note.md&to=docx'), b64: savedB64 }).catch((e) => ({ error: String(e).slice(0, 200) }))

  let dlXml = { ok: false }
  if (dl.status === 200 && dl.b64) {
    const dlBytes = Buffer.from(dl.b64, 'base64')
    writeFileSync('/tmp/web-e2e/note-download.docx', dlBytes)
    try {
      const xml = execFileSync('unzip', ['-p', '/tmp/web-e2e/note-download.docx', 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      dlXml = {
        ok: xml.includes(MARK) && xml.includes(FIXTURE),
        hasMark: xml.includes(MARK), hasFixture: xml.includes(FIXTURE),
        docxSha256: sha256(dlBytes), docxSize: dlBytes.length,
      }
    } catch (e) { dlXml = { ok: false, unzipError: String(e).slice(0, 150) } }
  }
  noteStep('S5 download via /api/convert (browser-side, md→docx)',
    dl.status === 200 && (dl.disposition ?? '').includes('attachment') && dlXml.ok === true,
    { http: dl, docx: dlXml })

  // S6 fresh-context reopen
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/markdown/?path=${encodeURIComponent(note)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  let reopen = false
  try {
    await page2.waitForFunction(
      (mark) => {
        const t = document.querySelector('.ProseMirror')?.innerText ?? ''
        return t.includes('Web E2E Report') && t.includes(mark)
      },
      MARK, { timeout: 90000 },
    )
    reopen = true
  } catch { /* captured below */ }
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (edited content)', reopen,
    reopen ? 'fixture + marker re-rendered' : String(await page2.evaluate(() => document.querySelector('.ProseMirror')?.innerText?.slice(0, 200))))
  await ctx2.close()

  // S7 original-engine re-parse: headless export md -> pdf through the app binary
  let reparse = { ok: false }
  try {
    const electronBin = require('electron')
    const out = execFileSync(
      electronBin,
      ['apps/shell', '--headless-export', note, '--to', 'pdf', '--out', '/tmp/web-e2e/note-reparse.pdf', '--json'],
      { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 },
    )
    const pdf = existsSync('/tmp/web-e2e/note-reparse.pdf') ? readFileSync('/tmp/web-e2e/note-reparse.pdf') : null
    reparse = {
      ok: !!pdf && pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 500,
      stdout: out.trim().slice(0, 300),
      pdfSize: pdf ? pdf.length : 0,
      pdfSha256: pdf ? sha256(pdf) : null,
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 300) } }
  noteStep('S7 original-engine re-parse (headless-export pdf)', reparse.ok === true, reparse)

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-02 Markdown vertical slice (web bridge, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-02-md-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
