/**
 * What the app recorded about the skills it installed (decision 0152): where
 * each one came from (`official`/`community`/`local`), the web address it was
 * taken from, and the version its SKILL.md named at the time. The record lives
 * in `app-settings.json` under `skillProvenance`, keyed by skill identifier.
 *
 * It mirrors the pattern of the external agent-skill ledger
 * (`@genoffice/cli/agent-skills`, `agentSkillInstalls` in the same settings
 * file) — a settings-backed record of what this app wrote — but it is its own
 * key with its own shape and the two never mix. Builtins need no record: a
 * skill the app ships is `builtin` wherever it is listed.
 */
import { PRODUCT_REPO_SLUG } from '@genoffice/i18n'
import { parseSkillMd, type SkillImportOrigin } from '@genoffice/ai-provider'
import { readAppSettings, writeAppSetting } from '../app-settings'

/** The `skillProvenance` value of the app settings file */
export const SKILL_PROVENANCE_KEY = 'skillProvenance'

/** Where an installed skill came from (a builtin is never recorded here) */
export type SkillProvenanceSource = 'official' | 'community' | 'local'

/** One recorded install */
export interface SkillProvenanceEntry {
  source: SkillProvenanceSource
  /** the web address it was taken from (GitHub skills) */
  sourceUrl?: string | undefined
  /** the version its SKILL.md named when recorded */
  version?: string | undefined
  /** when it was recorded (ISO 8601, UTC, whole seconds) */
  at: string
}

/** skill identifier (`app:<name>`) → what the app recorded */
export type SkillProvenanceLedger = Record<string, SkillProvenanceEntry>

/** Longest version text recorded or shown */
const VERSION_MAX_CHARS = 128

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** One entry as stored; unknown or malformed entries are dropped when read */
function entryOf(value: unknown): SkillProvenanceEntry | undefined {
  if (!isRecord(value)) return undefined
  const source = value.source
  if (source !== 'official' && source !== 'community' && source !== 'local') return undefined
  const at = typeof value.at === 'string' ? value.at : ''
  const sourceUrl = typeof value.sourceUrl === 'string' ? value.sourceUrl.slice(0, 2048) : undefined
  const version =
    typeof value.version === 'string' ? value.version.slice(0, VERSION_MAX_CHARS) : undefined
  return {
    source,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(version ? { version } : {}),
    at,
  }
}

/** The `skillProvenance` value read back (mirrors `ledgerFromSettings`) */
export function skillProvenanceFromSettings(
  settings: Record<string, unknown>,
): SkillProvenanceLedger {
  const raw = settings[SKILL_PROVENANCE_KEY]
  if (!isRecord(raw)) return {}
  const ledger: SkillProvenanceLedger = {}
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id.length > 512) continue
    const entry = entryOf(value)
    if (entry) ledger[id] = entry
  }
  return ledger
}

/** The recorded installs as the settings file holds them now */
export function readSkillProvenance(settingsPath: string): SkillProvenanceLedger {
  return skillProvenanceFromSettings(readAppSettings(settingsPath))
}

/** Record one install under its skill identifier, replacing what was there */
export function recordSkillProvenance(
  settingsPath: string,
  id: string,
  entry: Omit<SkillProvenanceEntry, 'at'> & { at?: string },
): void {
  const ledger = readSkillProvenance(settingsPath)
  const at = entry.at ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  ledger[id] = {
    source: entry.source,
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    at,
  }
  writeAppSetting(settingsPath, SKILL_PROVENANCE_KEY, ledger)
}

/** Follow a skill's rename: the record moves to the new identifier */
export function moveSkillProvenance(settingsPath: string, fromId: string, toId: string): void {
  if (fromId === toId) return
  const ledger = readSkillProvenance(settingsPath)
  const kept = ledger[fromId]
  delete ledger[fromId]
  delete ledger[toId]
  if (kept) ledger[toId] = kept
  writeAppSetting(settingsPath, SKILL_PROVENANCE_KEY, ledger)
}

/** Take one record away (the skill is gone) */
export function dropSkillProvenance(settingsPath: string, id: string): void {
  const ledger = readSkillProvenance(settingsPath)
  if (!(id in ledger)) return
  delete ledger[id]
  writeAppSetting(settingsPath, SKILL_PROVENANCE_KEY, ledger)
}

/**
 * The version a SKILL.md text names: the front matter `version`, else
 * `metadata.version`. `undefined` when it names none (or the value is too
 * long to be one).
 */
export function skillVersionOf(text: string): string | undefined {
  const parsed = parseSkillMd(text)
  const value = (parsed?.fields['version'] ?? parsed?.metadata['version'])?.trim()
  return value && value.length <= VERSION_MAX_CHARS ? value : undefined
}

/** Where an import came from, as the record reads it */
export function provenanceOfOrigin(origin: SkillImportOrigin): {
  source: SkillProvenanceSource
  sourceUrl?: string
} {
  if (origin.kind === 'github') return provenanceOfGitHub(origin.repo, origin.commit, origin.path)
  return { source: 'local' }
}

/** A GitHub skill's provenance: the product's own repository is `official` */
export function provenanceOfGitHub(
  repo: string,
  commit: string,
  path: string,
): { source: SkillProvenanceSource; sourceUrl: string } {
  // every segment is URL-encoded on its own, so spaces, `#` and non-ASCII
  // names stay one segment in the address instead of breaking it
  const segment = (part: string) => encodeURIComponent(part)
  const folder = path
    ? `/tree/${segment(commit)}/${path.split('/').map(segment).join('/')}`
    : `/tree/${segment(commit)}`
  return {
    source: repo === PRODUCT_REPO_SLUG ? 'official' : 'community',
    sourceUrl: `https://github.com/${repo.split('/').map(segment).join('/')}${folder}`,
  }
}
