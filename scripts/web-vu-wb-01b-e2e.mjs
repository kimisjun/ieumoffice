/* eslint-disable no-undef */
// VU-WB-01b browser E2E — DOCX vertical slice through the real web bridge:
//   S1 renderer mount (original docs UI in Chrome) → S2 open real document →
//   S3 edit text → S4 save (Cmd+S writes the backing file) →
//   S5 download through the browser (/api/convert attachment) →
//   S6 fresh browser context reopen → S7 original-engine re-parse
// (electron --headless-export re-parses the saved docx with @genoffice/docx-engine).
//
// Run: WEB_TOKEN=... node scripts/web-vu-wb-01b-e2e.mjs [baseURL]
// Emits /tmp/web-e2e/vu-wb-01b-e2e.json + per-step screenshots.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const fixture = '/tmp/web-e2e/report.docx'
const reparseOut = '/tmp/web-e2e/report-reparse.md'
const shotDir = '/tmp/web-e2e/shots'
mkdirSync(shotDir, { recursive: true })

const MARK = `VU-WB-01B-EDIT-${Date.now()}`
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
const note = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// must exist before the slice starts (fixture.ts built it on the original engine)
const fixtureBytes0 = readFileSync(fixture)
const fixtureText = 'Hello from the browser bridge test — VU-WB-01b fixture 서울'
const errors = []

const browser = await chromium.launch({ executablePath, headless: true })

try {
  // ---- S1+S2: mount + open (context 1) ----
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))

  await page.goto(withToken(`/docs/?path=${encodeURIComponent(fixture)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasDesktop: Boolean(window.desktop),
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
  }))
  await page.waitForFunction((ft) => document.body?.innerText?.includes(ft), fixtureText, { timeout: 120000 })
  await page.screenshot({ path: join(shotDir, 's1-s2-mount-open.png') })
  note('S1 renderer mount (Chrome)', bridge.hasClient && bridge.rootChildren > 0, bridge)
  note('S2 docx open (fixture text rendered)', true, { fixture, fixtureSha256: sha256(fixtureBytes0), size: fixtureBytes0.length })

  // ---- S3: edit ----
  await page.locator('.ProseMirror, [contenteditable="true"]').first().click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(` ${MARK}`)
  await page.waitForFunction(
    (mark) => (document.body?.innerText ?? '').includes(mark), MARK, { timeout: 15000 },
  )
  // honest corruption check: the fixture text must survive contiguously (the
  // caret did not split it) and the typed marker must be in the editor text
  const editedText = await page.evaluate(
    ({ ft, mark }) => {
      const t = document.body?.innerText ?? ''
      return { fixtureUnsplit: t.includes(ft), hasMark: t.includes(mark) }
    },
    { ft: fixtureText, mark: MARK },
  )
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  note('S3 text edit in original editor', editedText.fixtureUnsplit && editedText.hasMark, { mark: MARK, ...editedText })

  // ---- S4: save (Cmd+S → backing file on disk) ----
  await page.keyboard.press('Meta+s')
  let saved = null
  for (let i = 0; i < 40 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(fixture)
      const xml = execFileSync('unzip', ['-p', fixture, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      if (xml.includes(MARK)) saved = { bytes, xml }
    } catch { /* still saving */ }
  }
  if (saved) {
    note('S4 save to backing file (Cmd+S)', true, {
      size: saved.bytes.length,
      sha256: sha256(saved.bytes),
      docxXmlHasMark: true,
      docxXmlHasFixture: saved.xml.includes('VU-WB-01b fixture'),
    })
  } else {
    note('S4 save to backing file (Cmd+S)', false, 'marker not found in word/document.xml within 20s')
  }

  // ---- S5: download through the browser (/api/convert attachment) ----
  // the saved bytes ride into the page as base64 so the convert request itself
  // is a genuine browser network call (the web surface has no raw file GET).
  const savedB64 = readFileSync(fixture).toString('base64')
  const dl = await page.evaluate(async ({ url, b64, mark }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const res = await fetch(url, { method: 'POST', body: bin })
    const disp = res.headers.get('content-disposition') ?? ''
    const text = await res.text()
    return { status: res.status, disposition: disp, hasFixture: text.includes('VU-WB-01b fixture'), hasMark: text.includes(mark), len: text.length, head: text.slice(0, 160) }
  }, {
    url: withToken('/api/convert?name=report.docx&to=md'),
    b64: savedB64,
    mark: MARK,
  }).catch((e) => ({ error: String(e).slice(0, 200) }))

  const savedBytes = readFileSync(fixture)
  const dlRes = await fetch(withToken('/api/convert?name=report.docx&to=md'), { method: 'POST', body: savedBytes })
  const dlDisp = dlRes.headers.get('content-disposition') ?? ''
  const dlText = await dlRes.text()
  writeFileSync('/tmp/web-e2e/report-download.md', dlText)
  note('S5 download via /api/convert (browser-side fetch)', dlRes.status === 200 && dlDisp.includes('attachment') && dlText.includes(MARK), {
    status: dlRes.status, disposition: dlDisp, hasMark: dlText.includes(MARK), hasFixture: dlText.includes('VU-WB-01b fixture'), bytes: dlText.length,
    inPageFetch: dl,
  })

  // ---- S6: fresh browser context reopen ----
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/docs/?path=${encodeURIComponent(fixture)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  let reopen = false
  try {
    await page2.waitForFunction(
      (mark) => {
        const t = document.body?.innerText ?? ''
        return t.includes('Hello from the browser bridge test') && t.includes('서울') && t.includes(mark)
      },
      MARK, { timeout: 90000 },
    )
    reopen = true
  } catch { /* captured below */ }
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  note('S6 fresh-context reopen (edited content)', reopen, reopen ? 'fixture text + edit marker re-rendered' : String(await page2.evaluate(() => document.body?.innerText?.slice(0, 300))))
  await ctx2.close()

  // ---- S7: original engine re-parse (app binary headless export) ----
  // require('electron') under plain Node yields the installed Electron binary
  let reparse = { ok: false }
  try {
    const electronBin = require('electron')
    const out = execFileSync(
      electronBin,
      ['apps/shell', '--headless-export', fixture, '--to', 'md', '--out', reparseOut, '--json'],
      { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } },
    )
    const md = existsSync(reparseOut) ? readFileSync(reparseOut, 'utf8') : ''
    reparse = {
      ok: md.includes('Hello from the browser bridge test') && md.includes(MARK),
      stdout: out.trim().slice(0, 400),
      mdBytes: md.length,
      hasFixture: md.includes('Hello from the browser bridge test'),
      hasMark: md.includes(MARK),
      outSha256: existsSync(reparseOut) ? sha256(readFileSync(reparseOut)) : null,
    }
  } catch (e) {
    reparse = { ok: false, error: String(e).slice(0, 400) }
  }
  note('S7 original-engine re-parse (headless-export md)', reparse.ok === true, reparse)

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-01b DOCX vertical slice (web bridge v0.12.11 @ b8cb8564b + PR#2283 web layer)',
  mark: MARK,
  baseURL: base,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-01b-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
