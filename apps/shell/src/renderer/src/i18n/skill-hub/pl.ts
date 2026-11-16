import type { zh } from './zh'

export const pl = {
  name: 'Las Ieum',
  tabGet: 'Pobierz',
  tabMine: 'Moje umiejętności',
  tabShare: 'Udostępnianie',
  shareComingSoon: 'Wkrótce',
  getIntro:
    'Znajdź umiejętności na GitHubie i dodaj je. Dodane umiejętności może wykorzystywać AI.',
  repoLabel: 'Repozytorium GitHub',
  repoPlaceholder: 'owner/repo',
  pathLabel: 'Ścieżka folderu (opcjonalna)',
  pathPlaceholder: 'skills/example',
  find: 'Znajdź',
  finding: 'Pobieranie z GitHuba…',
  previewAction: 'Podgląd',
  installAction: 'Zainstaluj',
  installedAction: 'Zainstalowano',
  labelName: 'Nazwa',
  labelVersion: 'Wersja',
  labelBody: 'Treść',
  versionBadge: 'Wersja {version}',
  mineEmpty: 'Nie zainstalowano jeszcze żadnych umiejętności.',
  provBuiltin: 'Wbudowana',
  provOfficial: 'Oficjalna',
  provCommunity: 'Społeczność',
  provLocal: 'Ten komputer',
} satisfies Record<keyof typeof zh, string>
