/* eslint-disable no-undef */
// VU-WB-06 PDF vertical slice through the real web bridge.
// The PDF app's real text editing: '텍스트 편집' tool → click a text block →
// textarea.pdf-textedit-input holds the block text → edit → commit (blur/Esc) →
// save (Cmd+S / autosave) → engine writes the PDF. Slice:
//   S1 mount → S2 open (tool + block click → input echo) → S3 edit →
//   S4 save (file changed) → S5 download via /api/convert (pdf→docx OOXML) →
//   S6 fresh-context reopen (input echo shows the edit) →
//   S7 original-engine re-parse (headless-export pdf→docx OOXML)
// Run: WEB_TOKEN=... node scripts/web-vu-wb-06-pdf-e2e.mjs [baseURL]
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
const file = '/tmp/web-e2e/doc.pdf'
const shotDir = '/tmp/web-e2e/shots-pdf'
mkdirSync(shotDir, { recursive: true })

const MARK = `PDF-SLICE-${Date.now()}`
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

async function activateTextEditTool(page) {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('button, [role=button], [role=tab], [class*=tool]')]
    const hits = all.filter((e) => ((e.getAttribute('data-tip') || '') + (e.getAttribute('aria-label') || '') + (e.innerText || '')).includes('페이지의 텍스트를 클릭하여 수정'))
    const b = hits.find((e) => e.getBoundingClientRect().width > 0)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
}

async function clickTitleBlock(page) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('canvas')]
      .map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
      .filter((c) => c.w > 50),
  )
  const big = boxes.sort((a, b) => b.w * b.h - a.w * a.h)[0]
  if (!big) throw new Error('no page canvas')
  await page.mouse.click(big.x + big.w * 0.5, big.y + big.h * 0.12)
  await page.waitForTimeout(1200)
}

