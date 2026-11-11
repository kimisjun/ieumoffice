/* eslint-disable no-undef */
// VU-WB-11 Shell/Home/TabBar integration preview (isolated, loopback).
// The web port's shell chrome: the launcher home (launcherHtml), app mounts
// behind the token flow, and one bridge WebSocket per browser tab. The
// desktop TabBar maps to browser tabs. Preview checks:
//   P1 home lists every app → P2 launcher navigates into an app →
//   P3 three apps mounted in parallel tabs, each with its own bridge →
//   P4 cross-tab isolation: an edit in one tab persists and the other tabs
//   stay usable. Evidence per step.
// Run: WEB_TOKEN=... node scripts/web-vu-wb-11-shell-preview.mjs [baseURL]
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:8931'
const token = process.env.WEB_TOKEN ?? ''
const shotDir = '/tmp/web-e2e/shots-shell'
mkdirSync(shotDir, { recursive: true })

const MARK = `SHELL-SLICE-${Date.now()}`
const withToken = (path) => `${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const results = []
const errors = []
const noteStep = (step, ok, detail) => {
  results.push({ step, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const home = await ctx.newPage()
  home.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 200)}`))

  // P1: the launcher lists every web app
  await home.goto(withToken('/'), { waitUntil: 'domcontentloaded', timeout: 30000 })
  await home.waitForTimeout(1500)
  const links = await home.evaluate(() =>
    [...document.querySelectorAll('a.card')].map((a) => ({
      label: a.querySelector('b')?.textContent ?? '',
      href: a.getAttribute('href') ?? '',
    })),
  )
  const expected = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'hwp', 'mindmap', 'epub', 'diagram']
  const hrefs = links.map((l) => l.href.replace(/\//g, ''))
  noteStep('P1 home launcher lists every app', expected.every((id) => hrefs.includes(id)), {
    links, missing: expected.filter((id) => !hrefs.includes(id)),
  })
  await home.screenshot({ path: join(shotDir, 'p1-home.png') })

  // P2: launcher navigates into an app (same tab; the cookie session keeps auth)
  await home.click('a.card[href="/markdown/"]')
  await home.waitForSelector('#root', { timeout: 60000 })
  await home.waitForTimeout(3000)
  const p2 = await home.evaluate(() => ({
    path: location.pathname,
    hasClient: Boolean(window.__genofficeWebClient),
    bodyHead: document.body.innerText.slice(0, 60),
  }))
  noteStep('P2 launcher navigates into an app', p2.path.startsWith('/markdown') && p2.hasClient, p2)

  // P3: three apps in PARALLEL tabs, each with its own bridge websocket
  const openers = [
    { id: 'docs', url: withToken('/docs/?path=' + encodeURIComponent('/tmp/web-e2e/report.docx')) },
    { id: 'mindmap', url: withToken('/mindmap/?new=1') },
    { id: 'diagram', url: withToken('/diagram/?path=' + encodeURIComponent('/tmp/web-e2e/diagram.drawio')) },
  ]
  const pages = {}
  for (const o of openers) {
    const p = await ctx.newPage()
    // QA 1차 P1-E: the error claim covers console errors, not just pageerror
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console-${o.id}:${m.text().slice(0, 200)}`)
    })
    p.on('pageerror', (e) => errors.push(`pageerror-${o.id}:${String(e).slice(0, 200)}`))
    await p.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await p.waitForSelector('#root', { timeout: 60000 })
    pages[o.id] = p
  }
  await new Promise((r) => setTimeout(r, 12000))
  const states = {}
  for (const [id, p] of Object.entries(pages)) {
    states[id] = await p.evaluate(() => ({
      hasClient: Boolean(window.__genofficeWebClient),
      rootChildren: document.querySelector('#root')?.children.length ?? -1,
      bodyHead: document.body.innerText.slice(0, 40).replace(/\n/g, ' '),
    }))
  }
  await pages.docs.screenshot({ path: join(shotDir, 'p3-docs.png') })
  await pages.diagram.screenshot({ path: join(shotDir, 'p3-diagram.png') })
  noteStep('P3 three apps mounted in parallel tabs',
    Object.values(states).every((s) => s.hasClient && s.rootChildren > 0), states)

  // P4 (QA 1차 P1-E): EDIT-MID-TAB isolation — two tabs of the SAME app, each
  // with its own marker edit and save; the other tab must not see it; closing
  // one leaves the other fully usable. DOM-verifiable through mindmap topics.
  const mkMark = (pfx) => `${pfx}-${Date.now()}`
  const MARK_A = mkMark('TAB-A')
  const MARK_B = mkMark('TAB-B')
  const topicTexts = (p) => p.evaluate(() => [...document.querySelectorAll('span.text')].map((e) => e.textContent))
  const addTopic = async (p, mark) => {
    await p.evaluate(() => {
      const e = [...document.querySelectorAll('span.text')].find((x) => (x.textContent || '').includes('중심'))
      const r = e.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }).then((b) => p.mouse.click(b.x, b.y))
    await p.waitForTimeout(500)
    await p.keyboard.press('Tab')
    await p.waitForTimeout(700)
    await p.keyboard.type(mark)
    await p.keyboard.press('Enter')
    await p.waitForTimeout(700)
  }

  // QA 3차 P1-E: each tab saves to its OWN file and the sibling file stays
  // byte-invariant — edit-mid-tab isolation is proven on disk, not just in
  // the live DOM
  const saveViaDialog = async (page, fileName) => {
    await page.keyboard.press('Meta+s')
    await page.waitForTimeout(1500)
    const savedAt = await page.evaluate((fallbackName) => {
      const host = document.getElementById('genoffice-web-dialog')
      if (!host) return null
      const crumbs = host.querySelector('[data-role=crumbs]')
      const cwd = (crumbs?.textContent ?? '').trim().replace(/\/$/, '')
      return cwd ? `${cwd}/${fallbackName}` : `/tmp/web-e2e/${fallbackName}`
    }, fileName)
    if (!savedAt) return null
    await page.evaluate((name) => {
      const host = document.getElementById('genoffice-web-dialog')
      const nameInput = host.querySelector('[data-role=name]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(nameInput, name)
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    }, fileName)
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      document.getElementById('genoffice-web-dialog')?.querySelector('[data-role=ok]')?.click()
    })
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 500))
      if (existsSync(savedAt)) return savedAt
    }
    return null
  }
  const engineTitles = (file) => {
    try {
      const out = execFileSync('npx', ['tsx', 'scripts/engine-parse-vu.ts', 'xmind', file, 'MARK'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
      })
      return JSON.parse(out.trim().split('\n').pop() ?? '{}')
    } catch (e) { return { status: 'error', detail: String(e).slice(0, 150) } }
  }

  // two more tabs of the SAME app (mindmap)
  const mmTabs = {}
  for (const [key, mark] of [['a', MARK_A], ['b', MARK_B]]) {
    const p = await ctx.newPage()
    p.on('pageerror', (e) => { errors.push(`pageerror-mm${key}:${String(e).slice(0, 200)}`) })
    await p.goto(withToken('/mindmap/?new=1'), { waitUntil: 'domcontentloaded', timeout: 30000 })
    await p.waitForSelector('#root', { timeout: 60000 })
    await p.waitForTimeout(6000)
    await addTopic(p, mark)
    mmTabs[key] = p
  }
  const ta = await topicTexts(mmTabs.a)
  const tb = await topicTexts(mmTabs.b)
  const isolated =
    ta.some((t) => t.includes(MARK_A)) && !ta.some((t) => t.includes(MARK_B)) &&
    tb.some((t) => t.includes(MARK_B)) && !tb.some((t) => t.includes(MARK_A))
  noteStep('P4a same-app parallel tabs, per-tab edits stay isolated (machine echo)',
    isolated, { tabA: ta.slice(0, 4), tabB: tb.slice(0, 4), MARK_A, MARK_B })

  // P4a2 (QA 3차 P1-E): each tab saves to its OWN file; the sibling file is
  // byte-invariant across the other tab's later edit
  const fileA = await saveViaDialog(mmTabs.a, 'p4a-tab-a.xmind')
  const fileB = await saveViaDialog(mmTabs.b, 'p4a-tab-b.xmind')
  const parsedA = fileA ? engineTitles(fileA) : { status: 'no-file' }
  const parsedB = fileB ? engineTitles(fileB) : { status: 'no-file' }
  const bHashBefore = fileB ? sha256(readFileSync(fileB)) : null
  const MARK_A2 = mkMark('TAB-A2')
  await addTopic(mmTabs.a, MARK_A2)
  await saveViaDialog(mmTabs.a, 'p4a-tab-a.xmind')
  const bHashAfter = fileB && existsSync(fileB) ? sha256(readFileSync(fileB)) : null
  const titlesA = JSON.stringify(parsedA)
  const titlesB = JSON.stringify(parsedB)
  const filesOk =
    Boolean(fileA && fileB) &&
    titlesA.includes(MARK_A) && !titlesA.includes(MARK_B) &&
    titlesB.includes(MARK_B) && !titlesB.includes(MARK_A) &&
    bHashBefore !== null && bHashBefore === bHashAfter
  noteStep('P4a2 two saved files, sibling file byte-invariant (P1-E)', filesOk, {
    fileA, fileB, parsedA, parsedB,
    siblingHashBefore: bHashBefore, siblingHashAfter: bHashAfter,
    siblingUnchanged: bHashBefore !== null && bHashBefore === bHashAfter,
  })

  // close tab A; tab B must remain fully usable (another edit lands)
  await mmTabs.a.close()
  const MARK_B2 = mkMark('TAB-B2')
  await addTopic(mmTabs.b, MARK_B2)
  const tb2 = await topicTexts(mmTabs.b)
  const bAlive = tb2.some((t) => t.includes(MARK_B2)) && tb2.some((t) => t.includes(MARK_B))
  noteStep('P4b after closing one tab the other stays fully usable', bAlive, {
    topicsAfterClose: tb2.slice(0, 5),
  })

  // the other apps' tabs were not disturbed
  const docEcho = (await pages.docs.evaluate(() => document.body.innerText)).includes('fixture')
  const dMounted = await pages.diagram.evaluate(() => Boolean(window.__genofficeWebClient))
  noteStep('P4c other app tabs undisturbed', docEcho && dMounted, {
    docsText: docEcho, diagramMounted: dMounted,
  })

  for (const p of [...Object.values(pages), mmTabs.b]) await p.close()
  await home.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-11 Shell/Home/TabBar integration preview (isolated loopback, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-11-shell-preview.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
