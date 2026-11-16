import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createContext, disposeContext } from '../src/mcp/run'
import { createMcpServer } from '../src/mcp/server'
import { run, tempDir } from './helpers'

// Follow-along (issue #558): the skills the person applied (enabled) in the
// app are exposed as ieumoffice://skills (name and description only) and
// ieumoffice://skills/<name> (one SKILL.md), and `skill export` writes an
// applied skill as a standard skill folder. What the person left off is never
// exposed.

const TEAM_SKILL_MD = [
  '---',
  'name: team-docs',
  'description: Turn rough notes into a shared team document.',
  'metadata:',
  '  ieum-title: Team document',
  '---',
  '',
  '# Team document',
  '',
  'Follow these steps to shape a team document.',
  '',
].join('\n')

const GRADE_SKILL_MD = [
  '---',
  'name: grade-review',
  'description: Review student records before submission.',
  '---',
  '',
  'Check each record against the checklist.',
  '',
].join('\n')

const OFF_SKILL_MD = [
  '---',
  'name: off-skill',
  'description: A skill the person turned off.',
  '---',
  '',
  'This body must never leave the machine.',
  '',
].join('\n')

interface Fixture {
  home: string
  userData: string
  env: NodeJS.ProcessEnv
}

/** A home with two applied skills (one with a supporting file and a GitHub source record) and one turned off */
function fixture(): Fixture {
  const home = tempDir()
  const userData = tempDir()
  const team = join(home, '.ieumoffice', 'skills', 'team-docs')
  mkdirSync(join(team, 'references'), { recursive: true })
  writeFileSync(join(team, 'SKILL.md'), TEAM_SKILL_MD)
  writeFileSync(join(team, 'references', 'style.md'), '# Style\n')
  writeFileSync(join(team, '.ieum-source.json'), '{"repo":"a/b"}')
  const grade = join(home, '.ieumoffice', 'skills', 'grade-review')
  mkdirSync(grade, { recursive: true })
  writeFileSync(join(grade, 'SKILL.md'), GRADE_SKILL_MD)
  const off = join(home, '.ieumoffice', 'skills', 'off-skill')
  mkdirSync(off, { recursive: true })
  writeFileSync(join(off, 'SKILL.md'), OFF_SKILL_MD)
  writeFileSync(
    join(userData, 'app-settings.json'),
    JSON.stringify({ skills: { states: { 'app:off-skill': { enabled: false } } } }),
  )
  return {
    home,
    userData,
    env: {
      ...process.env,
      GENOFFICE_HOME: home,
      GENOFFICE_USER_DATA: userData,
      GENOFFICE_AUDIT_LOG: 'off',
    },
  }
}

/** A connected MCP client on the in-memory transport, disposed after the test body */
async function withClient(
  env: NodeJS.ProcessEnv,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const ctx = createContext({ cwd: tempDir(), env, log: () => {} })
  try {
    const server = await createMcpServer(ctx)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'skills-test', version: '0' })
    await client.connect(b)
    await body(client)
    await client.close()
  } finally {
    disposeContext(ctx)
  }
}

function textOf(contents: unknown): string {
  return (contents as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
}

describe('ieumoffice://skills resources (follow-along)', () => {
  it('lists name and description only, and only what is applied', async () => {
    const { env } = fixture()
    await withClient(env, async (client) => {
      const { resources } = await client.listResources()
      const uris = resources.map((r) => r.uri)
      expect(uris).toContain('ieumoffice://skills')
      expect(uris).toContain('ieumoffice://skills/team-docs')
      expect(uris).toContain('ieumoffice://skills/grade-review')
      expect(uris).not.toContain('ieumoffice://skills/off-skill')

      const listed = await client.readResource({ uri: 'ieumoffice://skills' })
      const text = textOf(listed.contents)
      // progressive disclosure: name and description, never a body
      expect(text).toContain('team-docs: Turn rough notes into a shared team document.')
      expect(text).toContain('grade-review: Review student records before submission.')
      expect(text).not.toContain('Follow these steps')
      expect(text).not.toContain('Check each record against')
      expect(text).not.toContain('This body must never leave')
      expect(text).not.toContain('off-skill')
    })
  })

  it('reads one applied skill as its SKILL.md', async () => {
    const { env } = fixture()
    await withClient(env, async (client) => {
      const read = await client.readResource({ uri: 'ieumoffice://skills/team-docs' })
      expect(textOf(read.contents)).toBe(TEAM_SKILL_MD)
    })
  })

  it('errors on an unknown skill name, naming the applied ones', async () => {
    const { env } = fixture()
    await withClient(env, async (client) => {
      await expect(
        client.readResource({ uri: 'ieumoffice://skills/no-such-skill' }),
      ).rejects.toThrow(/unknown skill: no-such-skill/)
      await expect(
        client.readResource({ uri: 'ieumoffice://skills/no-such-skill' }),
      ).rejects.toThrow(/team-docs/)
    })
  })
})

describe('skill export', () => {
  it('writes an applied skill as a standard skill folder', async () => {
    const { env } = fixture()
    const out = join(tempDir(), 'publish')
    const r = await run(['skill', 'export', 'team-docs', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    // the folder is the skill folder itself: SKILL.md and the supporting files
    expect(readFileSync(join(out, 'SKILL.md'), 'utf8')).toBe(TEAM_SKILL_MD)
    expect(readFileSync(join(out, 'references', 'style.md'), 'utf8')).toBe('# Style\n')
    // the app's GitHub source record is bookkeeping, not part of the standard
    expect(existsSync(join(out, '.ieum-source.json'))).toBe(false)
    expect(r.json().detail).toMatchObject({ name: 'team-docs', files: 2 })
  })

  it('refuses a non-empty output folder', async () => {
    const { env } = fixture()
    const out = tempDir()
    writeFileSync(join(out, 'keep.txt'), 'mine')
    const r = await run(['skill', 'export', 'team-docs', '--out', out, '--json'], { env })
    expect(r.code).toBe(2)
    expect(r.json()).toMatchObject({ error: 'output_exists' })
    // nothing was written over what was there
    expect(readFileSync(join(out, 'keep.txt'), 'utf8')).toBe('mine')
    expect(existsSync(join(out, 'SKILL.md'))).toBe(false)
  })

  it('errors on a skill that is not applied', async () => {
    const { env } = fixture()
    const out = join(tempDir(), 'publish')
    const r = await run(['skill', 'export', 'no-such-skill', '--out', out, '--json'], { env })
    expect(r.code).toBe(1)
    const json = r.json()
    expect(json.error).toBe('invalid_argument')
    expect(json.detail.supported).toContain('team-docs')
    expect(existsSync(out)).toBe(false)
  })
})
