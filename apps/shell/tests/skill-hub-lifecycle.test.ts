import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSkillImportAddress } from '../src/renderer/src/skill-hub/skill-hub-model'
import {
  createUserSkillsService,
  importPreviewOf,
} from '../src/main/user-skills/user-skills-service'
import { readSkillProvenance } from '../src/main/user-skills/skill-provenance'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-hub-lifecycle-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function fixture(mutator?: (zip: JSZip) => void) {
  const zip = new JSZip()
  zip.file(
    'repo-commit/skills/demo/SKILL.md',
    '---\nname: demo\ndescription: A shared teaching skill\nversion: 1.2.3\n---\nRead references/guide.md before writing.\n',
  )
  zip.file('repo-commit/skills/demo/references/guide.md', 'Use the school evaluation criteria.\n')
  zip.file('repo-commit/skills/demo/scripts/install.sh', `touch '${join(root, 'never-executed')}'`)
  zip.file('repo-commit/other/private.txt', 'Outside the selected skill folder')
  mutator?.(zip)
  const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' })
  const requests: string[] = []
  const settings = join(root, 'app-settings.json')
  const home = join(root, 'home')
  const service = createUserSkillsService({
    homeDir: () => home,
    builtinDir: () => undefined,
    settingsPath: () => settings,
    tempDir: () => join(root, 'temp'),
    trash: async (path) => {
      rmSync(path, { recursive: true, force: true })
    },
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://api.github.com/repos/octocat/skills/commits/HEAD')
        return new Response('a'.repeat(40), { status: 200 })
      if (url === `https://codeload.github.com/octocat/skills/zip/${'a'.repeat(40)}`)
        return new Response(Buffer.from(bytes), { status: 200 })
      throw new Error(`Unexpected request: ${url}`)
    },
  })
  return { service, requests, settings, store: join(home, '.ieumoffice', 'skills') }
}

describe('the GitHub skill lifecycle through the app store', () => {
  it('fetches the requested folder, previews without installation, persists provenance and feeds the AI', async () => {
    const { service, requests, settings, store } = await fixture()
    const address = buildSkillImportAddress('octocat/skills', 'skills/demo')!
    const imported = await service.prepare({ kind: 'github', address })
    try {
      const preview = importPreviewOf(imported, 'token')
      expect(preview.candidates).toHaveLength(1)
      const candidate = preview.candidates[0]!
      expect(candidate).toMatchObject({
        name: 'demo',
        description: 'A shared teaching skill',
        version: '1.2.3',
      })
      expect(await service.readImported(imported, candidate.key)).toMatchObject({
        ok: true,
        content: { body: { text: 'Read references/guide.md before writing.\n' } },
      })
      expect(existsSync(join(store, 'demo'))).toBe(false)
      expect(
        await service.install(imported, { selected: [candidate.key], onCollision: {} }),
      ).toMatchObject({ ok: true, installed: [{ id: 'app:demo' }] })
      expect(readFileSync(join(store, 'demo', 'references', 'guide.md'), 'utf8')).toContain(
        'school evaluation',
      )
      expect(existsSync(join(store, 'demo', 'other'))).toBe(false)
      expect(existsSync(join(root, 'never-executed'))).toBe(false)
      expect(readSkillProvenance(settings)['app:demo']).toMatchObject({
        source: 'community',
        version: '1.2.3',
        sourceUrl: `https://github.com/octocat/skills/tree/${'a'.repeat(40)}/skills/demo`,
      })
      expect((await service.list()).find((view) => view.id === 'app:demo')).toMatchObject({
        enabled: true,
        version: '1.2.3',
      })
      expect(await service.aiRead('app:demo')).toMatchObject({ ok: true })
      expect(await service.setState('app:demo', { enabled: false })).toMatchObject({ ok: true })
      expect(await service.aiRead('app:demo')).toMatchObject({ ok: false })
      expect(await service.remove('app:demo')).toEqual({ ok: true })
      expect(existsSync(join(store, 'demo'))).toBe(false)
      expect(readSkillProvenance(settings)['app:demo']).toBeUndefined()
      expect(requests).toHaveLength(2)
    } finally {
      await service.dispose(imported)
    }
    expect(existsSync(imported.root)).toBe(false)
  })

  it.each(['traversal', 'absolute', 'symlink'] as const)(
    'rejects a GitHub archive carrying %s entries before installation',
    async (kind) => {
      const { service, store } = await fixture((zip) => {
        if (kind === 'symlink')
          zip.file('repo-commit/skills/demo/link', '/outside', { unixPermissions: 0o120777 })
        else
          zip.file(
            kind === 'absolute' ? '/outside.txt' : 'repo-commit/skills/demo/../../escape.txt',
            'outside',
          )
      })
      await expect(
        service.prepare({
          kind: 'github',
          address: buildSkillImportAddress('octocat/skills', 'skills/demo')!,
        }),
      ).rejects.toMatchObject({ kind: 'unsafe' })
      expect(existsSync(join(store, 'demo'))).toBe(false)
    },
  )
})
