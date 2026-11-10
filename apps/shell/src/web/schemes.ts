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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrites are scoped to the URL form only (`scheme://…` ↔ `/__x://…`).
 * Bare scheme names inside document text, code samples or user input pass
 * through untouched — a body like "Literal /__mdasset and md-asset." must
 * round-trip byte-identically (QA P0-A). The lookbehind keeps an already
 * rewritten literal (`/__mdasset://…` contains `md-asset://`) from being
 * rewritten twice.
 */
function rewriteSchemeLiterals(value: unknown, from: string, to: string): unknown {
  const bare = new RegExp(`(?<![\\w-])${escapeRe(from)}://`, 'g')
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(bare, `${to}://`)
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
