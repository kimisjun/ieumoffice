import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillImport, SkillImportCandidate } from '@genoffice/ai-provider'
import { readSkillProvenance } from '../src/main/user-skills/skill-provenance'
import {
  createUserSkillsService,
  type UserSkillsService,
} from '../src/main/user-skills/user-skills-service'

/**
 * The install gate on the service (decision 0152): a candidate folder that
 * hides a hostile layout is refused as a whole before anything is written,
 * while the pipeline's own refusals keep their reasons and editing a skill
 * stays on its tolerant path.
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

function importDir(name: string): string {
  const dir = join(root, 'imports', name)
  skill(dir, name, 'A demo skill')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-gate-'))
  home = join(root, 'home')
  builtin = join(root, 'builtin')
  settingsPath = join(root, 'app-settings.json')
  skill(join(builtin, 'meeting-minutes'), 'meeting-minutes', 'Minutes')
  skill(join(builtin, 'evil'), 'evil', 'Carries a link out')
  writeFileSync(
    join(builtin, 'builtin-skills.json'),
    JSON.stringify([
      { name: 'meeting-minutes', agentOnly: false },
      { name: 'evil', agentOnly: false },
    ]),
  )
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

describe('the install gate', () => {
  it('refuses a candidate folder with a link leading out and installs nothing', async () => {
    const dir = importDir('demo')
    writeFileSync(join(root, 'outside.txt'), 'outside')
    symlinkSync(join(root, 'outside.txt'), join(dir, 'notes.md'))
    const done = await service.install(
      importOf({ kind: 'folder', folder: join(root, 'imports') }, [candidateOf(dir, 'demo')]),
      { selected: ['demo'], onCollision: {} },
    )
    expect(done).toEqual({ ok: false, reason: 'unsafe', problem: 'escaping-link' })
    expect(existsSync(join(appDir(), 'demo'))).toBe(false)
    expect((await service.list()).map((view) => view.id)).not.toContain('app:demo')
    expect(readSkillProvenance(settingsPath)['app:demo']).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a candidate folder with a hostile entry name',
    async () => {
      const dir = importDir('demo')
      writeFileSync(join(dir, 'evil\\..\\x.txt'), 'x')
      const done = await service.install(
        importOf({ kind: 'folder', folder: join(root, 'imports') }, [candidateOf(dir, 'demo')]),
        { selected: ['demo'], onCollision: {} },
      )
      expect(done).toEqual({ ok: false, reason: 'unsafe', problem: 'traversal' })
      expect(existsSync(join(appDir(), 'demo'))).toBe(false)
    },
  )

  it('refuses a candidate whose SKILL.md lacks the required front matter', async () => {
    const dir = join(root, 'imports', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\n---\nDo it.\n')
    const done = await service.install(
      importOf({ kind: 'folder', folder: join(root, 'imports') }, [candidateOf(dir, 'demo')]),
      { selected: ['demo'], onCollision: {} },
    )
    expect(done).toEqual({ ok: false, reason: 'not-installable', problem: 'bad-frontmatter' })
    expect(existsSync(join(appDir(), 'demo'))).toBe(false)
  })

  it('keeps the pipeline’s own refusals and their reasons', async () => {
    const dir = importDir('demo')
    const done = await service.install(
      importOf({ kind: 'folder', folder: join(root, 'imports') }, [
        candidateOf(dir, 'demo', { problem: 'no-frontmatter' }),
      ]),
      { selected: ['demo'], onCollision: {} },
    )
    expect(done).toMatchObject({ ok: false, reason: 'not-installable' })
    expect(existsSync(join(appDir(), 'demo'))).toBe(false)
  })

  it('still asks first when a name is taken and no choice was given', async () => {
    skill(join(appDir(), 'demo'), 'demo', 'Mine')
    const dir = importDir('demo')
    const done = await service.install(
      importOf({ kind: 'folder', folder: join(root, 'imports') }, [candidateOf(dir, 'demo')]),
      { selected: ['demo'], onCollision: {} },
    )
    expect(done).toMatchObject({ ok: false, reason: 'needs-choice' })
  })

  it('installs a candidate whose links stay inside the folder', async () => {
    const dir = importDir('demo')
    writeFileSync(join(dir, 'notes.md'), 'notes')
    symlinkSync(join(dir, 'notes.md'), join(dir, 'also.md'))
    const done = await service.install(
      importOf({ kind: 'folder', folder: join(root, 'imports') }, [candidateOf(dir, 'demo')]),
      { selected: ['demo'], onCollision: {} },
    )
    expect(done).toMatchObject({ ok: true, installed: [{ id: 'app:demo' }] })
    expect(existsSync(join(appDir(), 'demo', 'SKILL.md'))).toBe(true)
  })
})

describe('the tolerant paths stay open', () => {
  it('editing an own skill with tolerated front matter still saves', async () => {
    skill(
      join(appDir(), 'mine'),
      'mine',
      '"Quoted: description"',
      'metadata:\n  ieum-title: Mine\n  custom-key: kept as written\n',
    )
    const saved = await service.save({
      id: 'app:mine',
      title: 'Mine',
      description: 'My own',
      body: 'New body',
    })
    expect(saved).toEqual({ ok: true, id: 'app:mine' })
    expect(readSkillProvenance(settingsPath)['app:mine']).toMatchObject({ source: 'local' })
  })

  it('copying in a folder with a link leading out copies without that link', async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside')
    symlinkSync(join(root, 'outside.txt'), join(builtin, 'evil', 'notes.md'))
    const copied = await service.copyToMine('builtin:evil', false)
    expect(copied).toEqual({ ok: true, id: 'app:evil' })
    expect(existsSync(join(appDir(), 'evil', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(appDir(), 'evil', 'notes.md'))).toBe(false)
  })
})
