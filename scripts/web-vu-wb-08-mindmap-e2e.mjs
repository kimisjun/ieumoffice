/* eslint-disable no-undef */
// VU-WB-08 Mindmap vertical slice through the real web bridge — v2 (QA 1차
// 재심용, P1-B 반영). The round-trip now STARTS from an existing file:
//   S0 fixture setup (app saves fixture.xmind — engine-made through the app)
//   S1 mount → S2 OPEN the fixture (existing-file open + topic echo) →
//   S3 topic edit (child of the fixture topic; machine echo) →
//   S4 in-place save (Cmd+S on a path-backed map; marker in the package) →
//   S5 export/convert leg →
//   S6 fresh-context reopen (topic echo) →
//   S7 ENGINE re-parse: xmind-engine's own openXmind parses the saved bytes
//   and the parsed topic tree must carry the marker and fixture labels
//   (QA P1-B: not a zip-string grep)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-08-mindmap-e2e.mjs [baseURL]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const fixturePath = '/tmp/web-e2e/mm-fixture.xmind'
const shotDir = '/tmp/web-e2e/shots-mm'
mkdirSync(shotDir, { recursive: true })

const MARK = `MM-SLICE-${Date.now()}`
const FIXTURE = `VU-WB-08 FIXTURE ${Date.now()}`
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

async function topicTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('span.text')].map((e) => e.textContent))
}
async function waitForTopic(page, text, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await topicTexts(page)
    if (last.some((v) => String(v).includes(text))) return { ok: true, topics: last }
    await page.waitForTimeout(300)
  }
  return { ok: false, topics: last }
}

async function clickTopic(page, label) {
  const box = await page.evaluate((l) => {
    const e = [...document.querySelectorAll('span.text')].find((x) => (x.textContent || '').includes(l))
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, label)
  if (!box) throw new Error(`topic not found: ${label}`)
  await page.mouse.click(box.x, box.y)
  await page.waitForTimeout(500)
}

/** the untitled map's save: Cmd+S opens the shim dialog (directory + name box) */
async function saveViaDialog(page, fileName) {
  await page.keyboard.press('Meta+s')
  await page.waitForTimeout(1500)
  const dlg = await page.evaluate(() => {
    const host = document.getElementById('genoffice-web-dialog')
    if (!host) return { open: false }
    const inputs = [...host.querySelectorAll('input')].map((e) => ({ cls: e.className, val: e.value }))
    const buttons = [...host.querySelectorAll('button')].map((e) => e.textContent.trim())
    return { open: true, inputs, buttons }
  })
  if (!dlg.open) return { savedAt: null, bytes: null, dialog: dlg }
  const savedAt = await page.evaluate((fallbackName) => {
    const host = document.getElementById('genoffice-web-dialog')
    const crumbs = host.querySelector('[data-role=crumbs]')
    const cwd = (crumbs?.textContent ?? '').trim().replace(/\/$/, '')
    return cwd ? `${cwd}/${fallbackName}` : `/tmp/web-e2e/${fallbackName}`
  }, fileName)
  await page.evaluate((name) => {
    const host = document.getElementById('genoffice-web-dialog')
    const nameInput = host.querySelector('[data-role=name]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, name)
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  }, fileName)
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    const host = document.getElementById('genoffice-web-dialog')
    host.querySelector('[data-role=ok]')?.click()
  })
  let bytes = null
  for (let i = 0; i < 30 && !bytes; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (existsSync(savedAt)) bytes = readFileSync(savedAt)
  }
  return { savedAt, bytes, dialog: dlg }
}

