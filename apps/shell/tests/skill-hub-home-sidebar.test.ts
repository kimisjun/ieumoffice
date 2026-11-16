// @vitest-environment jsdom
/**
 * The skills forest (Ieum Forest) entry on the home sidebar and its page: it
 * sits below the agent entry, it shows whenever the AI master toggle is on —
 * whatever the connection state says (no registered AI account must not hide
 * it) — and the entry and page fall back to the file list only when the
 * master toggle is turned off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiSettings, AiSubscriptionStatuses } from '@genoffice/ai-provider/browser'
import { Home } from '../src/renderer/src/Home'
import { LocaleProvider } from '../src/renderer/src/locale'
import { homeAiEntry } from '../src/renderer/src/subscription-status'
import type { SubscriptionConnection } from '../src/renderer/src/subscription-client'
import type { RecentEntry } from '../src/shared/home-api'
import { agentText } from '../src/renderer/src/i18n/strings-agent'
import { skillHubText } from '../src/renderer/src/i18n/strings-skill-hub'

let root: Root
let container: HTMLDivElement

const files: RecentEntry[] = [
  {
    path: '/fixtures/brief.docx',
    name: 'brief.docx',
    ext: 'docx',
    mtimeMs: 1,
    sizeBytes: 10,
    starred: true,
  },
]

/** the statuses of a PC with Claude signed in */
const connectedStatuses = {
  'claude-code': { provider: 'claude-code', state: 'ready', meteredAccepted: false },
  codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
} as unknown as AiSubscriptionStatuses

/** the statuses of a PC with nothing installed */
const emptyStatuses = {
  'claude-code': { provider: 'claude-code', state: 'not-installed', meteredAccepted: false },
  codex: { provider: 'codex', state: 'not-installed', meteredAccepted: false },
} as unknown as AiSubscriptionStatuses

/** the person picked Claude explicitly and it cannot run: "connection needed" */
const needConnectionSettings = { ...defaultAiSettings(), provider: 'claude-code' } as AiSettings

function connection(statuses: AiSubscriptionStatuses): SubscriptionConnection {
  return {
    statuses,
    busy: false,
    failed: {},
    codexImageAvailable: false,
    install: vi.fn(),
    update: vi.fn(),
    cancelLogin: vi.fn(),
    login: vi.fn(),
    switchAccount: vi.fn(),
    logout: vi.fn(),
    recheck: vi.fn(),
    refresh: vi.fn(),
    acceptMetered: vi.fn(async () => undefined),
    openInstallHelp: vi.fn(),
  } as unknown as SubscriptionConnection
}

async function render(options: {
  aiFeatures: boolean
  settings: AiSettings | null
  statuses: AiSubscriptionStatuses
}) {
  ;(window as unknown as { aiOfficeEditorChoice?: unknown }).aiOfficeEditorChoice = {
    get: async () => ({ off: [], aiFeatures: options.aiFeatures, locked: false }),
    onChange: () => () => undefined,
  }
  await act(async () =>
    root.render(
      createElement(LocaleProvider, {
        initial: 'en',
        children: createElement(Home, {
          connection: connection(options.statuses),
          aiSettings: options.settings,
          noticeDue: false,
          onNoticeAcknowledge: vi.fn(),
        }),
      }),
    ),
  )
  await act(async () => {})
}

function nav(testId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
}

function sidebarButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.sidebar-nav button')]
}

