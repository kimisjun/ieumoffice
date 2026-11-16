import type { zh } from './zh'

export const pt = {
  name: 'Floresta Ieum',
  tabGet: 'Obter',
  tabMine: 'Minhas habilidades',
  tabShare: 'Partilhar',
  shareComingSoon: 'Em breve',
  getIntro:
    'Encontre habilidades no GitHub e adicione-as. As habilidades adicionadas podem ser usadas pela IA.',
  repoLabel: 'Repositório do GitHub',
  repoPlaceholder: 'owner/repo',
  pathLabel: 'Caminho da pasta (opcional)',
  pathPlaceholder: 'skills/example',
  find: 'Procurar',
  finding: 'A obter do GitHub…',
  previewAction: 'Pré-visualização',
  installAction: 'Instalar',
  installedAction: 'Instalado',
  labelName: 'Nome',
  labelVersion: 'Versão',
  labelBody: 'Corpo',
  versionBadge: 'Versão {version}',
  mineEmpty: 'Ainda não há habilidades instaladas.',
  provBuiltin: 'Incluída',
  provOfficial: 'Oficial',
  provCommunity: 'Comunidade',
  provLocal: 'Este computador',
} satisfies Record<keyof typeof zh, string>
