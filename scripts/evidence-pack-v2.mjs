/* eslint-disable no-undef */
// Evidence v2 packaging (QA 1차 재심용) — collects every harness JSON plus
// screenshots and binds the BUILD PROVENANCE into the manifest (QA P2:
// "manifest는 실행한 renderer/main/CLI 번들이 어느 SHA에서 만들어졌는지를
// 직접 결속하지 않는다"). The manifest now records the git commit and the
// SHA-256 of every executed bundle alongside the run artifacts.
//
// Run: node scripts/evidence-pack-v2.mjs [outDir]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv[2] ?? join(root, '..', 'asan-portal-kanban-operations', 'vu-wb-recheck-evidence-20261111')
mkdirSync(join(outDir, 'shots'), { recursive: true })

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()
const gitLog = execFileSync('git', ['log', '--oneline', '-4'], { cwd: root }).toString().trim()

/** every executed bundle: the CLI dist, the web bundle dir, app out/ mains */
const bundles = []
const addBundle = (p) => {
  if (!existsSync(p)) return
  const st = statSync(p)
  if (st.isFile()) bundles.push({ path: relative(root, p), size: st.size, sha256: sha256(readFileSync(p)) })
}
addBundle(join(root, 'packages/cli/dist/genoffice.cjs'))
const webDir = join(root, 'apps/shell/resources/web')
if (existsSync(webDir)) {
  for (const f of readdirSync(webDir)) addBundle(join(webDir, f))
}
for (const app of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'hwp', 'mindmap', 'epub', 'diagram', 'shell']) {
  const outMain = join(root, 'apps', app, 'out', 'main', 'index.js')
  addBundle(outMain)
}

const runs = [
  'vu-wb-01b-e2e', 'vu-wb-02-md-e2e', 'vu-wb-03-xlsx-e2e', 'vu-wb-03-xlsx-e2e-resolved',
  'vu-wb-04-slides-e2e', 'vu-wb-04-slides-e2e-resolved',
  'vu-wb-05-html-e2e', 'vu-wb-06-pdf-e2e',
  'vu-wb-07-hwp-e2e', 'vu-wb-08-mm-e2e', 'vu-wb-09-epub-e2e',
  'vu-wb-10-diagram-e2e', 'vu-wb-11-shell-preview', 'vu-wb-11-shell-preview-e2e',
]
const results = {}
for (const name of runs) {
  const p = `/tmp/web-e2e/${name}.json`
  if (!existsSync(p)) {
    results[name] = { missing: true }
    continue
  }
  const d = JSON.parse(readFileSync(p, 'utf8'))
  copyFileSync(p, join(outDir, `${name}.json`))
  results[name] = {
    verdict: d.verdict ?? null,
    counts: d.counts ?? null,
    allPassed: d.allPassed ?? null,
    requiredPassed: d.requiredPassed ?? null,
    errors: (d.consoleOrPageErrors ?? []).length,
    sha256: sha256(readFileSync(p)),
  }
}
for (const dir of ['shots-xlsx', 'shots-slides', 'shots-diagram', 'shots-mm', 'shots-epub', 'shots-hwp', 'shots-docs', 'shots-md', 'shots-html', 'shots-pdf']) {
  const src = join('/tmp/web-e2e', dir)
  if (!existsSync(src)) continue
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(outDir, 'shots', `${dir}__${f}`))
  }
}
const adjFile = '/tmp/web-e2e/vision-adjudication.json'
if (existsSync(adjFile)) copyFileSync(adjFile, join(outDir, 'vision-adjudication.json'))

const summary = {
  title: 'ieumoffice v0.12.11 웹 브리지 재심 증거 v2 (QA 1차 대응)',
  date: '2026-11-11',
  git: { commit: git, recentLog: gitLog },
  buildProvenance: {
    note: 'the executed bundles, hashed at packaging time (QA P2 traceability)',
    bundles,
  },
  runs,
  results,
}
writeFileSync(join(outDir, 'SUMMARY.json'), JSON.stringify(summary, null, 2))

// manifest over everything in the package
const manifest = {}
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (f === 'manifest.json') continue
    const buf = readFileSync(p)
    manifest[relative(outDir, p)] = { size: buf.length, sha256: sha256(buf) }
  }
}
walk(outDir)
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

console.log(JSON.stringify({ outDir, git, bundleCount: bundles.length, runCount: Object.keys(results).length }))
