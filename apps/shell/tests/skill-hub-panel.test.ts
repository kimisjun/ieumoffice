// @vitest-environment jsdom
/**
 * The skills forest page (Ieum Forest): the three tabs, the get tab's GitHub
 * flow through the real import/preview/install calls of the skills API, and
 * the my-skills tab's toggle and delete-with-confirm through the same API the
 * settings screen persists with. The bridge is a stub; nothing here reaches
 * the network or a real skill folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  UserSkillImportCandidateView,
  UserSkillImportContent,
  UserSkillImportPreview,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import { skillsText } from '../src/renderer/src/i18n/strings-skills'
import { skillHubText } from '../src/renderer/src/i18n/strings-skill-hub'
import { SkillHubPanel, type SkillHubApi } from '../src/renderer/src/skill-hub/SkillHubPanel'

let root: Root
let container: HTMLDivElement
let api: SkillHubApi
let removed: string[]
type StateChange = [string, { enabled?: boolean }]
type InstallCall = [string, string[], Record<string, string> | undefined]
type ReadCall = [string, string]
let stateChanges: StateChange[]
let importAddresses: string[]
let installCalls: InstallCall[]
let readCalls: ReadCall[]
let lists: UserSkillView[]

function candidate(
  key: string,
  over: Partial<UserSkillImportCandidateView> & { version?: string } = {},
): UserSkillImportCandidateView {
  return {
    key,
    rel: `skills/${key}`,
    name: `${key}-skill`,
    title: `Skill ${key}`,
    description: `What ${key} does for the person and the AI.`,
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

const preview: UserSkillImportPreview = {
  token: 'tok-1',
  origin: { kind: 'github', repo: 'octocat/skills', ref: 'main', commit: 'abc123', path: '' },
  candidates: [
    candidate('one', { version: '1.2.0' }),
    candidate('two', { collision: true }),
    candidate('three', { problem: 'too-large' }),
  ],
  rootLicense: undefined,
}

const importContent: UserSkillImportContent = {
  body: { text: '## How to use\n\nAsk for a meeting summary.', truncated: false },
  files: [],
}

function view(over: Partial<UserSkillView> = {}): UserSkillView {
  return {
    id: 'app:one-skill',
    source: 'app',
    plugin: undefined,
    name: 'one-skill',
    title: 'One Skill',
    description: 'Writes meeting notes.',
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  importAddresses = []
  installCalls = []
  readCalls = []
  stateChanges = []
  removed = []
  lists = [
    view({
      id: 'app:one-skill',
      version: '1.2.0',
      provenance: { source: 'official' },
    } as Partial<UserSkillView>),
    view({
      id: 'builtin:base',
      source: 'builtin',
      name: 'base',
      title: 'Base',
      description: 'Built-in description.',
      enabled: false,
      owned: false,
      can: {
        edit: false,
        copyToMine: true,
        export: true,
        checkUpdate: false,
        openFolder: true,
        remove: false,
        hide: true,
      },
    }),
  ]
  api = {
    importGitHub: async (address: string) => {
      importAddresses.push(address)
      return { ok: true, preview }
    },
    readImport: async (token: string, key: string) => {
      readCalls.push([token, key])
      return { ok: true, content: importContent }
    },
    install: async (token: string, selected: string[], onCollision?: Record<string, string>) => {
      installCalls.push([token, selected, onCollision as Record<string, string> | undefined])
      return {
        ok: true,
        installed: selected.map((key) => ({ key, id: `app:${key}` })),
        skipped: [],
      }
    },
    cancelImport: async () => undefined,
    list: async () => lists,
    setState: async (id: string, patch: { enabled?: boolean }) => {
      stateChanges.push([id, patch])
      return { ok: true }
    },
    remove: async (id: string) => {
      removed.push(id)
      return { ok: true }
    },
    onChanged: () => () => undefined,
  } as unknown as SkillHubApi
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () =>
    root.render(createElement(SkillHubPanel, { lang: 'en', locale: 'en-US', api })),
  )
}

async function click(selector: string) {
  const el = container.querySelector<HTMLButtonElement>(selector)
  expect(el, selector).toBeTruthy()
  await act(async () => el!.click())
}

/** type into a field the way a person does (React's value tracker sees it) */
async function type(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(selector)!
  expect(el, selector).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

function text(): string {
  return container.textContent ?? ''
}

describe('the skills forest page', () => {
  it('shows the three tabs, and the share tab is a coming-soon note only', async () => {
    await render()
    expect(container.querySelector('[data-testid="ysp-page"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="ysp-tab-get"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    await click('[data-testid="ysp-tab-share"]')
    const soon = container.querySelector('[data-testid="ysp-share-soon"]')
    expect(soon?.textContent).toBe(skillHubText('en', 'shareComingSoon'))
    expect(container.querySelector('.ysp-form')).toBeNull()
    expect(container.querySelector('.ysp-rows')).toBeNull()
    expect(text()).not.toContain(skillHubText('en', 'getIntro'))
  })
})

describe('the get tab', () => {
  it('finds a repository with an optional path and previews it for real', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await type('[data-testid="ysp-path"]', 'skills/example')
    await click('[data-testid="ysp-find"]')
    expect(importAddresses).toEqual(['https://github.com/octocat/skills/tree/HEAD/skills/example'])
    // the found cards: title and clamped description, publisher and version only if known
    const cards = container.querySelectorAll('.ysp-card')
    expect(cards.length).toBe(3)
    expect(text()).toContain('Skill one')
    expect(container.querySelectorAll('[data-testid="ysp-card-desc"]').length).toBe(3)
    expect(container.querySelectorAll('[data-testid="ysp-card-publisher"]')[0]?.textContent).toBe(
      'octocat',
    )
    const versions = container.querySelectorAll('[data-testid="ysp-card-version"]')
    expect(versions.length).toBe(1)
    expect(versions[0]?.textContent).toBe(skillHubText('en', 'versionBadge', { version: '1.2.0' }))
    expect(container.querySelector('[data-testid="ysp-card-installs"]')).toBeNull()
    // the standing safety warning under every preview
    expect(container.querySelector('.skl-preview-warning')?.textContent).toBe(
      skillsText('en', 'previewWarning'),
    )
  })

  it('refuses an address the import would refuse before asking for it', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'not a repo')
    await click('[data-testid="ysp-find"]')
    expect(importAddresses).toEqual([])
    expect(container.querySelector('[data-testid="ysp-error"]')?.textContent).toBe(
      skillsText('en', 'failBadAddress'),
    )
    expect(container.querySelector('.ysp-card')).toBeNull()
  })

  it('shows the parsed front-matter fields and the body before installing', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await click('[data-testid="ysp-find"]')
    await click('.ysp-card[data-key="one"] [data-testid="ysp-card-preview"]')
    await act(async () => {})
    expect(readCalls).toEqual([['tok-1', 'one']])
    const detail = container.querySelector('[data-testid="ysp-detail"]')!
    expect(detail.querySelector('[data-testid="ysp-detail-name"]')?.textContent).toBe('one-skill')
    expect(detail.querySelector('[data-testid="ysp-detail-description"]')?.textContent).toBe(
      'What one does for the person and the AI.',
    )
    expect(detail.querySelector('[data-testid="ysp-detail-version"]')?.textContent).toBe('1.2.0')
    expect(detail.querySelector('[data-testid="ysp-detail-body"]')?.textContent).toContain(
      'Ask for a meeting summary.',
    )
  })

  it('installs one skill and says how many went in', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await click('[data-testid="ysp-find"]')
    await click('.ysp-card[data-key="one"] [data-testid="ysp-card-install"]')
    expect(installCalls).toEqual([['tok-1', ['one'], {}]])
    expect(container.querySelector('[data-testid="ysp-notice"]')?.textContent).toBe(
      skillsText('en', 'installed', { n: 1 }),
    )
  })

  it('wants a replace-or-skip answer before installing over a taken name', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await click('[data-testid="ysp-find"]')
    await click('.ysp-card[data-key="two"] [data-testid="ysp-card-install"]')
    expect(installCalls).toEqual([])
    expect(container.querySelector('[data-testid="ysp-error"]')?.textContent).toBe(
      skillsText('en', 'chooseCollision'),
    )
    await click('.ysp-card[data-key="two"] .ysp-choice')
    await click('.ysp-card[data-key="two"] [data-testid="ysp-card-install"]')
    expect(installCalls).toEqual([['tok-1', ['two'], { two: 'replace' }]])
  })

  it('never offers installing a skill that cannot be installed', async () => {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await click('[data-testid="ysp-find"]')
    const install = container.querySelector<HTMLButtonElement>(
      '.ysp-card[data-key="three"] [data-testid="ysp-card-install"]',
    )!
    expect(install.disabled).toBe(true)
    expect(text()).toContain(
      skillsText('en', 'problemCannot', { reason: skillsText('en', 'unreadableTooLarge') }),
    )
  })
})

