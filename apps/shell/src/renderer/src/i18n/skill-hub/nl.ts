import type { zh } from './zh'

export const nl = {
  name: 'Ieum-bos',
  tabGet: 'Ophalen',
  tabMine: 'Mijn vaardigheden',
  tabShare: 'Delen',
  shareComingSoon: 'Binnenkort',
  getIntro:
    'Zoek vaardigheden op GitHub en voeg ze toe. Toegevoegde vaardigheden kan de AI gebruiken.',
  repoLabel: 'GitHub-repository',
  repoPlaceholder: 'owner/repo',
  pathLabel: 'Mappad (optioneel)',
  pathPlaceholder: 'skills/example',
  find: 'Zoeken',
  finding: 'Ophalen van GitHub…',
  previewAction: 'Voorbeeld',
  installAction: 'Installeren',
  installedAction: 'Geïnstalleerd',
  labelName: 'Naam',
  labelVersion: 'Versie',
  labelBody: 'Inhoud',
  versionBadge: 'Versie {version}',
  mineEmpty: 'Er zijn nog geen vaardigheden geïnstalleerd.',
  provBuiltin: 'Ingebouwd',
  provOfficial: 'Officieel',
  provCommunity: 'Community',
  provLocal: 'Deze computer',
} satisfies Record<keyof typeof zh, string>