async function blockEcho(page) {
  return page.evaluate(() => {
    const el = document.querySelector('textarea.pdf-textedit-input')
    return el && el.getClientRects().length > 0 ? el.value : null
  })
}
async function waitForBlockEcho(page, text, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await blockEcho(page)
    if (last && last.includes(text)) return { ok: true, echo: last.slice(0, 150) }
    await page.waitForTimeout(300)
  }
  return { ok: false, echo: last ? last.slice(0, 150) : null }
}

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx1.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console:${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => errors.push(`pageerror:${String(e).slice(0, 300)}`))

  await page.goto(withToken(`/pdf/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page.waitForSelector('#root', { timeout: 60000 })
  const bridge = await page.evaluate(() => ({
    hasClient: Boolean(window.__genofficeWebClient),
    canvases: document.querySelectorAll('canvas').length,
    rootChildren: document.querySelector('#root')?.children.length ?? 0,
  }))
  // canvases rasterize a beat after mount — presence is asserted in S2
  noteStep('S1 renderer mount (Chrome)', bridge.hasClient && bridge.rootChildren > 0, bridge)
  await page.waitForTimeout(3000)

  // S2: text-edit tool + title block click → input echo
  const tool = await activateTextEditTool(page)
  if (tool) await page.mouse.click(tool.x, tool.y)
  await clickTitleBlock(page)
  const echo2 = await waitForBlockEcho(page, FIXTURE)
  await page.screenshot({ path: join(shotDir, 's2-open.png') })
  const inBytes = readFileSync(file)
  noteStep('S2 pdf open (text block echo in edit input)', echo2.ok && !!tool, {
    fixture: file, size: inBytes.length, sha256: sha256(inBytes), tool, echo: echo2.echo,
  })

  // S3: edit — append the marker to the block text
  await page.keyboard.press('End')
  await page.keyboard.type(` ${MARK}`)
  await page.waitForTimeout(500)
  const typedEcho = await waitForBlockEcho(page, MARK, 5000)
  // App.tsx textarea key handler: Cmd+Enter = commitTextDraft(), Escape = cancel
  await page.keyboard.press('Meta+Enter')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(shotDir, 's3-edited.png') })
  noteStep('S3 text edit in original editor', typedEcho.ok, { mark: MARK, echo: typedEcho.echo })

  // S4: save (Cmd+S, with autosave-blur fallback) → backing file changed
  const beforeSha = sha256(inBytes)
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Meta+s')
    await new Promise((r) => setTimeout(r, 600))
    const now = readFileSync(file)
    if (sha256(now) !== beforeSha) break
    if (i === 10) await page.evaluate(() => window.dispatchEvent(new Event('blur'))) // autosave path
  }
  const afterBytes = readFileSync(file)
  noteStep('S4 save to backing file (Cmd+S/autosave)', sha256(afterBytes) !== beforeSha, {
    beforeSha256: beforeSha, afterSha256: sha256(afterBytes), afterSize: afterBytes.length,
  })

  // S5: download via /api/convert pdf→docx — engine reads the EDITED pdf (content proof)
  const savedB64 = readFileSync(file).toString('base64')
  const dl = await page.evaluate(async ({ url, b64 }) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const res = await fetch(url, { method: 'POST', body: bin })
    const disp = res.headers.get('content-disposition') ?? ''
    const buf = new Uint8Array(await res.arrayBuffer())
    let out = ''
    for (let i = 0; i < buf.length; i += 32768) out += String.fromCharCode(...buf.subarray(i, i + 32768))
    return { status: res.status, disposition: disp, len: buf.length, b64: btoa(out) }
  }, { url: withToken('/api/convert?name=doc.pdf&to=docx'), b64: savedB64 }).catch((e) => ({ error: String(e).slice(0, 200) }))
  let dlXml = { ok: false }
  if (dl.status === 200 && dl.b64) {
    const dlBytes = Buffer.from(dl.b64, 'base64')
    writeFileSync('/tmp/web-e2e/doc-download.docx', dlBytes)
    try {
      const xml = execFileSync('unzip', ['-p', '/tmp/web-e2e/doc-download.docx', 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
      dlXml = {
        ok: xml.includes(MARK) && xml.includes(FIXTURE),
        hasMark: xml.includes(MARK), hasFixture: xml.includes(FIXTURE),
        docxSha256: sha256(dlBytes), docxSize: dlBytes.length,
      }
    } catch (e) { dlXml = { ok: false, unzipError: String(e).slice(0, 150) } }
  }
  noteStep('S5 download via /api/convert (browser-side, pdf→docx, edit content)',
    dl.status === 200 && (dl.disposition ?? '').includes('attachment') && dlXml.ok === true,
    { http: { status: dl.status, disposition: dl.disposition, len: dl.len }, docx: dlXml })

  // S6: fresh-context reopen → tool + block click → input echo shows the edit
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page2 = await ctx2.newPage()
  page2.on('pageerror', (e) => errors.push(`pageerror-reopen:${String(e).slice(0, 300)}`))
  await page2.goto(withToken(`/pdf/?path=${encodeURIComponent(file)}`), {
    waitUntil: 'domcontentloaded', timeout: 30000,
  })
  await page2.waitForSelector('#root', { timeout: 60000 })
  await page2.waitForTimeout(3000)
  const tool2 = await activateTextEditTool(page2)
  if (tool2) await page2.mouse.click(tool2.x, tool2.y)
  await clickTitleBlock(page2)
  const echo6 = await waitForBlockEcho(page2, MARK)
  await page2.screenshot({ path: join(shotDir, 's6-reopen.png') })
  noteStep('S6 fresh-context reopen (edited block echo)', echo6.ok, {
    echo: echo6.echo, fixtureStillThere: (echo6.echo ?? '').includes(FIXTURE),
  })
  await ctx2.close()

  // S7: original-engine re-parse through the Node CLI convert entry (the
  // headless-export CLI takes no PDF inputs at all; convert does — and it runs
  // the same pdf→docx engine outside the browser/Electron web server)
  let reparse = { ok: false }
  try {
    const out = execFileSync(
      'node',
      ['packages/cli/dist/genoffice.cjs', 'convert', file, '--to', 'docx', '--out', '/tmp/web-e2e/doc-reparse.docx', '--force'],
      { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
    )
    let xml = ''
    if (existsSync('/tmp/web-e2e/doc-reparse.docx')) {
      xml = execFileSync('unzip', ['-p', '/tmp/web-e2e/doc-reparse.docx', 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
    }
    reparse = {
      ok: xml.includes(MARK) && xml.includes(FIXTURE),
      stdout: out.trim().slice(0, 250),
      hasMark: xml.includes(MARK), hasFixture: xml.includes(FIXTURE),
    }
  } catch (e) { reparse = { ok: false, error: String(e).slice(0, 300), stderr: String(e.stderr ?? '').slice(0, 300) } }
  noteStep('S7 original-engine re-parse (CLI convert pdf→docx, OOXML)', reparse.ok === true, reparse)

  await ctx1.close()
} finally {
  await browser.close()
}

const summary = {
  slice: 'VU-WB-06 PDF vertical slice (web bridge, text-block editing, ieumoffice v0.12.11 @ b8cb8564b)',
  mark: MARK,
  results,
  consoleOrPageErrors: errors.slice(0, 20),
  allPassed: results.every((r) => r.ok),
}
writeFileSync('/tmp/web-e2e/vu-wb-06-pdf-e2e.json', JSON.stringify(summary, null, 2))
console.log('SUMMARY', JSON.stringify({ allPassed: summary.allPassed, errors: summary.consoleOrPageErrors.length }))
process.exit(summary.allPassed ? 0 : 1)
