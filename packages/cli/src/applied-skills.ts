/**
 * The skills the person has applied (turned on) in IeumOffice, read from the
 * same places the app reads them: the skill source folders under the home and
 * the `skills` value of the app settings file (apps/shell/src/main/
 * app-settings.ts). Shared by the follow-along resources
 * (`ieumoffice://skills`, `ieumoffice://skills/<name>`) and `skill export`.
 *
 * Consent is the applied set: only skills the person turned on are ever
 * listed, read or exported (issue #558, "consent = applied"). Skills that are
 * off, hidden, for the agent window only, unreadable or pushed back by another
 * enabled skill of the same name are left out entirely. The on/off state comes
 * from the same settings the app writes, including the dev (unpacked) shell's
 * own profile, so a skill turned off in a running dev app never leaks here.
 */
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  IEUM_SOURCE_FILE,
  MAX_USER_SKILL_BYTES,
  MAX_USER_SKILL_FILES,
  listSkillFolderFiles,
  listUserSkills,
  normalizeUserSkillSettings,
  pickEnabledUserSkills,
  readListedSkillMd,
  resolveUserSkillStates,
  type UserSkillSettings,
  type UserSkillStateSetting,
} from '@genoffice/ai-provider'
import { genofficeDevUserDataDir, genofficeUserDataDir, guiOpenDocuments } from './gui'
import { packagedResourcesDir, repoRoot } from './resources'
import { CliError, EXIT } from './result'

/** app-settings.json key holding the skill on/off states (SKILLS_SETTING_KEY in the shell) */
const SKILLS_SETTINGS_KEY = 'skills'

/** One applied skill as the resources and the export see it */
export interface AppliedSkill {
  /** `source:name` identifier the app settings use */
  id: string
  /** the front matter `name`: the `<name>` of `ieumoffice://skills/<name>` */
  name: string
  /** `metadata.ieum-title`, else the name */
  title: string
  description: string
  /** the skill folder holding SKILL.md and its supporting files */
  dir: string
}

/** test seams: the home the skill folders live under and the app settings directory */
function homeOf(env: NodeJS.ProcessEnv): string {
  return env.GENOFFICE_HOME || env.HOME || homedir()
}

function settingsPath(dir: string): string {
  return join(dir, 'app-settings.json')
}

/** One app-settings.json profile: its parsed settings and whether a live shell is using it */
interface SettingsProfile {
  live: boolean
  settings: Record<string, unknown>
}

function readSettingsAt(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  } catch {
    // no settings file yet: every skill keeps its initial state
  }
  return {}
}

/**
 * The settings profiles a shell may write: GENOFFICE_USER_DATA when given,
 * else the installed app's and the dev (unpacked) shell's own, kept beside the
 * installed one (apps/shell/src/main/index.ts; control.ts and gui.ts probe both
 * the same way). A profile a running shell is using (its open-documents
 * registry names a live process) is the live shell's profile.
 */
function settingsProfiles(env: NodeJS.ProcessEnv): SettingsProfile[] {
  const dirs = env.GENOFFICE_USER_DATA
    ? [env.GENOFFICE_USER_DATA]
    : [genofficeUserDataDir(env), genofficeDevUserDataDir(env)]
  return dirs.map((dir) => ({
    live: guiOpenDocuments(env, [dir]).length > 0,
    settings: readSettingsAt(settingsPath(dir)),
  }))
}

/**
 * The skill on/off states across the profiles, one entry per skill: the live
 * shell's profile wins (a running dev app keeps its own state), and with no
 * live shell a skill left off in any profile is off here — what the person
 * turned off never reaches a connected client. Hidden builtins stay hidden
 * wherever they were hidden.
 */
