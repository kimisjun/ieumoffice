/**
 * The skills forest (Ieum Forest) home page without React: the GitHub address
 * the "get" tab builds from its owner/repo and optional path fields, and the
 * row and card views the two lists draw. Everything optional a skill carries
 * (version, provenance, install count) is read with safe optional access: the
 * skills service fills those fields in beside the shared views, and a view
 * without them shows nothing rather than a guess.
 */
import type {
  UserSkillImportCandidateView,
  UserSkillImportPreview,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import { skillDisplayTitle } from '../skills/skills-model'

/** The page's three tabs, in screen order */
export type SkillHubTab = 'get' | 'mine' | 'share'

export const SKILL_HUB_TABS: readonly SkillHubTab[] = ['get', 'mine', 'share']

/** Where a skill came from, as the service records it beside the view */
export type SkillHubProvenanceSource = 'builtin' | 'official' | 'community' | 'local'

/** The optional metadata the skills service adds beside the shared views */
export interface SkillHubSkillMeta {
  version?: string | undefined
  provenance?: { source: SkillHubProvenanceSource; sourceUrl?: string | undefined } | undefined
}

type WithMeta<T> = T & {
  version?: unknown
  installs?: unknown
  publisher?: unknown
  provenance?: unknown
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function provenanceOf(value: unknown): SkillHubSkillMeta['provenance'] {
  if (!value || typeof value !== 'object') return undefined
  const source = (value as { source?: unknown }).source
  if (
    source !== 'builtin' &&
    source !== 'official' &&
    source !== 'community' &&
    source !== 'local'
  ) {
    return undefined
  }
  return { source, sourceUrl: shortText((value as { sourceUrl?: unknown }).sourceUrl) }
}

// the same two shapes the GitHub import accepts (`parseGitHubSkillAddress`)
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/

function repoName(value: string): string | undefined {
  const name = value.endsWith('.git') ? value.slice(0, -4) : value
  return REPO.test(name) && name !== '.' && name !== '..' ? name : undefined
}

/**
 * The address the "get" tab sends to the GitHub import. A short `owner/repo`
 * goes as written. A separate folder is rooted at GitHub's HEAD commit ref,
 * not mistaken for a branch name. Full tree URLs already specify a ref/path
 * and cannot be combined with a second folder field.
 */
export function buildSkillImportAddress(repoInput: string, pathInput: string): string | null {
  const repo = repoInput.trim()
  const path = pathInput.trim()
  if (!repo || /\s/.test(repo)) return null
  if (
    path &&
    (/\s|[\\?#%]/.test(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.split('/').some((part) => !part || part === '..' || part === '.'))
  ) {
    return null
  }
  const short = /^([^/@]+)\/([^/@]+)$/.exec(repo)
  if (short) {
    const owner = short[1]!
    const name = repoName(short[2]!)
    if (!OWNER.test(owner) || !name) return null
    return path ? `https://github.com/${owner}/${name}/tree/HEAD/${path}` : `${owner}/${name}`
  }
  if (path) {
    const rootUrl = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/i.exec(repo)
    if (!rootUrl) return null
    return buildSkillImportAddress(`${rootUrl[1]}/${rootUrl[2]}`, path)
  }
  // Full addresses keep the person's chosen ref and folder verbatim.
  if (
    /^https:\/\/(?:github\.com|skills\.sh)\//i.test(repo) ||
    /^[^/@]+\/[^/@]+@[^/@]+$/.test(repo)
  ) {
    return repo
  }
  return null
}

/** One card of the "get" list: what is known about a found skill, never a guess */
export interface SkillHubCardView {
  key: string
  /** the parsed front-matter name, as the list titles the card */
  name: string
  title: string
  description: string
  /** the GitHub owner (or the candidate's own field) when known */
  publisher?: string | undefined
  /** the parsed front-matter version when the import reports one */
  version?: string | undefined
  /** install count only when some source actually reports one */
  installs?: number | undefined
}

function ownerOfRepo(repo: string): string | undefined {
  return shortText(repo.split('/')[0])
}

/** The card view of one found skill: publisher, version and installs only when known */
export function skillHubCandidateCard(
  candidate: UserSkillImportCandidateView,
  origin: UserSkillImportPreview['origin'],
): SkillHubCardView {
  const meta = candidate as WithMeta<UserSkillImportCandidateView>
  const version = shortText(meta.version)
  const installs =
    typeof meta.installs === 'number' && Number.isFinite(meta.installs) && meta.installs >= 0
      ? Math.floor(meta.installs)
      : undefined
  const publisher =
    shortText(meta.publisher) ?? (origin.kind === 'github' ? ownerOfRepo(origin.repo) : undefined)
  return {
    key: candidate.key,
    name: candidate.name,
    title: candidate.title || candidate.name,
    description: candidate.description,
    ...(publisher ? { publisher } : {}),
    ...(version ? { version } : {}),
    ...(installs !== undefined ? { installs } : {}),
  }
}

/** One row of the "my skills" list */
export interface SkillHubRowView {
  id: string
  name: string
  title: string
  description: string
  enabled: boolean
  canRemove: boolean
  /** the provenance badge when the service records one; the source badge else */
  provenanceSource?: SkillHubProvenanceSource | undefined
  provenanceUrl?: string | undefined
  version?: string | undefined
}

/** The row view of one installed skill: version and provenance only when known */
export function skillHubInstalledRow(view: UserSkillView): SkillHubRowView {
  const meta = view as WithMeta<UserSkillView>
  const provenance = provenanceOf(meta.provenance)
  const version = shortText(meta.version)
  return {
    id: view.id,
    name: view.name,
    title: skillDisplayTitle(view),
    description: view.description,
    enabled: view.enabled,
    canRemove: view.can.remove,
    ...(provenance ? { provenanceSource: provenance.source } : {}),
    ...(provenance?.sourceUrl ? { provenanceUrl: provenance.sourceUrl } : {}),
    ...(version ? { version } : {}),
  }
}
