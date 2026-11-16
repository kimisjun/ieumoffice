/**
 * The skills forest (Ieum Forest) rules without a DOM: when the home screen
 * offers it, the GitHub address the "get" tab builds, and the card and row
 * views that show optional metadata (version, provenance, install count)
 * only when some source actually reports it.
 */
import { describe, expect, it } from 'vitest'
import type {
  UserSkillImportCandidateView,
  UserSkillImportPreview,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import { skillHubAvailable, type HomeAiEntryState } from '../src/renderer/src/ai-features'
import {
  buildSkillImportAddress,
  skillHubCandidateCard,
  skillHubInstalledRow,
  type SkillHubProvenanceSource,
} from '../src/renderer/src/skill-hub/skill-hub-model'

describe('whether the home screen offers the skills forest', () => {
  const states: HomeAiEntryState[] = [
    'connected',
    'checking',
    'needs-connection',
    'off',
    'disconnected',
  ]

  it('hides with AI off, whatever the connection state says', () => {
    for (const state of states) {
      expect(skillHubAvailable(false, state), state).toBe(false)
    }
  })

  it('hides while the connection state reads "connection needed"', () => {
    expect(skillHubAvailable(true, 'needs-connection')).toBe(false)
  })

  it('stays up for every other connection state', () => {
    for (const state of states.filter((s) => s !== 'needs-connection')) {
      expect(skillHubAvailable(true, state), state).toBe(true)
    }
  })
})

describe('the GitHub address the get tab builds', () => {
  it('sends a short owner/repo as written', () => {
    expect(buildSkillImportAddress('octocat/skills', '')).toBe('octocat/skills')
    expect(buildSkillImportAddress('  octocat/skills  ', '   ')).toBe('octocat/skills')
    expect(buildSkillImportAddress('octocat/skills.git', '')).toBe('octocat/skills')
  })

  it('joins an optional folder path as a tree address', () => {
    expect(buildSkillImportAddress('octocat/skills', 'skills/example')).toBe(
      'https://github.com/octocat/skills/tree/HEAD/skills/example',
    )
    expect(buildSkillImportAddress('octocat/skills', '/skills/example/')).toBeNull()
    expect(buildSkillImportAddress('octocat/skills', 'main')).toBe(
      'https://github.com/octocat/skills/tree/HEAD/main',
    )
  })

  it('keeps a longer address as the person typed it', () => {
    expect(buildSkillImportAddress('https://github.com/octocat/skills', '')).toBe(
      'https://github.com/octocat/skills',
    )
    expect(buildSkillImportAddress('https://github.com/octocat/skills/tree/main/skills', '')).toBe(
      'https://github.com/octocat/skills/tree/main/skills',
    )
    expect(buildSkillImportAddress('octocat/skills@my-skill', '')).toBe('octocat/skills@my-skill')
  })

  it('refuses fields the import would refuse outright', () => {
    expect(buildSkillImportAddress('', '')).toBeNull()
    expect(buildSkillImportAddress('not a repo', '')).toBeNull()
    expect(buildSkillImportAddress('octocat', '')).toBeNull()
    expect(buildSkillImportAddress('octocat/skills', 'skills/../etc')).toBeNull()
    for (const path of ['/etc', 'C:/temp', 'a\\b', 'a//b', 'a/%2e%2e/b'])
      expect(buildSkillImportAddress('octocat/skills', path)).toBeNull()
    expect(
      buildSkillImportAddress('https://github.com/octocat/skills/tree/main', 'example'),
    ).toBeNull()
    expect(buildSkillImportAddress('https://github.com/octocat/skills', 'example')).toBe(
      'https://github.com/octocat/skills/tree/HEAD/example',
    )
  })
})

function candidate(
  key: string,
  over: Partial<UserSkillImportCandidateView> & { version?: string; installs?: number } = {},
): UserSkillImportCandidateView {
  return {
    key,
    rel: `skills/${key}`,
    name: `${key}-skill`,
    title: `Skill ${key}`,
    description: `What ${key} does.`,
    files: 2,
    bytes: 100,
    hasScripts: false,
    hasTemplate: false,
    urls: [],
    urlCount: 0,
    license: undefined,
    warnings: [],
    warningCount: 0,
    collision: false,
    problem: undefined,
    ...over,
  }
}

const githubOrigin: UserSkillImportPreview['origin'] = {
  kind: 'github',
  repo: 'octocat/skills',
  ref: 'main',
  commit: 'abc123',
  path: '',
}

describe('the cards of what was found', () => {
  it('shows the parsed front-matter fields and the GitHub owner as publisher', () => {
    const card = skillHubCandidateCard(candidate('one', { version: '1.2.0' }), githubOrigin)
    expect(card).toMatchObject({
      key: 'one',
      name: 'one-skill',
      title: 'Skill one',
      description: 'What one does.',
      publisher: 'octocat',
      version: '1.2.0',
    })
  })

  it('leaves version and install count out when nothing reports them', () => {
    const card = skillHubCandidateCard(candidate('two'), githubOrigin)
    expect(card.version).toBeUndefined()
    expect(card.installs).toBeUndefined()
    expect(card).not.toHaveProperty('version')
  })

  it('shows an install count only when one is actually known', () => {
    const known = skillHubCandidateCard(candidate('three', { installs: 42 }), githubOrigin)
    expect(known.installs).toBe(42)
    const nonsense = skillHubCandidateCard(
      candidate('four', { installs: Number.NaN }),
      githubOrigin,
    )
    expect(nonsense.installs).toBeUndefined()
  })

  it('has no publisher outside a GitHub import', () => {
    const card = skillHubCandidateCard(candidate('five'), { kind: 'folder' })
    expect(card.publisher).toBeUndefined()
    expect(card).not.toHaveProperty('publisher')
  })
})

function view(
  over: Partial<UserSkillView> & {
    version?: string
    provenance?: { source: SkillHubProvenanceSource; sourceUrl?: string }
  } = {},
): UserSkillView {
  return {
    id: 'app:one-skill',
    source: 'app',
    plugin: undefined,
    name: 'one-skill',
    title: 'One Skill',
    description: 'What it does.',
    enabled: true,
    invoke: 'auto',
    hidden: false,
    hasScripts: false,
    mcpServers: [],
    template: undefined,
    templateExists: false,
    agentOnly: false,
    unreadable: undefined,
    files: 2,
    bytes: 100,
    github: undefined,
    owned: true,
    can: {
      edit: true,
      copyToMine: false,
      export: true,
      checkUpdate: false,
      openFolder: true,
      remove: true,
      hide: false,
    },
    shadowedBy: undefined,
    ...over,
  }
}

describe('the rows of installed skills', () => {
  it('carries the state, the delete right and what the service records', () => {
    const row = skillHubInstalledRow(
      view({
        version: '2.0.0',
        provenance: { source: 'official', sourceUrl: 'https://example.com' },
      }),
    )
    expect(row).toMatchObject({
      id: 'app:one-skill',
      title: 'One Skill',
      description: 'What it does.',
      enabled: true,
      canRemove: true,
      provenanceSource: 'official',
      provenanceUrl: 'https://example.com',
      version: '2.0.0',
    })
  })

  it('leaves version and provenance out when the service records none', () => {
    const row = skillHubInstalledRow(view())
    expect(row.version).toBeUndefined()
    expect(row.provenanceSource).toBeUndefined()
    expect(row).not.toHaveProperty('version')
  })

  it('reads a malformed provenance as none', () => {
    const row = skillHubInstalledRow(view({ provenance: { source: 'elsewhere' } as never }))
    expect(row.provenanceSource).toBeUndefined()
  })
})
