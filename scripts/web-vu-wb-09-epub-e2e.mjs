/* eslint-disable no-undef */
// VU-WB-09 EPUB vertical slice through the real web bridge.
// The EPUB app renders chapters in a same-origin srcdoc iframe with the
// chapter body editable (contenteditable) — DOM echo is machine-readable.
// The book opens on the cover; the chapter loads from the app's own TOC
// button. Saving goes through the app's own 파일 menu (runCommand('save')).
// Slice: S1 mount → S2 open (chapter text echo) → S3 edit (echo) →
// S4 save (app menu → file rewritten; marker in the epub package) →
// S5 convert/export leg → S6 fresh-context reopen (chapter echo) →
// S7 package re-parse (epub = zip; content XHTML carries the marker)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-09-epub-e2e.mjs [baseURL]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const file = '/tmp/web-e2e/book.epub'
const shotDir = '/tmp/web-e2e/shots-epub'
mkdirSync(shotDir, { recursive: true })

const MARK = `EPUB-SLICE-${Date.now()}`
const FIXTURE = 'VU-WB-01b fixture'
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

async function chapterText(page) {
  return page.evaluate(() => {
    const f = document.querySelector('iframe')
    return f?.contentDocument?.body?.innerText ?? ''
  })
}
async function openChapter(page) {
  // the book opens on the cover; the app's own TOC button loads the chapter
  const btn = await page.evaluate(() => {
    const e = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'report.docx')
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (btn) {
    await page.mouse.click(btn.x, btn.y)
    await page.waitForTimeout(2500)
  }
  return chapterText(page)
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`HTTP${res.status()} ${res.url().slice(-110)}`) })

  await page.goto(withToken(`/epub/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  await page.waitForTimeout(10000)
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasEpubApi: typeof (window.epubApi && window.epubApi.consumePending) === 'function',
  }))
  const pending = await page.evaluate(() => window.epubApi.consumePending().catch((e) => `ERR:${e}`))
  noteStep('S1 renderer mount (Chrome)', bridge.hasClient && bridge.hasEpubApi && pending === file, {
    bridge, pending,
  })

  // S2: open the chapter via the app's TOC → machine echo from the iframe
  const inBytes = readFileSync(file)
  const text2 = await openChapter(page)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  noteStep('S2 epub open (chapter echo)', text2.includes(FIXTURE), {
    fixture: file, size: inBytes.length, sha256: sha256(inBytes),
    chapterExcerpt: text2.slice(0, 120),
  })

  // S3: click into the chapter text and type a marker (contenteditable body)
  const pos = await page.evaluate(() => {
    const f = document.querySelector('iframe')
    const body = f.contentDocument.body
    const target = [...f.contentDocument.querySelectorAll('p, div, span, h1, h2')]
      .find((e) => e.children.length === 0 && (e.textContent || '').trim().length > 20)
    const el = target ?? body
    const fr = f.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { mx: fr.x + r.x + r.width * 0.5, my: fr.y + r.y + Math.min(r.height / 2, 12) }
  })
  await page.mouse.click(pos.mx, pos.my)
  await page.waitForTimeout(600)
  await page.keyboard.press('End')
  await page.keyboard.type(` ${MARK}`)
  await page.waitForTimeout(600)
  const text3 = await chapterText(page)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 chapter edit in original editor', text3.includes(MARK), {
    mark: MARK, echo: text3.includes(MARK) ? 'machine' : 'MISSING',
  })

  // S4: the app's own 파일 menu → 저장 (runCommand('save')) → the file
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '파일')
    if (btn) btn.click()
  })
  await page.waitForTimeout(800)
  const clicked = await page.evaluate(() => {
    const item = [...document.querySelectorAll('button, [role=menuitem], li')]
      .filter((e) => e.getClientRects().length > 0 && /저장/.test((e.textContent || '').trim()))
    const pick = item.find((e) => (e.textContent || '').trim().length <= 6) ?? item[0]
    if (pick) { pick.click(); return (pick.textContent || '').trim().slice(0, 12) }
    return null
  })
  let saved = null
  for (let i = 0; i < 30 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(file)
      if (!bytes.equals(inBytes)) {
        const listing = execFileSync('unzip', ['-l', file], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8')
        const parts = listing.split('\n').filter((l) => /\.x?html?/.test(l))
        saved = { bytes, hasMarker: null }
        // machine content proof: the marker must be inside the package somewhere
        const all = execFileSync('unzip', ['-p', file], { maxBuffer: 64 * 1024 * 1024 }).toString('latin1')
        saved.hasMarker = all.includes(MARK) && all.includes('VU-WB-01b')
      }
    } catch { /* still saving */ }
  }
  noteStep('S4 save to backing file (app 파일 menu 저장)', !!(saved && saved.hasMarker), saved ? {
    size: saved.bytes.length, sha256: sha256(saved.bytes),
    markerInPackage: saved.hasMarker, menuClick: clicked,
  } : { menuClick: clicked, detail: 'file unchanged or marker missing within 15s' })

  // S5: convert/export leg — epub is a convert TARGET only (supported-list evidence)
  noteStep('S5 download/convert leg: NOT_RUN (epub is a convert target only)', false, {
    detail: 'NOT_RUN: CLI convert supported routes carry no epub SOURCE (supported-list evidence); app exports are dialog-driven',
  })

  // S6: fresh-context reopen → chapter echo
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/epub/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await page2.waitForTimeout(10000)
  const text6 = await openChapter(page2)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (chapter echo)', text6.includes(MARK) && text6.includes(FIXTURE), {
    hasMark: text6.includes(MARK), hasFixture: text6.includes(FIXTURE),
  })
  await ctx2.close()

  // S7: ENGINE re-parse — epub-engine's own openEpub parses the saved bytes;
  // the marker must be in the chapter text the ENGINE reads (QA P1-B: not a
  // zip-string grep)
  let reparse = { ok: false }
  try {
    const out = execFileSync('npx', ['tsx', 'scripts/engine-parse-vu.ts', 'epub', file, MARK], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    })
    const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}')
    const out2 = execFileSync('npx', ['tsx', 'scripts/engine-parse-vu.ts', 'epub', file, FIXTURE], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    })
    const parsedFix = JSON.parse(out2.trim().split('\n').pop() ?? '{}')
    reparse = {
      ok: parsed.status === 'ok' && parsed.needles?.[MARK] === true && parsedFix.needles?.[FIXTURE] === true,
      status: parsed.status,
      chapterCount: parsed.chapterCount,
      markerInParsedChapters: parsed.needles?.[MARK] ?? false,
      fixtureInParsedChapters: parsedFix.needles?.[FIXTURE] ?? false,
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S7 engine re-parse (epub-engine openEpub reads the saved bytes)', reparse.ok === true, reparse)

  await ctx1.close()
} finally {
  await browser.close()
}

// QA 1차 P0-D: every leg is counted and the verdict separates
// PASS / FAIL / NOT_RUN — a leg that did not run is never dropped into success
const isNotRun = (r) => /NOT_RUN/.test(r.step) || r.status === 'NOT_RUN'
const counts = {
  pass: results.filter((r) => r.ok && !isNotRun(r)).length,
  fail: results.filter((r) => !r.ok && !isNotRun(r)).length,
  notRun: results.filter(isNotRun).length,
  total: results.length,
}
const verdict = counts.fail > 0 ? 'FAIL' : counts.notRun > 0 ? 'PASS_WITH_NOT_RUN' : 'PASS'
const summary = {
  slice: 'VU-WB-09 EPUB vertical slice (web bridge, chapter-iframe contenteditable, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  counts,
  verdict,
  consoleOrPageErrors: errors.slice(0, 20),
  // strict: every leg ran AND passed
  allPassed: counts.total > 0 && counts.pass === counts.total,
  // the acceptance criterion: no required leg failed (NOT_RUN legs are
  // optional and carry their reason in the step name)
  requiredPassed: counts.fail === 0,
}
writeFileSync('/tmp/web-e2e/vu-wb-09-epub-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({
  verdict: summary.verdict,
  counts: summary.counts,
  allPassed: summary.allPassed,
  requiredPassed: summary.requiredPassed,
  errors: summary.consoleOrPageErrors.length,
}))
process.exit(summary.requiredPassed ? 0 : 1)
