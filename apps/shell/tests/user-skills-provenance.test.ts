import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_REPO_SLUG } from '@genoffice/i18n'
import type { SkillImport, SkillImportCandidate } from '@genoffice/ai-provider'
import {
  provenanceOfGitHub,
  readSkillProvenance,
  skillProvenanceFromSettings,
  skillVersionOf,
} from '../src/main/user-skills/skill-provenance'
import {
  createUserSkillsService,
  importPreviewOf,
  type UserSkillsService,
} from '../src/main/user-skills/user-skills-service'

/**
 * The provenance and version record (decision 0152): what the app writes when
 * a skill is installed, edited, copied, updated or removed, and what the
 * screens see of it. The record lives in `app-settings.json` under
 * `skillProvenance`, its own key beside the external agent-skill ledger.
 */

let root: string
let home: string
let builtin: string
let settingsPath: string
let service: UserSkillsService

const appDir = () => join(home, '.ieumoffice', 'skills')

function skill(dir: string, name: string, description: string, extra = '', body = 'Do it.\n') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}`,
  )
}

function candidateOf(dir: string, name: string, over: Partial<SkillImportCandidate> = {}) {
  return {
    key: name,
    rel: name,
    dir,
    name,
    title: name,
    description: 'A demo skill',
    files: 1,
    bytes: 10,
    hasScripts: false,
    hasTemplate: false,
    urls: [],
    urlCount: 0,
    license: undefined,
    warnings: [],
    warningCount: 0,
    collision: false,
    emptyBody: false,
    problem: undefined,
    ...over,
  } satisfies SkillImportCandidate
}

function importOf(origin: SkillImport['origin'], candidates: SkillImportCandidate[]): SkillImport {
  return { origin, root, candidates, rootLicense: undefined, tempDir: undefined }
}

/** A GitHub import of one skill folder, as `prepare` would leave it */
function githubImport(repo: string, dir: string, name = 'demo', rel = 'skills/demo'): SkillImport {
  return importOf({ kind: 'github', repo, ref: 'main', commit: 'abc123', path: 'skills' }, [
    candidateOf(dir, name, { rel }),
  ])
}

function importDir(name: string, extra: string): string {
  const dir = join(root, 'imports', name)
  skill(dir, name, 'A demo skill', extra)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-provenance-'))
  home = join(root, 'home')
  builtin = join(root, 'builtin')
  settingsPath = join(root, 'app-settings.json')
  skill(
    join(builtin, 'meeting-minutes'),
    'meeting-minutes',
    'Minutes',
    'metadata:\n  version: 3.0.0\n',
  )
  writeFileSync(
    join(builtin, 'builtin-skills.json'),
    JSON.stringify([{ name: 'meeting-minutes', agentOnly: false }]),
  )
  skill(join(home, '.claude', 'skills', 'claude-one'), 'claude-one', 'From Claude')
  service = createUserSkillsService({
    homeDir: () => home,
    builtinDir: () => builtin,
    settingsPath: () => settingsPath,
    tempDir: () => join(root, 'temp'),
    trash: vi.fn(async (path: string) => {
      rmSync(path, { recursive: true, force: true })
    }),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const viewOfId = async (id: string) => (await service.list()).find((view) => view.id === id)

describe('the record', () => {
  it('records a pasted skill as local with its version, and the preview shows it', async () => {
    const text =
      '---\nname: pasted\ndescription: A pasted skill\nmetadata:\n  version: 1.2.3\n---\nDo it.\n'
    const imported = await service.prepare({ kind: 'text', text })
    expect(importPreviewOf(imported, 'token').candidates[0]).toMatchObject({
      name: 'pasted',
      version: '1.2.3',
    })
    const done = await service.install(imported, { selected: ['pasted'], onCollision: {} })
    expect(done).toMatchObject({ ok: true, installed: [{ key: 'pasted', id: 'app:pasted' }] })
    expect(readSkillProvenance(settingsPath)).toEqual({
      'app:pasted': {
        source: 'local',
        version: '1.2.3',
        at: expect.any(String) as unknown as string,
      },
    })
  })

  it('records a GitHub install as community with its source URL', async () => {
    const dir = importDir('demo', 'metadata:\n  version: 0.4.0\n')
    const done = await service.install(githubImport('someone/skillz', dir), {
      selected: ['demo'],
      onCollision: {},
    })
    expect(done).toMatchObject({ ok: true })
    expect(readSkillProvenance(settingsPath)['app:demo']).toEqual({
      source: 'community',
      sourceUrl: 'https://github.com/someone/skillz/tree/abc123/skills/demo',
      version: '0.4.0',
      at: expect.any(String) as unknown as string,
    })
  })

  it('records the product repository as official', async () => {
    const dir = importDir('demo', '')
    await service.install(githubImport(PRODUCT_REPO_SLUG, dir), {
      selected: ['demo'],
      onCollision: {},
    })
    expect(readSkillProvenance(settingsPath)['app:demo']).toMatchObject({
      source: 'official',
      sourceUrl: `https://github.com/${PRODUCT_REPO_SLUG}/tree/abc123/skills/demo`,
    })
  })

  it('keeps the record and its source across a rename', async () => {
    const dir = importDir('demo', 'metadata:\n  version: 0.4.0\n')
    await service.install(githubImport('someone/skillz', dir), {
      selected: ['demo'],
      onCollision: {},
    })
    const saved = await service.save({
      id: 'app:demo',
      title: '',
      name: 'renamed',
      description: 'A demo skill',
      body: 'Do it.',
    })
    expect(saved).toEqual({ ok: true, id: 'app:renamed' })
    const ledger = readSkillProvenance(settingsPath)
    expect(ledger['app:demo']).toBeUndefined()
    expect(ledger['app:renamed']).toMatchObject({
      source: 'community',
      sourceUrl: 'https://github.com/someone/skillz/tree/abc123/skills/demo',
      version: '0.4.0',
    })
  })

  it('records a copy made here as local', async () => {
    const copied = await service.copyToMine('builtin:meeting-minutes', false)
    expect(copied).toEqual({ ok: true, id: 'app:meeting-minutes' })
    expect(readSkillProvenance(settingsPath)['app:meeting-minutes']).toMatchObject({
      source: 'local',
      version: '3.0.0',
    })
  })

  it('drops the record when the skill is removed', async () => {
    const dir = importDir('demo', '')
    await service.install(githubImport('someone/skillz', dir), {
      selected: ['demo'],
      onCollision: {},
    })
    expect(readSkillProvenance(settingsPath)['app:demo']).toBeDefined()
    expect(await service.remove('app:demo')).toEqual({ ok: true })
    expect(readSkillProvenance(settingsPath)['app:demo']).toBeUndefined()
  })
})

