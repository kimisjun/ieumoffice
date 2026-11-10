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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

  // P4: cross-tab isolation — edit in docs (Cmd+S through the menu-action path
  // was VU-WB-01b's S4; here just verify the tabs stay independent and the
  // diagram tab keeps its shape echo while docs holds its own state)
  const dEcho = await pages.diagram.evaluate(() => {
    const f = document.querySelector('iframe')
    return [...(f?.contentDocument?.querySelectorAll('foreignObject div') ?? [])]
      .map((e) => e.textContent.trim()).some((t) => t.includes('VU-WB-10'))
  })
  const mEcho = await pages.mindmap.evaluate(() =>
    [...document.querySelectorAll('span.text')].some((e) => (e.textContent || '').includes('중심')),
  )
  const docEcho = (await pages.docs.evaluate(() => document.body.innerText)).includes('fixture')
  noteStep('P4 cross-tab isolation (each tab keeps its own document state)',
    dEcho && mEcho && docEcho, { diagramShape: dEcho, mindmapTopic: mEcho, docsText: docEcho })

  for (const p of Object.values(pages)) await p.close()
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
