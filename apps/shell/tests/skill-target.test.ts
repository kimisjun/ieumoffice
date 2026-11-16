import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkSkillInstallDir, isInstallableSkillDir } from '../src/main/skill-target'

describe('isInstallableSkillDir', () => {
  const vouched = ['/home/me/.claude/skills', '/home/me/.codex/skills', '/Volumes/work/skills']

  it('accepts a directory the user picked in the folder dialog', () => {
    expect(isInstallableSkillDir('/home/me/.claude/skills', vouched)).toBe(true)
    expect(isInstallableSkillDir('/Volumes/work/skills', vouched)).toBe(true)
  })

  it('accepts a vouched directory spelled differently', () => {
    expect(isInstallableSkillDir('/home/me/.codex/skills/../skills', vouched)).toBe(true)
    expect(isInstallableSkillDir('/home/me/.codex//skills', vouched)).toBe(true)
  })

  it('rejects a directory the main process never vouched for', () => {
    expect(isInstallableSkillDir('/etc/cron.d', vouched)).toBe(false)
    expect(isInstallableSkillDir('/Users/me/.ssh', vouched)).toBe(false)
    expect(isInstallableSkillDir('/home/me/.claude/skills-extra', vouched)).toBe(false)
    expect(isInstallableSkillDir('/home/me/.claude/skills/ieumoffice', vouched)).toBe(false)
  })

  it('tolerates malformed input defensively', () => {
    expect(isInstallableSkillDir('', vouched)).toBe(false)
    expect(isInstallableSkillDir('relative/dir', vouched)).toBe(false)
    expect(isInstallableSkillDir(undefined, vouched)).toBe(false)
    expect(isInstallableSkillDir('/etc/cron.d', [])).toBe(false)
  })
})