describe('preview ownership and filtering', () => {
  async function find() {
    await render()
    await type('[data-testid="ysp-repo"]', 'octocat/skills')
    await click('[data-testid="ysp-find"]')
  }

  it('filters fetched cards by name, title or description', async () => {
    await find()
    await type('[data-testid="ysp-search"]', 'ONE')
    expect(container.querySelectorAll('.ysp-card')).toHaveLength(1)
    expect(container.querySelector('.ysp-card')?.getAttribute('data-key')).toBe('one')
  })

  it('disposes a settled preview when leaving the get tab', async () => {
    const cancel = vi.fn(async () => undefined)
    api.cancelImport = cancel
    await find()
    await click('[data-testid="ysp-tab-mine"]')
    expect(cancel).toHaveBeenCalledWith('tok-1')
  })

  it('disposes the old token before a replacement lookup', async () => {
    const cancel = vi.fn(async () => undefined)
    api.cancelImport = cancel
    await find()
    await click('[data-testid="ysp-find"]')
    expect(cancel).toHaveBeenCalledWith('tok-1')
    expect(importAddresses).toHaveLength(2)
  })

  it('drops an expired preview after install failure and shows the refusal', async () => {
    api.install = async () => ({ ok: false, reason: 'not-installable' })
    await find()
    await click('.ysp-card[data-key="one"] [data-testid="ysp-card-install"]')
    expect(container.querySelector('.ysp-card')).toBeNull()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('reports transport failure rather than leaving lookup busy forever', async () => {
    api.importGitHub = async () => {
      throw new Error('transport')
    }
    await find()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="ysp-find"]')!.disabled).toBe(
      false,
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      skillsText('en', 'failGeneric'),
    )
  })
})

