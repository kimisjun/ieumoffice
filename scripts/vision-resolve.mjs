/* eslint-disable no-undef */
// Vision adjudication resolver (QA 1차 P1-A).
//
// A vision-dependent leg records PENDING_VISION with the SHA-256 of the exact
// screenshot it captured. An independent reader (vision_analyze) adjudicates
// that image and the adjudication is keyed by that hash. This script folds the
// adjudications back into the harness JSON — hash-bound, so an adjudication
// can never bless a screenshot from a different run.
//
// Run: node scripts/vision-resolve.mjs <harness.json> [adjudication.json]
import { readFileSync, writeFileSync } from 'node:fs'

const [file, adjFile = '/tmp/web-e2e/vision-adjudication.json'] = process.argv.slice(2)
const summary = JSON.parse(readFileSync(file, 'utf8'))
const adjudications = JSON.parse(readFileSync(adjFile, 'utf8'))

let resolved = 0
for (const r of summary.results) {
  if (!r.step.includes('PENDING_VISION')) continue
  const sha = r.detail?.vision?.sha256
  const adj = sha ? adjudications[sha] : null
  if (adj && adj.verdict === 'ok') {
    r.ok = true
    r.step = r.step.replace(': PENDING_VISION', '')
    r.detail.vision = {
      ...r.detail.vision,
      verdict: adj.verdict,
      reader: adj.reader ?? 'vision_analyze',
      resolvedAt: adj.resolvedAt ?? null,
    }
    resolved++
  } else if (adj) {
    r.detail.vision.status = adj.verdict
  }
}

const isNotRun = (r) => /NOT_RUN/.test(r.step) || r.status === 'NOT_RUN'
const counts = {
  pass: summary.results.filter((r) => r.ok && !isNotRun(r)).length,
  fail: summary.results.filter((r) => !r.ok && !isNotRun(r)).length,
  notRun: summary.results.filter(isNotRun).length,
  total: summary.results.length,
}
summary.counts = counts
summary.verdict = counts.fail > 0 ? 'FAIL' : counts.notRun > 0 ? 'PASS_WITH_NOT_RUN' : 'PASS'
summary.allPassed = counts.total > 0 && counts.pass === counts.total
summary.requiredPassed = counts.fail === 0
summary.visionResolved = resolved

const out = file.replace(/\.json$/, '-resolved.json')
writeFileSync(out, JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ out, resolved, verdict: summary.verdict, counts, allPassed: summary.allPassed, requiredPassed: summary.requiredPassed }))
