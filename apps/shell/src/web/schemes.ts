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
const MARKUP_FIELDS = new Set(['html', 'markup', 'svg'])
/** URL attribute NAMES (case-insensitive) — the attribute name, not a string
 *  match inside some other attribute's value (QA 4차 §2.2 case 2) */
const URL_ATTR_NAMES = new Set([
  'src', 'href', 'poster', 'action', 'formaction', 'data-src', 'data-href', 'xlink:href',
])
/** RAW-TEXT elements whose content is text, not markup (QA 4차 §2.2 case 3) */
const RAW_TEXT_ELEMENTS = 'script|style|textarea|title|noscript|xmp'
/** placeholders use private-use sentinels — an original NUL-digit-NUL string
 *  must never collide with the restore pattern (QA 4차 contract-edge) */
const HIDE_OPEN = '\uE000'
const HIDE_CLOSE = '\uE001'

/**
 * Surgical attribute rewriting for markup fields: only the value of an
 * attribute whose NAME is a URL attribute changes, and only inside REAL start
 * tags. Comments and RAW-TEXT bodies (script/style/textarea/title/noscript/xmp)
 * are hidden first; text nodes never sit inside a tag span; a `src="…"`
 * INSIDE another attribute's value (e.g. a title attribute) is never touched
 * (QA 4차 §2.2 cases 2-3).
 */
function rewriteMarkupAttributes(
  markup: string,
  convert: (s: string) => string,
): string {
  const store: string[] = []
  const hide = (s: string): string => {
    store.push(s)
    return `${HIDE_OPEN}${store.length - 1}${HIDE_CLOSE}`
  }
  let out = markup.replace(
    new RegExp(
      `<!--[\\s\\S]*?-->|<(?:${RAW_TEXT_ELEMENTS})\\b[^>]*>[\\s\\S]*?<\\/(?:${RAW_TEXT_ELEMENTS})\\s*>`,
      'gi',
    ),
    hide,
  )
  out = out.replace(/<[a-zA-Z][^<>]*(?:"[^"]*"[^<>]*|'[^']*'[^<>]*)*>/g, (tag) =>
    tag.replace(
      /(\s)([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')/g,
      (m: string, sp: string, name: string, eq: string, val: string) => {
        if (!URL_ATTR_NAMES.has(name.toLowerCase())) return m
        const q = val[0]
        return `${sp}${name}${eq}${q}${convert(val.slice(1, -1))}${q}`
      },
    ),
  )
  return out.replace(
    new RegExp(`${HIDE_OPEN}(\\d+)${HIDE_CLOSE}`, 'g'),
    (_m, i: string) => store[Number(i)] ?? '',
  )
}

type Convert = (s: string) => string

/**
 * `content` semantics follow the REQUEST TYPE discriminator — the same key is
 * Markdown source for type:'md' and markup for type:'html'
 * (CreateDocumentRequest.content, QA 4차 §2.2 case 1). Without a 'html'
 * discriminator the field is BODY and never touched: conservative default.
 */
function contentKind(parent: Record<string, unknown> | null): 'markup' | 'body' {
  const t = parent?.type
  return t === 'html' ? 'markup' : 'body'
}

/**
 * Contract-router: recurse through the payload and rewrite ONLY
 * URL-typed fields (whole values), URL array items, and markup attribute
 * values. Body fields (`text`, `title`, markdown `content`, …) and every
 * unknown field are NEVER touched. Typed arrays (decoded binaries) and classed
 * instances pass through untouched — index-key reconstruction would turn a
 * Uint8Array into {0:1, 1:2, …}.
 */
function routeContract(
  value: unknown,
  key: string | null,
  convert: Convert,
  parent: Record<string, unknown> | null = null,
): unknown {
  if (typeof value === 'string') {
    if (key === 'content' && contentKind(parent) === 'markup') return rewriteMarkupAttributes(value, convert)
    if (key !== null && MARKUP_FIELDS.has(key)) return rewriteMarkupAttributes(value, convert)
    if (key !== null && URL_FIELDS.has(key)) return convert(value)
    return value // body/unknown fields: byte-preserved
  }
  if (Array.isArray(value)) {
    if (URL_ARRAY_FIELDS.has(key ?? '')) {
      return value.map((x) => (typeof x === 'string' ? convert(x) : routeContract(x, null, convert, parent)))
    }
    return value.map((x) => routeContract(x, key, convert, parent))
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, entry] of Object.entries(obj)) {
      out[k] = routeContract(entry, k, convert, obj)
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
