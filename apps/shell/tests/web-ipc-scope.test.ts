import { describe, expect, it } from 'vitest'
import { channelAllowedForApp } from '../src/web/ipc-scope'

describe('web bridge IPC scope (QA 1차 P0-C)', () => {
  it('denies account/subscription channels to every app (canary)', () => {
    // runs a vendor CLI login/logout — no editor preload ever exposed it
    expect(channelAllowedForApp('docs', 'ai:subscription-logout')).toBe(false)
    expect(channelAllowedForApp('docs', 'ai:subscription-install')).toBe(false)
    expect(channelAllowedForApp('diagram', 'ai:subscription-login')).toBe(false)
    expect(channelAllowedForApp('hwp', 'ai:subscription-statuses')).toBe(false)
  })

  it('denies desktop shell systems to document tabs', () => {
    expect(channelAllowedForApp('docs', 'mcp-servers:add')).toBe(false)
    expect(channelAllowedForApp('docs', 'skills:install')).toBe(false)
    expect(channelAllowedForApp('markdown', 'drive:upload')).toBe(false)
    expect(channelAllowedForApp('diagram', 'agent-window:open')).toBe(false)
    expect(channelAllowedForApp('sheets', 'tabs:close')).toBe(false)
    expect(channelAllowedForApp('epub', 'generate:run')).toBe(false)
    expect(channelAllowedForApp('mindmap', 'internet-tools:fetch')).toBe(false)
  })

  it("denies another app's namespace", () => {
    expect(channelAllowedForApp('markdown', 'docs:read-file')).toBe(false)
    expect(channelAllowedForApp('hwp', 'diagram:open')).toBe(false)
  })

  it('allows editor AI panel reads but not account lifecycle', () => {
    expect(channelAllowedForApp('sheets', 'ai:get-settings')).toBe(true)
    expect(channelAllowedForApp('slides', 'ai:tool-capabilities')).toBe(true)
    expect(channelAllowedForApp('docs', 'user:display-name')).toBe(true)
    // the denial overrides the allowance
    expect(channelAllowedForApp('docs', 'ai:subscription-logout')).toBe(false)
    expect(channelAllowedForApp('docs', 'ai:subscription-install')).toBe(false)
  })

  it('allows the app namespace and the shared core', () => {
    expect(channelAllowedForApp('markdown', 'markdown:save')).toBe(true)
    expect(channelAllowedForApp('hwp', 'hwp:read-file')).toBe(true)
    expect(channelAllowedForApp('html', 'gx:render')).toBe(true)
    expect(channelAllowedForApp('docs', 'node:fs:read')).toBe(true)
    expect(channelAllowedForApp('sheets', 'app:relaunch')).toBe(true)
    expect(channelAllowedForApp('diagram', 'web:dialog')).toBe(true)
    expect(channelAllowedForApp('epub', 'menu:action')).toBe(true)
    expect(channelAllowedForApp('pdf', 'win:new')).toBe(true)
    expect(channelAllowedForApp('slides', 'project:list')).toBe(true)
    expect(channelAllowedForApp('mindmap', 'mindmap:save')).toBe(true)
  })

  it('denies unknown channels by default', () => {
    expect(channelAllowedForApp('docs', 'evil:channel')).toBe(false)
    expect(channelAllowedForApp('docs', '')).toBe(false)
  })
})