describe('checkSkillInstallDir', () => {
  let root: string

  const FRONT = 'name: demo\ndescription: A demo skill\n'

  function skillDir(name: string, front = FRONT, body = 'Do it.\n'): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\n${front}---\n${body}`)
    return dir
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-target-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts a plain skill folder and reads its name and version', async () => {
    const dir = skillDir(
      'demo',
      'name: demo\ndescription: A demo skill\nmetadata:\n  version: 1.2.3\n',
    )
    writeFileSync(join(dir, 'notes.md'), 'notes')
    expect(await checkSkillInstallDir(dir)).toEqual({ ok: true, name: 'demo', version: '1.2.3' })
  })

  it('reads a top-level version too, and none when the file names none', async () => {
    const versioned = skillDir(
      'versioned',
      'name: demo\ndescription: A demo skill\nversion: 2.0.0\n',
    )
    expect(await checkSkillInstallDir(versioned)).toEqual({
      ok: true,
      name: 'demo',
      version: '2.0.0',
    })
    expect(await checkSkillInstallDir(skillDir('plain'))).toEqual({
      ok: true,
      name: 'demo',
      version: undefined,
    })
  })

  it('accepts a link that stays inside the folder', async () => {
    const dir = skillDir('inside')
    writeFileSync(join(dir, 'notes.md'), 'notes')
    symlinkSync(join(dir, 'notes.md'), join(dir, 'also.md'))
    expect(await checkSkillInstallDir(dir)).toMatchObject({ ok: true, name: 'demo' })
  })

  it('refuses a link that leads out of the folder', async () => {
    const dir = skillDir('escaping')
    writeFileSync(join(root, 'outside.txt'), 'outside')
    symlinkSync(join(root, 'outside.txt'), join(dir, 'notes.md'))
    expect(await checkSkillInstallDir(dir)).toEqual({ ok: false, reason: 'escaping-link' })
  })

  it('refuses a link that resolves to nothing', async () => {
    const dir = skillDir('broken')
    symlinkSync(join(root, 'nowhere.txt'), join(dir, 'notes.md'))
    expect(await checkSkillInstallDir(dir)).toEqual({ ok: false, reason: 'escaping-link' })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an entry name with a separator or a drive form in it',
    async () => {
      const traversal = skillDir('traversal')
      writeFileSync(join(traversal, 'evil\\..\\x.txt'), 'x')
      expect(await checkSkillInstallDir(traversal)).toEqual({ ok: false, reason: 'traversal' })
      const absolute = skillDir('absolute')
      writeFileSync(join(absolute, 'C:weird.txt'), 'x')
      expect(await checkSkillInstallDir(absolute)).toEqual({ ok: false, reason: 'absolute' })
    },
  )

  it('refuses a folder over the file count or byte limit', async () => {
    const dir = skillDir('big')
    writeFileSync(join(dir, 'a.md'), 'aaaa')
    writeFileSync(join(dir, 'b.md'), 'bbbb')
    expect(await checkSkillInstallDir(dir, { files: 2, bytes: 1_000_000 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
    expect(await checkSkillInstallDir(dir, { files: 100, bytes: 10 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
    expect(await checkSkillInstallDir(dir, { files: 10, bytes: 1_000_000 })).toMatchObject({
      ok: true,
    })
  })

  it('refuses a SKILL.md without the required front matter', async () => {
    expect(await checkSkillInstallDir(skillDir('no-description', 'name: demo\n'))).toEqual({
      ok: false,
      reason: 'bad-frontmatter',
    })
    expect(await checkSkillInstallDir(skillDir('no-name', 'description: A demo skill\n'))).toEqual({
      ok: false,
      reason: 'bad-frontmatter',
    })
    expect(await checkSkillInstallDir(skillDir('no-front', '', 'Just text.\n'))).toEqual({
      ok: false,
      reason: 'bad-frontmatter',
    })
    const noFile = join(root, 'no-file')
    mkdirSync(noFile)
    expect(await checkSkillInstallDir(noFile)).toEqual({ ok: false, reason: 'bad-frontmatter' })
  })

  it.each([
    'name: demo\ndescription: [unterminated\n',
    'name: demo\ndescription: X\nother: [unterminated\n',
    'name: demo\nname: other\ndescription: X\n',
    'name: demo\ndescription: {nested: value}\n',
    'name: demo\ndescription: !custom value\n',
    'name: demo\ndescription: "valid" trailing garbage\n',
  ])('refuses malformed or non-scalar front matter: %s', async (front) => {
    expect(await checkSkillInstallDir(skillDir('malformed', front))).toEqual({
      ok: false,
      reason: 'bad-frontmatter',
    })
  })

  it('accepts quoted and folded YAML scalars without executing body content', async () => {
    const dir = skillDir(
      'folded',
      'name: "demo"\ndescription: >-\n  A demo skill\nversion: 1.2.3\n',
      '$(touch never-run)\n',
    )
    expect(await checkSkillInstallDir(dir)).toEqual({ ok: true, name: 'demo', version: '1.2.3' })
  })

  it('bounds front matter and empty directory depth as well as file bytes', async () => {
    expect(
      await checkSkillInstallDir(
        skillDir('long-front', `name: demo\ndescription: ${'x'.repeat(70_000)}\n`),
      ),
    ).toEqual({ ok: false, reason: 'bad-frontmatter' })
    const dir = skillDir('deep')
    mkdirSync(join(dir, ...Array.from({ length: 66 }, () => 'd')), { recursive: true })
    expect(await checkSkillInstallDir(dir)).toEqual({ ok: false, reason: 'too-large' })
  })

  it('refuses a name the app does not read and a reserved one', async () => {
    expect(
      await checkSkillInstallDir(skillDir('spaced', 'name: bad name\ndescription: X\n')),
    ).toEqual({
      ok: false,
      reason: 'bad-name',
    })
    expect(
      await checkSkillInstallDir(skillDir('reserved', 'name: genoffice\ndescription: X\n')),
    ).toEqual({ ok: false, reason: 'bad-name' })
  })

  it('refuses a folder that is not absolute or not there', async () => {
    expect(await checkSkillInstallDir('relative/dir')).toEqual({ ok: false, reason: 'absolute' })
    expect(await checkSkillInstallDir('')).toEqual({ ok: false, reason: 'unreadable' })
    expect(await checkSkillInstallDir(undefined)).toEqual({ ok: false, reason: 'unreadable' })
    expect(await checkSkillInstallDir(join(root, 'missing'))).toEqual({
      ok: false,
      reason: 'unreadable',
    })
    expect(await checkSkillInstallDir(root)).toEqual({ ok: false, reason: 'bad-frontmatter' })
  })
})