function mergedSkillSettings(profiles: SettingsProfile[]): UserSkillSettings {
  const each = profiles.map((profile) => ({
    live: profile.live,
    skill: normalizeUserSkillSettings(profile.settings[SKILLS_SETTINGS_KEY]),
  }))
  const ordered = [...each.filter((e) => e.live), ...each.filter((e) => !e.live)]
  const states: Record<string, UserSkillStateSetting> = {}
  const ids = new Set(each.flatMap((e) => Object.keys(e.skill.states)))
  for (const id of ids) {
    const entry = ordered.find((e) => e.skill.states[id])?.skill.states[id]
    if (!entry) continue
    const offElsewhere =
      !each.some((e) => e.live && e.skill.states[id]) &&
      each.some((e) => e.skill.states[id]?.enabled === false)
    states[id] = offElsewhere ? { ...entry, enabled: false } : entry
  }
  const hiddenBuiltins = [...new Set(each.flatMap((e) => e.skill.hiddenBuiltins))]
  return { states, hiddenBuiltins }
}

/** The app's builtin skills folder: beside the packaged resources, the repository copy in a development run. */
function builtinSkillsDir(env: NodeJS.ProcessEnv): string | null {
  if (env.GENOFFICE_BUILTIN_SKILLS) return env.GENOFFICE_BUILTIN_SKILLS
  const packaged = packagedResourcesDir()
  const candidates = [
    ...(packaged ? [join(packaged, 'builtin-skills')] : []),
    ...(repoRoot() ? [join(repoRoot()!, 'apps', 'shell', 'resources', 'builtin-skills')] : []),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * Every skill the person has applied (enabled) in IeumOffice, one per name.
 * This is the follow-along set: what a connected MCP client may see. The
 * picked skill of a shared name wins, the same one the app's own AI uses, and
 * a builtin for the agent window only is left out like the app's own skill
 * read leaves it out (apps/shell user-skills-service `aiRead`).
 */
export async function appliedSkills(env: NodeJS.ProcessEnv): Promise<AppliedSkill[]> {
  const skills = await listUserSkills({
    homeDir: homeOf(env),
    builtinDir: builtinSkillsDir(env) ?? undefined,
  })
  const resolved = resolveUserSkillStates(skills, mergedSkillSettings(settingsProfiles(env)))
  const { chosen } = pickEnabledUserSkills(resolved)
  return chosen
    .filter((skill) => !skill.hidden && !skill.agentOnly)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      dir: skill.dir,
    }))
}

/** The `<name>` an applied skill is found by: its name without case, or its identifier */
export function findAppliedSkill(
  skills: readonly AppliedSkill[],
  wanted: string,
): AppliedSkill | undefined {
  return (
    skills.find((skill) => skill.id === wanted) ??
    skills.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase())
  )
}

/** The applied skills as `ieumoffice://skills` shows them: name and description only */
export function appliedSkillsSummary(skills: readonly AppliedSkill[]): string {
  if (!skills.length) return 'no skills applied in IeumOffice'
  return skills.map((skill) => `${skill.name}: ${firstLine(skill.description)}`).join('\n')
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]!.trim()
}

/** What a SKILL.md read found: the text, no SKILL.md in the folder, or a folder that cannot be read */
export type SkillMdRead = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'broken' }

/**
 * The full SKILL.md text of one applied skill, front matter included. Read
 * through the link-safe reader (`readListedSkillMd`), so a link leading out of
 * the folder is never followed and a case-variant `skill.md` counts on Windows
 * only (name folding is win32-only; POSIX names match exactly). A
 * folder without a SKILL.md is `missing`; a folder (or its SKILL.md) that
 * cannot be read is `broken`, never silently missing.
 */
export async function skillMdOf(skill: AppliedSkill): Promise<SkillMdRead> {
  const text = await readListedSkillMd(skill.dir)
  if (text !== undefined) return { kind: 'ok', text }
  const listed = await listSkillFolderFiles(skill.dir, {
    files: MAX_USER_SKILL_FILES,
    bytes: MAX_USER_SKILL_BYTES,
  })
  if (!listed) return { kind: 'broken' }
  const fold = (rel: string) => (process.platform === 'win32' ? rel.toLowerCase() : rel)
  const there = listed.files.some(
    (file) => file.rel === 'SKILL.md' || fold(file.rel) === fold('SKILL.md'),
  )
  // listed but not read: the read failed (a vanished or unreadable file), not a missing one
  return there ? { kind: 'broken' } : { kind: 'missing' }
}

export interface SkillExportResult {
  path: string
  files: number
  bytes: number
}

