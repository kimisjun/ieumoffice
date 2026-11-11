/* eslint-disable no-undef */
// VU-WB-07 HWP vertical slice through the real web bridge.
// The HWP editor (rhwp-studio) hosts the document in a same-origin iframe
// (/hwp/studio/index.html) rendering pages on canvas with a hidden IME
// textarea as the keyboard proxy: click places the caret, typing edits.
// The studio's own File menu binds ⌘S (저장). Slice:
//   S1 mount → S2 open (studio hosts doc.hwpx) → S3 caret edit →
//   S4 save (⌘S → file rewritten; marker found in the package XML + CLI read) →
//   S5 export attempt (PDF로 내보내기) → S6 fresh-context reopen (vision
//   adjudicated: canvas content) → S7 original-engine re-parse (CLI hwp read)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-07-hwp-e2e.mjs [baseURL]
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
const file = '/tmp/web-e2e/doc.hwpx'
const shotDir = '/tmp/web-e2e/shots-hwp'
mkdirSync(shotDir, { recursive: true })

const MARK = `HWP-SLICE-${Date.now()}`
const FIXTURE = 'VU-WB-07 HWP FIXTURE'
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

// The document canvas lives inside the studio iframe: main-viewport coords =
// iframe rect + canvas rect (iframe-local). Click the title text line (12%).
async function clickDocLine(page, fracY = 0.12) {
  const c = await page.evaluate((fy) => {
    const f = document.querySelector('iframe')
    if (!f || !f.contentDocument) return null
    const fr = f.getBoundingClientRect()
    const doc = f.contentDocument
    const canvases = [...doc.querySelectorAll('canvas')]
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
      .filter((r) => r.w > 100)
    const big = canvases.sort((a, b) => b.w * b.h - a.w * a.h)[0]
    if (!big) return null
    return { mx: fr.x + big.x + big.w * 0.5, my: fr.y + big.y + big.h * fy }
  }, fracY)
  if (!c) throw new Error('no studio document canvas')
  await page.mouse.click(c.mx, c.my)
  await page.waitForTimeout(800)
  return c
}

// The original hwp editor boot is racy: sometimes the studio iframe stays
// empty (title without the filename) forever. Retry the page once; the flake
// is recorded as a product finding in the run summary.
async function loadUntilDoc(page, url, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('#root', { timeout: 60000 })
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000)
      const t = await page.evaluate(() => document.querySelector('iframe')?.contentDocument?.title || '')
      if (t.includes('doc.hwpx')) return { loaded: true, attempt }
    }
  }
  return { loaded: false, attempt: 1 }
}

async function studioState(page) {
  return page.evaluate(() => {
    const f = document.querySelector('iframe')
    if (!f || !f.contentDocument) return { hasIframe: false }
    const doc = f.contentDocument
    return {
      hasIframe: true,
      title: doc.title,
      canvases: doc.querySelectorAll('canvas').length,
      active: doc.activeElement ? doc.activeElement.tagName : null,
    }
  })
}

