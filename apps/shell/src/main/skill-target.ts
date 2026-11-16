import type { Dirent } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { FAILSAFE_SCHEMA, load } from 'js-yaml'
import {
  MAX_USER_SKILL_BYTES,
  MAX_USER_SKILL_FILES,
  isInsideDir,
  isReservedUserSkillName,
  isValidUserSkillName,
  parseSkillMd,
  type SkillFolderLimits,
} from '@genoffice/ai-provider'
import { skillVersionOf } from './user-skills/skill-provenance'

/**
 * The gate for a skill folder the app installs (decision 0152): the target a
 * vouched list names, and — before anything lands in `~/.ieumoffice/skills` —
 * the folder's own contents. The import pipeline reads folders tolerantly
 * (skipping what it cannot trust); installing is stricter, so a folder that
 * hides a hostile entry is refused as a whole instead of being quietly
 * trimmed.
 */

export function isInstallableSkillDir(dir: unknown, vouched: Iterable<string>): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const key = resolve(dir)
  for (const allowed of vouched) if (resolve(allowed) === key) return true
  return false
}

/** Why a skill folder cannot be installed */
export type SkillInstallCheckReason =
  /** an entry name tries to walk out of the folder (`..`, a separator inside a name) */
  | 'traversal'
  /** an entry name is an absolute path or a drive-qualified one */
  | 'absolute'
  /** a symbolic link leads out of the folder (or cannot be resolved at all) */
  | 'escaping-link'
  /** an entry sits outside the folder's own tree */
  | 'outside'
  /** over the file count or byte limit */
  | 'too-large'
  /** no `SKILL.md`, or one without the required `name` and `description` */
  | 'bad-frontmatter'
  /** its `name` is not one the app reads (or a reserved one) */
  | 'bad-name'
  /** the folder or its SKILL.md cannot be read */
  | 'unreadable'

export interface SkillInstallCheckOk {
  ok: true
  /** the front matter `name` */
  name: string
  /** the version the front matter names, when it does */
  version: string | undefined
}

export type SkillInstallCheck = SkillInstallCheckOk | { ok: false; reason: SkillInstallCheckReason }

const DEFAULT_LIMITS: SkillFolderLimits = {
  files: MAX_USER_SKILL_FILES,
  bytes: MAX_USER_SKILL_BYTES,
}

/** An entry name that is safe as one path part: no separators, no `.`/`..`, no drive form */
function safeEntryName(name: string): SkillInstallCheckReason | undefined {
  // eslint-disable-next-line no-control-regex
  if (name === '' || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) return 'traversal'
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute'
  return undefined
}

/**
 * Whether a skill folder may be installed: every entry name is one plain
 * path part, every real path stays inside the folder (links leading out are
 * refused, not skipped), the folder is within the size limits, and its
 * `SKILL.md` carries the required front matter (`name`, `description`) with a
 * name the app reads. Returns the name and version it read. Rejecting is the
 * whole point here: nothing is normalized or trimmed.
 */
export async function checkSkillInstallDir(
  dir: unknown,
  limits: SkillFolderLimits = DEFAULT_LIMITS,
): Promise<SkillInstallCheck> {
  if (typeof dir !== 'string' || dir === '') return { ok: false, reason: 'unreadable' }
  if (!isAbsolute(dir)) return { ok: false, reason: 'absolute' }
  const root = await realpath(dir).catch(() => undefined)
  if (!root) return { ok: false, reason: 'unreadable' }
  const rootInfo = await stat(root).catch(() => undefined)
  if (!rootInfo?.isDirectory()) return { ok: false, reason: 'unreadable' }

  let files = 0
  let entriesSeen = 0
  let bytes = 0
  let skillMd: string | undefined
  let skillMdFolded: string | undefined

  const walk = async (
    current: string,
    rel: string,
    depth = 0,
  ): Promise<SkillInstallCheckReason | undefined> => {
    if (depth > 64) return 'too-large'
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return 'unreadable'
    }
    for (const entry of entries) {
      if (++entriesSeen > limits.files * 4) return 'too-large'
      const unsafe = safeEntryName(entry.name)
      if (unsafe) return unsafe
      const path = join(current, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      let target = path
      if (entry.isSymbolicLink()) {
        // a link is followed only as far as proving it stays inside; a broken
        // one cannot be proven inside and is refused with the escaping ones
        const real = await realpath(path).catch(() => undefined)
        if (!real || !isInsideDir(real, root)) return 'escaping-link'
        target = real
      }
      const info = await stat(target).catch(() => undefined)
      if (!info) return 'unreadable'
      if (info.isDirectory()) {
        // a real folder walks on; a link to a folder inside is left alone (the
        // installer copies files only, so it brings nothing in)
        if (!entry.isSymbolicLink()) {
          const deeper = await walk(path, relPath, depth + 1)
          if (deeper) return deeper
        }
        continue
      }
      if (!info.isFile()) return 'unreadable'
      files += 1
      bytes += info.size
      if (files > limits.files || bytes > limits.bytes) return 'too-large'
      if (rel === '' && entry.name.toLowerCase() === 'skill.md') {
        if (entry.name === 'SKILL.md') skillMd = target
        skillMdFolded ??= target
      }
    }
    return undefined
  }

  const walked = await walk(root, '')
  if (walked) return { ok: false, reason: walked }

  const skillMdPath = skillMd ?? skillMdFolded
  if (!skillMdPath) return { ok: false, reason: 'bad-frontmatter' }
  let text: string
  try {
    text = await readFile(skillMdPath, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  // The editor's parser is deliberately tolerant; installation is not.
  // FAILSAFE_SCHEMA accepts data only, never executable/custom YAML tags.
  const front = /^\ufeff?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m.exec(text)?.[1]
  if (front === undefined || Buffer.byteLength(front) > 64 * 1024)
    return { ok: false, reason: 'bad-frontmatter' }
  try {
    const data = load(front, { schema: FAILSAFE_SCHEMA })
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { ok: false, reason: 'bad-frontmatter' }
    const fields = data as Record<string, unknown>
    if (typeof fields.name !== 'string' || typeof fields.description !== 'string')
      return { ok: false, reason: 'bad-frontmatter' }
  } catch {
    return { ok: false, reason: 'bad-frontmatter' }
  }
  const parsed = parseSkillMd(text)
  const name = parsed?.name?.trim()
  const description = parsed?.description?.trim()
  if (!parsed || !name || !description) return { ok: false, reason: 'bad-frontmatter' }
  if (!isValidUserSkillName(name) || isReservedUserSkillName(name))
    return { ok: false, reason: 'bad-name' }
  return { ok: true, name, version: skillVersionOf(text) }
}
