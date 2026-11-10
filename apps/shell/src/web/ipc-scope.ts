/**
 * Web-bridge IPC scope (QA 1차 P0-C).
 *
 * The desktop surface trusts its renderer: every app's preload exposes the
 * channels that app needs and nothing else. The web bridge instead mirrored
 * EVERY registered ipcMain channel to every tab, so a document frame could
 * reach account/subscription paths (`ai:subscription-logout` runs a vendor
 * CLI!) that no editor preload ever exposed. This module is the per-app
 * allowlist the bridge enforces: deny by default, own namespace plus a shared
 * core, with account/system surfaces named as denials that override any
 * allowance. Canary: `channelAllowedForApp('docs', 'ai:subscription-logout')`
 * is false (tests/web-ipc-scope.test.ts).
 */

/** channel namespaces each web app may reach beyond the shared core */
const OWN_PREFIXES: Record<string, string[]> = {
  docs: ['docs:'],
  sheets: ['sheets:', 'workbook:', 'paste-special:', 'chart-layout:', 'outline-'],
  slides: ['slides:'],
  pdf: ['pdf:', 'pdf-tools:'],
  markdown: ['markdown:'],
  html: ['html:', 'gx:'],
  hwp: ['hwp:', 'ieum-image:'],
  mindmap: ['mindmap:', 'og:'],
  epub: ['epub:'],
  diagram: ['diagram:'],
}

/** channels every editor legitimately uses (app lifecycle, node file bridge,
 *  project folders, the start screen's file open, shared genoffice helpers) */
const SHARED_PREFIXES = [
  'app:',
  'ai:', // editor AI panels (settings/summarise/proofread); account and
         // subscription lifecycle stay denied below and override this
  'user:', // display identity chips (user:display-name)
  'node:',
  'project:',
  'home:',
  'files:',
  'genoffice:',
  'zotero:', // docs' citation integration reads local bibliographies
  'win:', // the shim's window helpers (win:new/list/focus)
  'web:', // the dialog overlay's own backing channels (web:dialog)
  'menu:', // the file-menu action channel (menu:action)
]

/** denials override every allowance. Account/subscription lifecycle runs
 *  vendor CLIs (login/logout/install/update); the rest are desktop shell
 *  systems a browser tab has no business driving. */
const DENIED_PREFIXES = [
  'ai:subscription',
  'ai:account',
  'ai:login',
  'ai:logout',
  'ai:install',
  'drive:',
  'mcp-servers:',
  'skills:',
  'kb:',
  'agent-window:',
  'quick-look:',
  'generate:',
  'tabs:',
  'internet-tools',
]

export function channelAllowedForApp(app: string, channel: string): boolean {
  for (const denied of DENIED_PREFIXES) {
    if (channel.startsWith(denied)) return false
  }
  for (const prefix of SHARED_PREFIXES) {
    if (channel.startsWith(prefix)) return true
  }
  for (const prefix of OWN_PREFIXES[app] ?? []) {
    if (channel.startsWith(prefix)) return true
  }
  return false
}