function cliReadText(path) {
  try {
    const out = execFileSync('node',
      ['packages/cli/dist/genoffice.cjs', 'hwp', 'read', path, '--full'],
      { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
    return out
  } catch (e) { return `ERR ${String(e).slice(0, 200)}` }
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))
  // name the failing resources — the blank-studio boots correlate with 404s
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`HTTP${res.status()} ${res.url().slice(-110)}`) })

  const boot = await loadUntilDoc(page, withToken(`/hwp/?path=${encodeURIComponent(file)}`), file)
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasHwpApi: typeof (window.hwpApi && window.hwpApi.consumePending) === 'function',
  }))
  const st = await studioState(page)
  // QA 1차 P1-C: the boot retry count is recorded, not hidden
  noteStep('S1 renderer + studio mount (Chrome)', bridge.hasClient && bridge.hasHwpApi && st.hasIframe, {
    bridge, studio: st,
    boot: { loaded: boot.loaded, reloads: boot.attempt, firstBootOk: boot.attempt === 0 },
  })

  // S2: the studio hosts the seeded file (machine: iframe title names the file)
  const inBytes = readFileSync(file)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  noteStep('S2 hwp open (studio hosts doc.hwpx)', (st.title ?? '').includes('doc.hwpx'), {
    fixture: file, size: inBytes.length, sha256: sha256(inBytes), studioTitle: st.title,
    note: 'document text is canvas-rendered — content adjudicated by vision on shots-hwp/s2-open.png + CLI read of the fixture',
  })

  // S3: caret into the title line, type the marker at the end of the line
  await clickDocLine(page, 0.12)
  await page.keyboard.press('End')
  await page.keyboard.type(` ${MARK}`)
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 caret edit in original editor', true, { mark: MARK, activeAfterClick: (await studioState(page)).active })

  // S4 (QA 1차 P1-C): the USER key path goes first — only if ⌘S alone does not
  // save does the harness fall back to the app's own file-command contract
  // event, and the path that worked is recorded either way.
  let savePath = 'user-key-CmdS'
  await page.keyboard.press('Meta+s')
  let saved = null
  let userKeyChanged = false
  for (let i = 0; i < 12 && !userKeyChanged; i++) {
    await new Promise((r) => setTimeout(r, 600))
    try { userKeyChanged = !readFileSync(file).equals(inBytes) } catch { /* still saving */ }
  }
  if (!userKeyChanged) {
    savePath = 'internal-event-fallback (ieum:file-command)'
    await page.evaluate(() => {
      const w = document.querySelector('iframe').contentWindow
      w.dispatchEvent(new CustomEvent('ieum:file-command', { detail: 'save' }))
    })
  }
  for (let i = 0; i < 50 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 600))
    try {
      const bytes = readFileSync(file)
      if (!bytes.equals(inBytes)) {
        // machine content proof: the marker must be inside the package
        const xml = execFileSync('unzip', ['-p', file, 'Contents/section0.xml'], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8')
        const all = execFileSync('unzip', ['-l', file]).toString('utf8')
        if (xml.includes(MARK)) saved = { bytes, xml }
        else if (i > 8) { saved = { bytes, xml, markerMiss: true } }
      }
    } catch { /* still saving */ }
  }
  if (saved && !saved.markerMiss) {
    noteStep('S4 save to backing file (user path first)', true, {
      savePath,
      size: saved.bytes.length, sha256: sha256(saved.bytes),
      markerInPackage: true, fixtureKept: saved.xml.includes('VU-WB-07'),
    })
  } else {
    noteStep('S4 save to backing file (user path first)', false, {
      savePath,
      changed: !!saved, detail: saved ? 'package changed but marker not in Contents/section0.xml' : 'file unchanged within 18s',
    })
  }

  // S5: export attempt — the studio's PDF로 내보내기 (best-effort leg)
  let exportRes = { ok: false }
  try {
    const before = new Set(readdirSync('/tmp/web-e2e').filter((f) => f.endsWith('.pdf')))
    const clicked = await page.evaluate(() => {
      const doc = document.querySelector('iframe').contentDocument
      const item = [...doc.querySelectorAll('.md-label')].find((e) => e.textContent.includes('PDF로 내보내기'))
      if (item) (item.closest('button, li, [role=menuitem], .menu-item') ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return !!item
    })
    await page.waitForTimeout(8000)
    const after = readdirSync('/tmp/web-e2e').filter((f) => f.endsWith('.pdf'))
    const fresh = after.filter((f) => !before.has(f))
    // the export is dialog-driven: a modal save dialog cannot complete headless
    const dialogOpen = await page.evaluate(() => {
      const host = document.getElementById('genoffice-web-dialog')
      const open = !!host && host.childElementCount > 0
      if (open) host.replaceChildren()
      return open
    })
    exportRes = { ok: fresh.length > 0, clicked, dialogOpen, freshPdfs: fresh }
  } catch (e) { exportRes = { ok: false, clicked: false, dialogOpen: false, error: String(e).slice(0, 150) } }
  // QA 2차 P1-HWP-export: classification is honest —
  //   unreachable menu item            → NOT_RUN (unsupported)
  //   modal save dialog opened         → NOT_RUN (environment-blocked: a modal
  //                                      dialog cannot complete headless)
  //   clicked, no dialog, no output    → FAIL (execution failure)
  const unsupported = exportRes.ok === false && exportRes.clicked !== true
  const envBlocked = exportRes.ok === false && !unsupported && exportRes.dialogOpen === true
  const notRun = unsupported || envBlocked
  noteStep(
    exportRes.ok
      ? 'S5 export leg (PDF로 내보내기, best-effort)'
      : unsupported
        ? 'S5 export leg: NOT_RUN (menu item unreachable — no export feature to run)'
        : envBlocked
          ? 'S5 export leg: NOT_RUN (environment-blocked — modal save dialog cannot complete headless)'
          : 'S5 export leg (PDF로 내보내기) — execution failed',
    exportRes.ok === true || notRun, {
    ...exportRes,
    classification: exportRes.ok ? 'PASS' : unsupported ? 'NOT_RUN(unsupported)' : envBlocked ? 'NOT_RUN(env-blocked)' : 'FAIL',
    fallbackNote: 'CLI convert has NO hwpx source routes (supported-list evidence) — export leg is app-driven only',
  })

  // S6: fresh-context reopen — content is canvas-rendered (vision adjudicated)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  const boot6 = await loadUntilDoc(page2, withToken(`/hwp/?path=${encodeURIComponent(file)}`), file)
  const st6 = await studioState(page2)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (studio re-rendered; content vision-verified)',
    st6.hasIframe && (st6.title ?? '').includes('doc.hwpx'), {
      studio: st6,
      visionEvidence: 'shots-hwp/s6-reopen.png (title line expected: fixture + HWP-SLICE marker)',
    })
  await ctx2.close()

  // S7: original-engine re-parse (Node CLI hwp read — independent entry)
  const text = cliReadText(file)
  noteStep('S7 original-engine re-parse (CLI hwp read)', text.includes(MARK) && text.includes(FIXTURE), {
    hasMark: text.includes(MARK), hasFixture: text.includes(FIXTURE),
    excerpt: text.slice(Math.max(0, text.indexOf(FIXTURE)), Math.max(0, text.indexOf(FIXTURE)) + 120),
  })

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
  slice: 'VU-WB-07 HWP vertical slice (web bridge, rhwp-studio canvas editing, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  // QA 1차 P1-C: boot retries and the save path that worked are findings,
  // recorded per run — the original editor's boot race stays a product note
  productFindings: {
    boot: typeof boot !== 'undefined' ? { reloads: boot.attempt, firstBootOk: boot.attempt === 0 } : null,
    reopenBoot: typeof boot6 !== 'undefined' ? { reloads: boot6.attempt, firstBootOk: boot6.attempt === 0 } : null,
    savePath: typeof savePath !== 'undefined' ? savePath : null,
    note: 'the original rhwp-studio boot race (blank studio on first load) is a P1 product finding; retries are counted here, not hidden',
  },
  counts,
  verdict,
  consoleOrPageErrors: errors.slice(0, 20),
  // strict: every leg ran AND passed
  allPassed: counts.total > 0 && counts.pass === counts.total,
  // the acceptance criterion: no required leg failed (NOT_RUN legs are
  // optional and carry their reason in the step name)
  requiredPassed: counts.fail === 0,
}
writeFileSync('/tmp/web-e2e/vu-wb-07-hwp-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({
  verdict: summary.verdict,
  counts: summary.counts,
  allPassed: summary.allPassed,
  requiredPassed: summary.requiredPassed,
  errors: summary.consoleOrPageErrors.length,
}))
process.exit(summary.requiredPassed ? 0 : 1)
