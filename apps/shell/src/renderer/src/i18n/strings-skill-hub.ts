import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './skill-hub/zh'
import { en } from './skill-hub/en'
import { ja } from './skill-hub/ja'
import { ko } from './skill-hub/ko'
import { fr } from './skill-hub/fr'
import { de } from './skill-hub/de'
import { es } from './skill-hub/es'
import { th } from './skill-hub/th'
import { id } from './skill-hub/id'
import { ru } from './skill-hub/ru'
import { ar } from './skill-hub/ar'
import { pt } from './skill-hub/pt'
import { it } from './skill-hub/it'
import { pl } from './skill-hub/pl'
import { cs } from './skill-hub/cs'
import { nl } from './skill-hub/nl'
import { ms } from './skill-hub/ms'
import { he } from './skill-hub/he'
import { hi } from './skill-hub/hi'
import { zhTW } from './skill-hub/zh-TW'
import { vi } from './skill-hub/vi'
import { tr } from './skill-hub/tr'

/**
 * The skills forest (Ieum Forest) home page: its name, three tabs and the two
 * lists. Sharded per language; `zh` defines the key set. Shared words (cancel,
 * install, failure sentences, safety warnings) come from the settings skills
 * dictionary instead of being written again here.
 */
export const skillHubUiStrings = defineStrings({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
  vi,
  tr,
})

export type SkillHubStringKey = keyof typeof zh

const translate = createI18n(skillHubUiStrings)

export function skillHubText(lang: Lang, key: SkillHubStringKey, params?: Params): string {
  return translate(lang, key, params)
}