const engineParse = (file, needle) => {
  const out = execFileSync('npx', ['tsx', 'scripts/engine-parse-vu.ts', 'xmind', file, needle], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  })
  return JSON.parse(out.trim().split('\n').pop() ?? '{}')
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  // ---- S0: fixture setup — the app itself saves an existing map file ----
  const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page0 = await ctx0.newPage()
  page0.on('pageerror', (e) => { errors.push(`pageerror-s0:${String(e).slice(0, 300)}`) })
  await page0.goto(withToken('/mindmap/?new=1'), { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page0.waitForSelector('#root', { timeout: 60000 })
  await page0.waitForTimeout(8000)
  await clickTopic(page0, '중심')
  await page0.keyboard.press('Tab')
  await page0.waitForTimeout(700)
  await page0.keyboard.type(FIXTURE)
  await page0.keyboard.press('Enter')
  const fixEcho = await waitForTopic(page0, FIXTURE)
  try { rmSync(fixturePath) } catch { /* first run */ }
  const made = await saveViaDialog(page0, 'mm-fixture.xmind')
  // the dialog saves under its own cwd — pin the fixture to the deterministic
  // path the round-trip opens
  if (made.bytes && made.savedAt !== fixturePath) {
    copyFileSync(made.savedAt, fixturePath)
    made.savedAt = fixturePath
  }
  noteStep('S0 fixture setup (app saves an existing map file)',
    fixEcho.ok && !!made.bytes, {
      fixture: FIXTURE, fixturePath: made.savedAt,
      size: made.bytes?.length ?? 0, sha256: made.bytes ? sha256(made.bytes) : null,
    })
  await ctx0.close()

  const fixtureBytes = made.bytes ?? Buffer.alloc(0)

  // ---- S1+S2: mount and OPEN the existing fixture ----
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => { errors.push(`pageerror:${String(e).slice(0, 300)}`) })
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`HTTP${res.status()} ${res.url().slice(-110)}`) })

  await page.goto(withToken(`/mindmap/?path=${encodeURIComponent(fixturePath)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  await page.waitForTimeout(8000)
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    hasMindmapApi: typeof (window.mindmapApi && window.mindmapApi.consumePending) === 'function',
  }))
  noteStep('S1 renderer mount (Chrome)', bridge.hasClient && bridge.hasMindmapApi, bridge)

  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  const openEcho = await waitForTopic(page, FIXTURE)
  noteStep('S2 OPEN existing fixture (topic echo)', openEcho.ok, {
    fixture: FIXTURE, topics: openEcho.topics.slice(0, 4),
  })

  // S3: click the fixture topic → Tab adds a child (title edit) → type → Enter
  await clickTopic(page, FIXTURE)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(700)
  await page.keyboard.type(MARK)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  const echo3 = await waitForTopic(page, MARK)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 topic edit in original editor', echo3.ok, { mark: MARK, topics: echo3.topics })

  // S4: Cmd+S on a path-backed map saves in place (no dialog)
  await page.keyboard.press('Meta+s')
  let saved = null
  for (let i = 0; i < 30 && !saved; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const bytes = readFileSync(fixturePath)
      if (!bytes.equals(fixtureBytes)) saved = bytes
    } catch { /* saving */ }
  }
  noteStep('S4 in-place save (Cmd+S on a path-backed map)',
    !!(saved && sha256(saved) !== sha256(fixtureBytes)), saved ? {
      path: fixturePath, size: saved.length, sha256: sha256(saved),
    } : { detail: 'file unchanged within 15s' })

  // S5: export/convert leg — CLI has no xmind source route
  noteStep('S5 download/convert leg: NOT_RUN (CLI has no xmind source route)', false, {
    detail: 'NOT_RUN: CLI convert supported routes carry no xmind source (supported-list evidence); app exports are dialog-driven',
  })

  // S6: fresh-context reopen → topic echo (marker AND fixture)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => { errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`) })
  await page2.goto(withToken(`/mindmap/?path=${encodeURIComponent(fixturePath)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await page2.waitForTimeout(8000)
  const echo6 = await waitForTopic(page2, MARK)
  const echo6b = await waitForTopic(page2, FIXTURE)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (marker + fixture echo)', echo6.ok && echo6b.ok, {
    topics: echo6.topics.slice(0, 6), markKept: echo6.ok, fixtureKept: echo6b.ok,
  })
  await ctx2.close()

  // S7: ENGINE re-parse — xmind-engine's own openXmind (QA P1-B)
  let reparse = { ok: false }
  try {
    const parsed = engineParse(fixturePath, MARK)
    const parsedFix = engineParse(fixturePath, FIXTURE)
    reparse = {
      ok: parsed.status === 'ok' && parsed.needles?.[MARK] === true && parsedFix.needles?.[FIXTURE] === true,
      status: parsed.status,
      titles: parsed.titles?.slice(0, 6),
      markerInParsedTree: parsed.needles?.[MARK] ?? false,
      fixtureInParsedTree: parsedFix.needles?.[FIXTURE] ?? false,
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 250) } }
  noteStep('S7 engine re-parse (xmind-engine openXmind parses the saved bytes)', reparse.ok === true, reparse)

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
  slice: 'VU-WB-08 Mindmap vertical slice v2 (web bridge, Mind Elixir DOM editing, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  fixture: FIXTURE,
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
writeFileSync('/tmp/web-e2e/vu-wb-08-mm-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({
  verdict: summary.verdict,
  counts: summary.counts,
  allPassed: summary.allPassed,
  requiredPassed: summary.requiredPassed,
  errors: summary.consoleOrPageErrors.length,
}))
process.exit(summary.requiredPassed ? 0 : 1)
