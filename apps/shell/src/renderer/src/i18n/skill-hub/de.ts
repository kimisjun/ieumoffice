import type { zh } from './zh'

export const de = {
  name: 'Ieum-Wald',
  tabGet: 'Holen',
  tabMine: 'Meine Fähigkeiten',
  tabShare: 'Teilen',
  shareComingSoon: 'Bald verfügbar',
  getIntro:
    'Fähigkeiten auf GitHub finden und hinzufügen. Hinzugefügte Fähigkeiten kann die KI verwenden.',
  repoLabel: 'GitHub-Repository',
  repoPlaceholder: 'owner/repo',
  pathLabel: 'Ordnerpfad (optional)',
  pathPlaceholder: 'skills/example',
  find: 'Suchen',
  finding: 'Wird von GitHub geholt…',
  previewAction: 'Vorschau',
  installAction: 'Installieren',
  installedAction: 'Installiert',
  labelName: 'Name',
  labelVersion: 'Version',
  labelBody: 'Inhalt',
  versionBadge: 'Version {version}',
  mineEmpty: 'Es sind noch keine Fähigkeiten installiert.',
  provBuiltin: 'Eingebaut',
  provOfficial: 'Offiziell',
  provCommunity: 'Community',
  provLocal: 'Dieser PC',
} satisfies Record<keyof typeof zh, string>