/**
 * Write an applied skill as a standard skill folder (SKILL.md with its YAML
 * front matter plus its supporting files) ready to publish, e.g. to GitHub.
 * The out folder is the skill folder itself and must be new or empty; the
 * app's GitHub source record stays behind. A failure leaves the out folder as
 * it was found, and a folder without a SKILL.md is an error, never an empty
 * "standard skill folder". Returns what was written.
 */
export async function exportSkillFolder(
  skill: AppliedSkill,
  outDir: string,
): Promise<SkillExportResult> {
  let there: string[] | undefined
  try {
    there = await readdir(outDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // anything but "not created yet" (a file in the way, no access) is a bad --out
      throw new CliError(
        EXIT.usage,
        `cannot use the output folder: ${outDir}`,
        { skill: skill.name, path: outDir },
        {
          reason: 'invalid_argument',
          suggestion: 'choose a folder this program can create and write',
        },
      )
    }
    // not created yet: nothing in the way
  }
  if (there && there.length > 0) {
    throw new CliError(
      EXIT.file,
      `the output folder is not empty: ${outDir}`,
      { skill: skill.name, path: outDir },
      { reason: 'output_exists', suggestion: 'choose a new or empty folder' },
    )
  }
  const listed = await listSkillFolderFiles(skill.dir, {
    files: MAX_USER_SKILL_FILES,
    bytes: MAX_USER_SKILL_BYTES,
  })
  if (!listed) {
    throw new CliError(
      EXIT.file,
      `cannot read the skill folder: ${skill.dir}`,
      { skill: skill.name, path: skill.dir },
      { reason: 'file_not_found' },
    )
  }
  if (listed.tooLarge) {
    throw new CliError(
      EXIT.file,
      `the skill folder is too large: ${skill.dir}`,
      { skill: skill.name, path: skill.dir, max_bytes: MAX_USER_SKILL_BYTES },
      { reason: 'resource_limit' },
    )
  }
  const fold = (rel: string) => (process.platform === 'win32' ? rel.toLowerCase() : rel)
  /** everything written so far, taken back out when the export fails midway */
  const written: string[] = []
  const madeDirs = new Set<string>()
  const cleanUp = async () => {
    for (const path of written) await unlink(path).catch(() => {})
    // deepest first; rmdir only drops a folder that is empty, so nothing else can go
    for (const path of [...madeDirs].sort((a, b) => b.length - a.length)) {
      await rmdir(path).catch(() => {})
    }
    if (there === undefined) await rmdir(outDir).catch(() => {})
  }
  let files = 0
  let bytes = 0
  let skillMdCopied = false
  try {
    for (const file of listed.files) {
      // the GitHub source record is this app's bookkeeping, not part of the standard folder
      if (file.rel === IEUM_SOURCE_FILE) continue
      const parts = file.rel.split('/')
      const target = join(outDir, ...parts)
      for (let i = 1; i < parts.length; i += 1) madeDirs.add(join(outDir, ...parts.slice(0, i)))
      await mkdir(dirname(target), { recursive: true })
      // exclusive: a file another process put there is never overwritten
      await copyFile(file.path, target, fsConstants.COPYFILE_EXCL)
      written.push(target)
      files += 1
      bytes += file.size
      if (fold(file.rel) === fold('SKILL.md')) skillMdCopied = true
    }
  } catch (err) {
    await cleanUp()
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError(
        EXIT.file,
        `a file appeared in the output folder while exporting: ${outDir}`,
        { skill: skill.name, path: outDir },
        { reason: 'output_exists', suggestion: 'choose a new or empty folder' },
      )
    }
    throw new CliError(
      EXIT.usage,
      `cannot write into the output folder: ${outDir}`,
      { skill: skill.name, path: outDir },
      {
        reason: 'invalid_argument',
        suggestion: 'choose a folder this program can write',
      },
    )
  }
  if (!skillMdCopied) {
    // the standard skill folder promise: SKILL.md is always in it
    await cleanUp()
    throw new CliError(
      EXIT.file,
      `the skill folder has no SKILL.md to export: ${skill.dir}`,
      { skill: skill.name, path: skill.dir },
      { reason: 'file_not_found' },
    )
  }
  return { path: outDir, files, bytes }
}