describe('the list', () => {
  it('shows provenance and version on builtin and own skills', async () => {
    const dir = importDir('demo', 'metadata:\n  version: 0.4.0\n')
    await service.install(githubImport('someone/skillz', dir), {
      selected: ['demo'],
      onCollision: {},
    })
    expect(await viewOfId('builtin:meeting-minutes')).toMatchObject({
      provenance: { source: 'builtin' },
      version: '3.0.0',
    })
    expect(await viewOfId('app:demo')).toMatchObject({
      provenance: {
        source: 'community',
        sourceUrl: 'https://github.com/someone/skillz/tree/abc123/skills/demo',
      },
      version: '0.4.0',
    })
  })

  it('derives provenance from the source record when nothing was recorded', async () => {
    skill(join(appDir(), 'gh-one'), 'gh-one', 'From GitHub')
    writeFileSync(
      join(appDir(), 'gh-one', '.ieum-source.json'),
      JSON.stringify({
        kind: 'github',
        repo: 'someone/skillz',
        ref: 'main',
        path: 'skills/gh-one',
        commit: 'c0ffee',
        installedAt: '2026-11-16T00:00:00Z',
        contentHash: 'x',
      }),
    )
    skill(join(appDir(), 'mine'), 'mine', 'My own', 'metadata:\n  version: 1.0.0\n')
    expect(await viewOfId('app:gh-one')).toMatchObject({
      provenance: {
        source: 'community',
        sourceUrl: 'https://github.com/someone/skillz/tree/c0ffee/skills/gh-one',
      },
    })
    expect(await viewOfId('app:mine')).toMatchObject({
      provenance: { source: 'local' },
      version: '1.0.0',
    })
  })

  it('leaves other programs’ skills without provenance or version', async () => {
    const view = await viewOfId('user:claude-one')
    expect(view?.provenance).toBeUndefined()
    expect(view?.version).toBeUndefined()
  })
})