describe('the my skills tab', () => {
  async function openMine() {
    await render()
    await click('[data-testid="ysp-tab-mine"]')
    await act(async () => {})
  }

  it('lists every skill with its source badge, version and description', async () => {
    await openMine()
    const rows = container.querySelectorAll('.ysp-row')
    expect(rows.length).toBe(2)
    const first = container.querySelector('.ysp-row[data-id="app:one-skill"]')!
    expect(first.textContent).toContain('One Skill')
    expect(first.querySelector('[data-testid="ysp-row-source"]')?.textContent).toBe(
      skillHubText('en', 'provOfficial'),
    )
    expect(first.querySelector('[data-testid="ysp-row-version"]')?.textContent).toBe(
      skillHubText('en', 'versionBadge', { version: '1.2.0' }),
    )
    expect(first.textContent).toContain('Writes meeting notes.')
    const second = container.querySelector('.ysp-row[data-id="builtin:base"]')!
    expect(second.querySelector('[data-testid="ysp-row-source"]')?.textContent).toBe(
      skillsText('en', 'sourceBuiltin'),
    )
    expect(second.querySelector('[data-testid="ysp-row-version"]')).toBeNull()
  })

  it('turns a skill on and off through the same API the settings screen persists with', async () => {
    await openMine()
    const toggle = container.querySelector<HTMLInputElement>(
      '.ysp-row[data-id="app:one-skill"] [data-testid="ysp-row-toggle"]',
    )!
    expect(toggle.checked).toBe(true)
    await act(async () => {
      toggle.click()
    })
    expect(stateChanges).toEqual([['app:one-skill', { enabled: false }]])
  })

  it('asks before deleting, and deletes only on the answer', async () => {
    await openMine()
    // the builtin has no delete (only own skills go to the trash)
    expect(
      container.querySelector('.ysp-row[data-id="builtin:base"] [data-testid="ysp-row-delete"]'),
    ).toBeNull()
    await click('.ysp-row[data-id="app:one-skill"] [data-testid="ysp-row-delete"]')
    const dialog = container.querySelector('[data-testid="ysp-delete-confirm"]')!
    expect(dialog.textContent).toContain(skillsText('en', 'confirmRemove', { title: 'One Skill' }))
    await click('[data-testid="ysp-delete-confirm"] .btn-secondary')
    expect(removed).toEqual([])
    await click('.ysp-row[data-id="app:one-skill"] [data-testid="ysp-row-delete"]')
    await click('[data-testid="ysp-delete-confirm"] .btn-danger')
    expect(removed).toEqual(['app:one-skill'])
  })

  it('shows a refused toggle without pretending the skill changed', async () => {
    api.setState = async () => ({ ok: false, reason: 'failed' })
    await openMine()
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="ysp-row-toggle"]')!
    await act(async () => toggle.click())
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      skillsText('en', 'failGeneric'),
    )
  })

  it('shows a failed delete and leaves the installed skill visible', async () => {
    api.remove = async () => ({ ok: false, reason: 'failed' })
    await openMine()
    await click('.ysp-row[data-id="app:one-skill"] [data-testid="ysp-row-delete"]')
    await click('[data-testid="ysp-delete-confirm"] .btn-danger')
    expect(container.querySelector('.ysp-row[data-id="app:one-skill"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      skillsText('en', 'failGeneric'),
    )
  })

  it('says so plainly when nothing is installed', async () => {
    lists = []
    await openMine()
    expect(container.querySelector('[data-testid="ysp-mine-empty"]')?.textContent).toBe(
      skillHubText('en', 'mineEmpty'),
    )
    expect(container.querySelector('.ysp-row')).toBeNull()
  })
})