beforeEach(async () => {
  HTMLElement.prototype.scrollTo = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network in skills forest tests')
    }),
  )
  const page = async () => ({
    entries: files,
    total: files.length,
    totalAll: files.length,
    offset: 0,
  })
  const known: Record<string, unknown> = {
    folderRoots: async () => [],
    onFolderChanged: () => () => {},
    recents: page,
    starred: page,
    starredGroups: async () => [],
    accountStatus: async () => ({ loggedIn: false }),
    onOpenSettings: () => () => {},
    onAccountLogin: () => () => {},
    kbList: async () => [],
    aiGetSettings: async () => defaultAiSettings(),
    onAiSettingsChanged: () => () => {},
  }
  // this fork's home reads more of the bridge than the upstream one; answer the rest blank
  window.aiOffice = new Proxy(known, {
    get: (target, name: string) =>
      target[name] ?? (name.startsWith('on') ? () => () => undefined : async () => null),
  }) as unknown as Window['aiOffice']
  window.aiOfficeAgent = { open: vi.fn() }
  ;(window as unknown as { aiOfficeUserSkills?: unknown }).aiOfficeUserSkills = {
    list: async () => [],
    onChanged: () => () => undefined,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('the skills forest sidebar entry', () => {
  it('sits right below the agent entry and opens its page', async () => {
    await render({ aiFeatures: true, settings: defaultAiSettings(), statuses: connectedStatuses })
    const buttons = sidebarButtons()
    const agentIndex = buttons.findIndex(
      (button) =>
        button.querySelector('.nav-label')?.textContent === agentText('en', 'windowTitle'),
    )
    const forest = nav('home-skill-hub-nav')!
    expect(forest).toBeTruthy()
    const forestIndex = buttons.indexOf(forest)
    expect(agentIndex).toBeGreaterThanOrEqual(0)
    expect(forestIndex).toBe(agentIndex + 1)
    expect(forest.querySelector('.nav-label')?.textContent).toBe(skillHubText('en', 'name'))
    await act(async () => forest.click())
    expect(container.querySelector('[data-testid="ysp-page"]')).not.toBeNull()
    expect(forest.getAttribute('aria-current')).toBe('page')
  })

  it('is not there while AI is off', async () => {
    await render({ aiFeatures: false, settings: defaultAiSettings(), statuses: connectedStatuses })
    expect(nav('home-skill-hub-nav')).toBeNull()
  })

  it('stays while the connection state reads "connection needed"', async () => {
    // a provider that cannot run must not hide the entry: only the AI master toggle does
    expect(homeAiEntry(needConnectionSettings, emptyStatuses).state).toBe('needs-connection')
    await render({ aiFeatures: true, settings: needConnectionSettings, statuses: emptyStatuses })
    expect(nav('home-skill-hub-nav')).not.toBeNull()
  })

  it('stays while the connection is still checking or simply not connected', async () => {
    expect(homeAiEntry(defaultAiSettings(), emptyStatuses).state).toBe('disconnected')
    await render({ aiFeatures: true, settings: defaultAiSettings(), statuses: emptyStatuses })
    expect(nav('home-skill-hub-nav')).not.toBeNull()
  })

  it('keeps the page up when the connection turns to "needed" while it is open', async () => {
    await render({ aiFeatures: true, settings: defaultAiSettings(), statuses: connectedStatuses })
    await act(async () => nav('home-skill-hub-nav')!.click())
    expect(container.querySelector('[data-testid="ysp-page"]')).not.toBeNull()
    // the person picks a provider that cannot run: the page stays, keyed on the master toggle
    await render({ aiFeatures: true, settings: needConnectionSettings, statuses: emptyStatuses })
    expect(container.querySelector('[data-testid="ysp-page"]')).not.toBeNull()
    expect(nav('home-skill-hub-nav')).not.toBeNull()
  })

  it('takes the page away when AI is turned off while it is open', async () => {
    await render({ aiFeatures: true, settings: defaultAiSettings(), statuses: connectedStatuses })
    await act(async () => nav('home-skill-hub-nav')!.click())
    expect(container.querySelector('[data-testid="ysp-page"]')).not.toBeNull()
    await render({ aiFeatures: false, settings: defaultAiSettings(), statuses: connectedStatuses })
    expect(container.querySelector('[data-testid="ysp-page"]')).toBeNull()
    expect(container.querySelector('.content')?.textContent).toContain('brief.docx')
  })
})
