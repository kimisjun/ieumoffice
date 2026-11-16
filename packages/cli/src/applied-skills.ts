/**
 * The skills the person has applied (turned on) in IeumOffice, read from the
 * same places the app reads them: the skill source folders under the home and
 * the `skills` value of the app settings file (apps/shell/src/main/
 * app-settings.ts). Shared by the follow-along resources
 * (`ieumoffice://skills`, `ieumoffice://skills/<name>`) and `skill export`.
 *
 * Consent is the applied set: only skills the person turned on are ever
 * listed, read or exported (issue #558, "consent = applied"). Skills that are
 * off, hidden, unreadable or pushed back by another enabled skill of the same
 * name are left out entirely.
 */
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  IEUM_SOURCE_FILE,
  MAX_USER_SKILL_BYTES,
  MAX_USER_SKILL_FILES,
  listSkillFolderFiles,
  listUserSkills,
  pickEnabledUserSkills,
  resolveUserSkillStates,
} from '@genoffice/ai-provider'
import { genofficeUserDataDir } from './gui'
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

function settingsPath(env: NodeJS.ProcessEnv): string {
  return join(genofficeUserDataDir(env), 'app-settings.json')
}

function readSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(env), 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  } catch {
    // no settings file yet: every skill keeps its initial state
  }
  return {}
}

/** The app's builtin skills folder: beside the packaged resources, the repository copy in a development run. */
function builtinSkillsDir(): string | null {
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
 * picked skill of a shared name wins, the same one the app's own AI uses.
 */
export async function appliedSkills(env: NodeJS.ProcessEnv): Promise<AppliedSkill[]> {
  const skills = await listUserSkills({
    homeDir: homeOf(env),
    builtinDir: builtinSkillsDir() ?? undefined,
  })
  const resolved = resolveUserSkillStates(skills, readSettings(env)[SKILLS_SETTINGS_KEY])
  const { chosen } = pickEnabledUserSkills(resolved)
  return chosen.map((skill) => ({
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

/** The full SKILL.md text of one applied skill, front matter included; undefined when it is gone */
export async function skillMdOf(skill: AppliedSkill): Promise<string | undefined> {
  return readFile(join(skill.dir, 'SKILL.md'), 'utf8').catch(() => undefined)
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
 * app's GitHub source record stays behind. Returns what was written.
 */
export async function exportSkillFolder(
  skill: AppliedSkill,
  outDir: string,
): Promise<SkillExportResult> {
  let there: string[] | undefined
  try {
    there = await readdir(outDir)
  } catch {
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
  let files = 0
  let bytes = 0
  for (const file of listed.files) {
    // the GitHub source record is this app's bookkeeping, not part of the standard folder
    if (file.rel === IEUM_SOURCE_FILE) continue
    const target = join(outDir, ...file.rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.path, target)
    files += 1
    bytes += file.size
  }
  return { path: outDir, files, bytes }
}
