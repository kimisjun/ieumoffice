/**
 * The per-app custom media schemes exist only inside Electron; the web front
 * end rewrites them to same-origin paths. Bundle code is rewritten at serve
 * time (static.ts), but scheme strings also travel through the IPC bridge
 * (an open reply carries the document bytes as a media URL, the renderer
 * passes image sources back on save) — those are rewritten here, on both
 * directions of every frame, keyed by the tab's app.
 */

export const SCHEME_REWRITES: Record<string, [string, string][]> = {
  docs: [['genoffice-docx-media', '/__media']],
  markdown: [['md-asset', '/__mdasset']],
  html: [
    ['html-preview', '/__preview'],
    ['html-asset', '/__htmlasset'],
  ],
}

/**
 * QA 2차 P0-A: rewriting is scoped to URL FIELDS, never free text.
 *
 * 1. whole-value strings that ARE a URL (imageSources entries, media URLs,
 *    file/asset paths — how URL fields travel the bridge); and
 * 2. HTML URL attribute values inside markup bodies (src/href/… — the URL
 *    fields of HTML content).
 *
 * Document text, code samples and prose that merely CONTAINS a URL-looking
 * literal pass through byte-identically in both directions — the QA repro
 * "Literal /__mdasset://example/doc and md-asset://example/doc." must
 * round-trip unchanged (QA_REPORT_2ND P0-A).
 */
const URL_ATTR_RE =
  /(\s(?:src|href|poster|action|formaction|data-src|data-href|xlink:href)\s*=\s*["'])([^"']*)(["'])/gi

function rewriteSchemeLiterals(value: unknown, from: string, to: string): unknown {
  const head = `${from}://`
  const fixValue = (s: string): string =>
    s.startsWith(head) && !/\s/.test(s) ? `${to}://${s.slice(head.length)}` : s
  const fixString = (s: string): string => {
    if (!s.includes('://')) return s
    if (s.startsWith(head) && !/\s/.test(s)) return fixValue(s)
    return s.replace(URL_ATTR_RE, (_m, pre: string, val: string, post: string) =>
      `${pre}${fixValue(val)}${post}`)
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return fixString(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      // only plain objects rebuild; typed arrays (decoded binaries) and other
      // classed instances pass through untouched — index-key reconstruction
      // would turn a Uint8Array into {0:1, 1:2, …}
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return v
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
        out[key] = walk(entry)
      }
      return out
    }
    return v
  }
  return walk(value)
}

/** server → browser: scheme literals become the same-origin paths the served
 *  bundle code expects */
export function rewriteOut(app: string, value: unknown): unknown {
  const rules = SCHEME_REWRITES[app]
  if (!rules) return value
  let out = value
  for (const [scheme, prefix] of rules) out = rewriteSchemeLiterals(out, scheme, prefix)
  return out
}

/** browser → server: same-origin paths become the scheme literals the
 *  main-process handlers expect */
export function rewriteIn(app: string, value: unknown): unknown {
  const rules = SCHEME_REWRITES[app]
  if (!rules) return value
  let out = value
  for (const [scheme, prefix] of rules) out = rewriteSchemeLiterals(out, prefix, scheme)
  return out
}
