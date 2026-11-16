/**
 * The skills forest's screen words in all 22 languages (`LANGS`): the key set
 * one language defines, every fragment filled, the Korean branded name as it
 * is (이음숲), and translations that are not the English words copied over.
 * A translation that is genuinely the same word in that language is listed.
 */
import { describe, expect, it } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import { zh } from '../src/renderer/src/i18n/skill-hub/zh'
import { en } from '../src/renderer/src/i18n/skill-hub/en'
import { ko } from '../src/renderer/src/i18n/skill-hub/ko'

const FRAGMENTS: Record<Lang, Record<string, string>> = {
  zh,
  en,
  ja: (await import('../src/renderer/src/i18n/skill-hub/ja')).ja,
  ko,
  fr: (await import('../src/renderer/src/i18n/skill-hub/fr')).fr,
  de: (await import('../src/renderer/src/i18n/skill-hub/de')).de,
  es: (await import('../src/renderer/src/i18n/skill-hub/es')).es,
  th: (await import('../src/renderer/src/i18n/skill-hub/th')).th,
  id: (await import('../src/renderer/src/i18n/skill-hub/id')).id,
  ru: (await import('../src/renderer/src/i18n/skill-hub/ru')).ru,
  ar: (await import('../src/renderer/src/i18n/skill-hub/ar')).ar,
  pt: (await import('../src/renderer/src/i18n/skill-hub/pt')).pt,
  it: (await import('../src/renderer/src/i18n/skill-hub/it')).it,
  pl: (await import('../src/renderer/src/i18n/skill-hub/pl')).pl,
  cs: (await import('../src/renderer/src/i18n/skill-hub/cs')).cs,
  nl: (await import('../src/renderer/src/i18n/skill-hub/nl')).nl,
  ms: (await import('../src/renderer/src/i18n/skill-hub/ms')).ms,
  he: (await import('../src/renderer/src/i18n/skill-hub/he')).he,
  hi: (await import('../src/renderer/src/i18n/skill-hub/hi')).hi,
  'zh-TW': (await import('../src/renderer/src/i18n/skill-hub/zh-TW')).zhTW,
  vi: (await import('../src/renderer/src/i18n/skill-hub/vi')).vi,
  tr: (await import('../src/renderer/src/i18n/skill-hub/tr')).tr,
}

/**
 * Where a translation is genuinely the same word as the English one, by
 * language and key. The two field placeholders are format literals (`owner/
 * repo`, `skills/example`) and the same in every language by design.
 */
const SAME_AS_ENGLISH: ReadonlyArray<readonly [Lang, string]> = [
  ...LANGS.map((lang) => [lang, 'repoPlaceholder'] as const),
  ...LANGS.map((lang) => [lang, 'pathPlaceholder'] as const),
  ['de', 'labelName'],
  ['de', 'labelVersion'],
  ['de', 'versionBadge'],
  ['de', 'provCommunity'],
  ['fr', 'labelVersion'],
  ['fr', 'versionBadge'],
  ['it', 'provCommunity'],
  ['nl', 'provCommunity'],
]

const KEY_COUNT = Object.keys(zh).length
const enDict: Record<string, string> = en

describe('the skills forest strings', () => {
  it('covers every language of LANGS, no more and no less', () => {
    expect(Object.keys(FRAGMENTS).sort()).toEqual([...LANGS].sort())
  })

  it('has every key filled in every language', () => {
    for (const lang of LANGS) {
      const dict = FRAGMENTS[lang]
      expect(Object.keys(dict).sort(), `${lang} keys`).toEqual(Object.keys(zh).sort())
      for (const key of Object.keys(zh)) {
        expect(dict[key]?.trim(), `${lang} ${key}`).toBeTruthy()
      }
    }
  })

  it('keeps the Korean branded name as 이음숲 and every tab name Korean', () => {
    expect(ko.name).toBe('이음숲')
    expect(ko.tabGet).toBe('받기')
    expect(ko.tabMine).toBe('내 스킬')
    expect(ko.tabShare).toBe('공유')
    expect(ko.shareComingSoon).toBe('준비 중')
  })

  it('translates every string instead of copying the English words', () => {
    const allowed = new Set(SAME_AS_ENGLISH.map(([lang, key]) => `${lang}\u0000${key}`))
    for (const lang of LANGS) {
      if (lang === 'en') continue
      for (const key of Object.keys(zh)) {
        if (allowed.has(`${lang}\u0000${key}`)) continue
        expect(FRAGMENTS[lang][key], `${lang} ${key} copies the English`).not.toBe(enDict[key])
      }
    }
  })

  it('lists exactly the languages where a word is genuinely the same as English', () => {
    const seen: string[] = []
    for (const lang of LANGS) {
      if (lang === 'en') continue
      for (const key of Object.keys(zh)) {
        if (FRAGMENTS[lang][key] === enDict[key]) seen.push(`${lang}\u0000${key}`)
      }
    }
    expect(seen.sort()).toEqual(
      SAME_AS_ENGLISH.filter(([lang]) => lang !== 'en')
        .map(([lang, key]) => `${lang}\u0000${key}`)
        .sort(),
    )
  })

  it('holds a meaningful number of strings', () => {
    expect(KEY_COUNT).toBeGreaterThanOrEqual(20)
  })
})