describe('the app skills folder and the assistant', () => {
  it('feeds the assistant: listed, in the agent bundle, readable', async () => {
    skill(join(appDir(), 'mine'), 'mine', 'My own', '', 'Body\n')
    expect(await viewOfId('app:mine')).toMatchObject({ owned: true })
    const bundle = await service.enabledForAgent()
    expect(bundle.map((entry) => entry.id)).toContain('app:mine')
    expect(await service.aiRead('app:mine')).toMatchObject({
      ok: true,
      skill: { name: 'mine', body: 'Body\n' },
    })
  })

  it('feeds the assistant with a skill installed here too', async () => {
    const text = '---\nname: pasted\ndescription: A pasted skill\n---\nDo it.\n'
    await service.install(await service.prepare({ kind: 'text', text }), {
      selected: ['pasted'],
      onCollision: {},
    })
    const bundle = await service.enabledForAgent()
    const entry = bundle.find((one) => one.id === 'app:pasted')
    expect(entry).toMatchObject({ source: 'app', dir: join(appDir(), 'pasted') })
    expect(await service.aiRead('app:pasted')).toMatchObject({ ok: true })
  })
})

describe('skillVersionOf', () => {
  it('reads the version from the front matter, either place', () => {
    expect(skillVersionOf('---\nname: a\ndescription: b\nversion: 2.0.0\n---\n')).toBe('2.0.0')
    expect(skillVersionOf('---\nname: a\ndescription: b\nmetadata:\n  version: 1.2.3\n---\n')).toBe(
      '1.2.3',
    )
    expect(skillVersionOf('---\nname: a\ndescription: b\n---\n')).toBeUndefined()
    expect(skillVersionOf('no front matter')).toBeUndefined()
    expect(skillVersionOf(`---\nname: a\ndescription: b\nversion: ${'x'.repeat(200)}\n---\n`)).toBe(
      undefined,
    )
  })
})

describe('skillProvenanceFromSettings', () => {
  it('keeps the entries of the documented shape and drops anything else', () => {
    expect(skillProvenanceFromSettings({})).toEqual({})
    expect(skillProvenanceFromSettings({ skillProvenance: 'nonsense' })).toEqual({})
    expect(
      skillProvenanceFromSettings({
        skillProvenance: {
          'app:ok': { source: 'local', version: '1.0.0', at: '2026-11-16T00:00:00Z' },
          'app:bad-source': { source: 'shady', at: '' },
          'app:number': 5,
        },
      }),
    ).toEqual({ 'app:ok': { source: 'local', version: '1.0.0', at: '2026-11-16T00:00:00Z' } })
  })
})

describe('provenanceOfGitHub', () => {
  it('URL-encodes every segment of repo, commit and path', () => {
    const { source, sourceUrl } = provenanceOfGitHub(
      'someone/skill z',
      'abc 123',
      'skills/meeting notes/週次 レポート/notes#1',
    )
    expect(source).toBe('community')
    expect(sourceUrl).toBe(
      'https://github.com/someone/skill%20z/tree/abc%20123/' +
        'skills/meeting%20notes/%E9%80%B1%E6%AC%A1%20%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88/notes%231',
    )
    // an ordinary address keeps its readable shape
    expect(provenanceOfGitHub('someone/skillz', 'a'.repeat(40), 'skills/demo').sourceUrl).toBe(
      `https://github.com/someone/skillz/tree/${'a'.repeat(40)}/skills/demo`,
    )
  })
})
