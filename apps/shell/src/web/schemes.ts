/**
 * The per-app custom media schemes exist only inside Electron; the web front
 * end rewrites them to same-origin paths. Bundle code is rewritten at serve
 * time (static.ts), but scheme strings also travel through the IPC bridge
 * (an open reply carries the document bytes as a media URL, the renderer
 * passes image sources back on save) — those are rewritten here, on both
 * directions of every frame, keyed by the tab's app.
 *
 * Contract rule (QA 3차 P0-A, cases 1-4): rewriting happens ONLY in
 * URL-typed CONTRACT FIELDS — whole values of URL fields, URL array items
 * (`imageSources`…), and ATTRIBUTE VALUES inside real tags of markup fields
 * (`html`, `content`…; comments and script/style bodies protected). Body
 * text (`text`), code, prose and unknown fields are NEVER touched: a
 * lone-URL document, a `src="…"` in prose or in a fenced code block
 * round-trips byte-identically. No value-shape guessing.
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
 * URL-typed contract fields: their values are URLs by contract (no shape
 * guessing). Arrays hold one URL per item.
 */
const URL_FIELDS = new Set([
  'src', 'href', 'url', 'dataUrl', 'target', 'poster', 'background', 'action',
  'formaction', 'data-src', 'data-href', 'xlink:href', 'imageSource',
  'mediaUrl', 'assetUrl',
])
const URL_ARRAY_FIELDS = new Set(['imageSources', 'media', 'assets'])
/** markup-typed contract fields: only ATTRIBUTE VALUES inside real tags change */
const MARKUP_FIELDS = new Set(['html', 'content', 'markup', 'svg'])
const URL_ATTRS = 'src|href|poster|action|formaction|data-src|data-href|xlink:href'

/**
 * Surgical attribute rewriting for markup fields: only the values of URL
 * attributes inside REAL start tags change. Comments and script/style bodies
 * are hidden first; text nodes never sit inside a tag span, so prose that
 * merely contains `src="…"` and code examples round-trip byte-identically
 * (QA 3차 P0-A cases 3-4).
 */
function rewriteMarkupAttributes(
  markup: string,
  convert: (s: string) => string,
): string {
  const store: string[] = []
  const hide = (s: string): string => {
    store.push(s)
    return `\u0000${store.length - 1}\u0000`
  }
  let out = markup.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    hide,
  )
  out = out.replace(/<[a-zA-Z][^<>]*(?:"[^"]*"[^<>]*|'[^']*'[^<>]*)*>/g, (tag) =>
    tag.replace(
      new RegExp(`(\\s(?:${URL_ATTRS})\\s*=\\s*)(["'])([^"']*)\\2`, 'gi'),
      (_m, pre: string, q: string, val: string) => `${pre}${q}${convert(val)}${q}`,
    ),
  )
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => store[Number(i)] ?? '')
}

type Convert = (s: string) => string

/**
 * Contract-router: recurse through the payload and rewrite ONLY
 * URL-typed fields (whole values), URL array items, and markup attribute
 * values. `text` and every unknown field are NEVER touched. Typed arrays
 * (decoded binaries) and classed instances pass through untouched —
 * index-key reconstruction would turn a Uint8Array into {0:1, 1:2, …}.
 */
function routeContract(value: unknown, key: string | null, convert: Convert): unknown {
  if (typeof value === 'string') {
    if (key !== null && MARKUP_FIELDS.has(key)) return rewriteMarkupAttributes(value, convert)
    if (key !== null && URL_FIELDS.has(key)) return convert(value)
    return value // body/unknown fields: byte-preserved
  }
  if (Array.isArray(value)) {
    if (URL_ARRAY_FIELDS.has(key ?? '')) {
      return value.map((x) => (typeof x === 'string' ? convert(x) : routeContract(x, null, convert)))
    }
    return value.map((x) => routeContract(x, key, convert))
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, entry] of Object.entries(value as Record<string, unknown>)) {
      out[k] = routeContract(entry, k, convert)
    }
    return out
  }
  return value
}

function makeConverter(from: string, to: string): Convert {
  const head = `${from}://`
  return (s: string): string => (s.includes(head) ? s.split(head).join(`${to}://`) : s)
}

/** server → browser: scheme literals become the same-origin paths the served
 *  bundle code expects (contract fields only) */
export function rewriteOut(app: string, value: unknown): unknown {
  const rules = SCHEME_REWRITES[app]
  if (!rules) return value
  let out = value
  for (const [scheme, prefix] of rules) out = routeContract(out, null, makeConverter(scheme, prefix))
  return out
}

/** browser → server: same-origin paths become the scheme literals the
 *  main-process handlers expect (contract fields only) */
export function rewriteIn(app: string, value: unknown): unknown {
  const rules = SCHEME_REWRITES[app]
  if (!rules) return value
  let out = value
  for (const [scheme, prefix] of rules) out = routeContract(out, null, makeConverter(prefix, scheme))
  return out
}
