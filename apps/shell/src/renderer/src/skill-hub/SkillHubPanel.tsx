import { useCallback, useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { UserSkillsBridge } from '@genoffice/electron-utils/user-skills-bridge'
import type {
  UserSkillCollisionChoice,
  UserSkillImportCandidateView,
  UserSkillImportContent,
  UserSkillImportPreview,
  UserSkillView,
} from '@genoffice/electron-utils/user-skills-channels'
import { USER_SKILL_PREVIEW_TEXT_MAX_CHARS } from '@genoffice/electron-utils/user-skills-channels'
import { skillsText, type SkillsStringKey } from '../i18n/strings-skills'
import { skillHubText, type SkillHubStringKey } from '../i18n/strings-skill-hub'
import { PreviewWarning } from '../skills/SkillImport'
import {
  failureKey,
  skillDisplayDesc,
  skillDisplayTitle,
  sourceLabel,
  unreadableKey,
  userSkillsApi,
} from '../skills/skills-model'
import {
  SKILL_HUB_TABS,
  buildSkillImportAddress,
  skillHubCandidateCard,
  skillHubInstalledRow,
  type SkillHubProvenanceSource,
  type SkillHubRowView,
  type SkillHubTab,
} from './skill-hub-model'
import './skill-hub.css'
import '../skills/skills.css'

/** the skills calls the page makes; a window's full bridge fits this */
export type SkillHubApi = Pick<
  UserSkillsBridge,
  | 'importGitHub'
  | 'readImport'
  | 'install'
  | 'cancelImport'
  | 'list'
  | 'setState'
  | 'remove'
  | 'onChanged'
>

type SkillsText = (key: SkillsStringKey, params?: Record<string, string | number>) => string

const PROVENANCE_LABEL: Record<SkillHubProvenanceSource, SkillHubStringKey> = {
  builtin: 'provBuiltin',
  official: 'provOfficial',
  community: 'provCommunity',
  local: 'provLocal',
}

/**
 * A found skill opened before installing: the parsed front-matter fields and
 * the SKILL.md body, read through the previewed import (nothing is installed
 * by looking). Also the lines the preview points at as worth reading.
 */
function SkillHubPreviewDetail({
  api,
  lang,
  locale,
  token,
  candidate,
}: {
  api: SkillHubApi
  lang: Lang
  locale: string
  token: string
  candidate: UserSkillImportCandidateView
}) {
  const [content, setContent] = useState<UserSkillImportContent | null>(null)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const card = skillHubCandidateCard(candidate, { kind: 'folder' })
  const s: SkillsText = (key, params) => skillsText(lang, key, params)
  const y = (key: SkillHubStringKey, params?: Record<string, string | number>) =>
    skillHubText(lang, key, params)

  useEffect(() => {
    let alive = true
    setContent(null)
    setErrorKey(null)
    void api
      .readImport(token, candidate.key)
      .then((answer) => {
        if (!alive) return
        if (answer.ok) setContent(answer.content)
        else setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
      })
      .catch(() => {
        if (alive) setErrorKey('failGeneric')
      })
    return () => {
      alive = false
    }
  }, [api, token, candidate.key])

  return (
    <div className="ysp-detail" data-testid="ysp-detail">
      <dl className="ysp-fields">
        <dt>{y('labelName')}</dt>
        <dd data-testid="ysp-detail-name">{card.name}</dd>
        {card.version && (
          <>
            <dt>{y('labelVersion')}</dt>
            <dd data-testid="ysp-detail-version">{card.version}</dd>
          </>
        )}
      </dl>
      <span className="ysp-field-label">{y('labelBody')}</span>
      {errorKey && (
        <p className="ysp-error" role="alert">
          {s(errorKey)}
        </p>
      )}
      {!errorKey && !content && <p className="set-field-desc">{s('loading')}</p>}
      {content && content.body.text.trim() === '' && (
        <p className="set-field-desc" data-testid="ysp-detail-empty">
          {s('previewBodyEmpty')}
        </p>
      )}
      {content && content.body.text.trim() !== '' && (
        <pre className="ysp-body" dir="auto" tabIndex={0} data-testid="ysp-detail-body">
          {content.body.text}
        </pre>
      )}
      {content?.body.truncated && (
        <p className="set-field-desc">
          {s('previewTruncated', {
            n: USER_SKILL_PREVIEW_TEXT_MAX_CHARS.toLocaleString(locale),
          })}
        </p>
      )}
      {candidate.warningCount > 0 && (
        <div className="ysp-line-warnings" role="note">
          <span className="ysp-field-label">
            {s('previewWarnings', { n: candidate.warningCount })}
          </span>
          <ul>
            {candidate.warnings.map((w) => (
              <li key={`${w.file}:${w.line}:${w.messageKey}`} data-warning={w.messageKey}>
                <span>{s(w.messageKey)}</span>{' '}
                <span className="set-field-desc">
                  {s('previewWarningAt', { file: w.file, line: w.line })}
                </span>
                <code dir="auto">{w.excerpt}</code>
              </li>
            ))}
          </ul>
          <span className="set-field-desc">{s('previewWarningsNote')}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The "get" tab: a GitHub owner/repo with an optional folder path, one real
 * preview of what was found before anything is installed, and Install per
 * card. Closing or refinding drops what was fetched (`cancelImport`).
 */
function SkillHubGetTab({ api, lang, locale }: { api: SkillHubApi; lang: Lang; locale: string }) {
  const s: SkillsText = (key, params) => skillsText(lang, key, params)
  const y = (key: SkillHubStringKey, params?: Record<string, string | number>) =>
    skillHubText(lang, key, params)
  const [repo, setRepo] = useState('')
  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<UserSkillImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, UserSkillCollisionChoice>>({})
  const [installing, setInstalling] = useState<string | null>(null)
  /** candidates this preview installed, kept marked so more can go in from one search */
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  const live = useRef({ running: false, closed: false, token: null as string | null })

  // closing the page (or refinding) drops the fetched preview; the main
  // process keeps nothing for a token that was cancelled
  useEffect(() => {
    const state = live.current
    state.closed = false
    return () => {
      state.closed = true
      if (state.running) void api.cancelImport()
      if (state.token) void api.cancelImport(state.token)
      state.token = null
    }
  }, [api])

  const find = async () => {
    if (busy || installing) return
    const address = buildSkillImportAddress(repo, path)
    if (!address) {
      setErrorKey('failBadAddress')
      return
    }
    setBusy(true)
    setErrorKey(null)
    setNotice(null)
    setExpanded(null)
    setChoices({})
    setInstalled({})
    setSearch('')
    const oldToken = live.current.token
    live.current.token = null
    setPreview(null)
    if (oldToken) void api.cancelImport(oldToken)
    live.current.running = true
    const answer = await api
      .importGitHub(address)
      .catch(() => ({ ok: false as const, reason: 'failed' as const }))
    live.current.running = false
    if (live.current.closed) {
      if (answer.ok) void api.cancelImport(answer.preview.token)
      return
    }
    setBusy(false)
    if (answer.ok) {
      live.current.token = answer.preview.token
      setPreview(answer.preview)
      return
    }
    setErrorKey(failureKey(answer.reason, 'import') ?? 'failGeneric')
  }

  const install = async (candidate: UserSkillImportCandidateView) => {
    const current = preview
    if (!current || installing || busy) return
    const onCollision: Record<string, UserSkillCollisionChoice> = {}
    const choice = choices[candidate.key]
    if (candidate.collision) {
      if (!choice) {
        setErrorKey('chooseCollision')
        return
      }
      onCollision[candidate.key] = choice
    }
    setInstalling(candidate.key)
    setErrorKey(null)
    // `keep` leaves the previewed import alive so the next card of the same
    // search can be installed; closing the page cancels it as before
    const answer = await api
      .install(current.token, [candidate.key], onCollision, true)
      .catch(() => ({ ok: false as const, reason: 'failed' as const }))
    if (live.current.closed) return
    setInstalling(null)
    if (answer.ok) {
      // the list stays: the installed card is marked, not taken away
      setInstalled((was) => ({ ...was, [candidate.key]: true }))
      setNotice(s('installed', { n: answer.installed.length }))
      return
    }
    if (answer.reason === 'needs-choice') {
      setErrorKey('chooseCollision')
      return
    }
    // any other refusal expires the preview (the import is dropped with it)
    live.current.token = null
    setPreview(null)
    setErrorKey(failureKey(answer.reason, 'import') ?? 'failGeneric')
  }

  return (
    <div className="ysp-tab">
      <p className="set-field-desc">{y('getIntro')}</p>
      <div className="ysp-form">
        <label className="ysp-field">
          <span className="ysp-field-label">{y('repoLabel')}</span>
          <input
            className="ysp-input"
            data-testid="ysp-repo"
            value={repo}
            placeholder={y('repoPlaceholder')}
            spellCheck={false}
            disabled={busy || installing !== null}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void find()
            }}
          />
        </label>
        <label className="ysp-field">
          <span className="ysp-field-label">{y('pathLabel')}</span>
          <input
            className="ysp-input"
            data-testid="ysp-path"
            value={path}
            placeholder={y('pathPlaceholder')}
            spellCheck={false}
            disabled={busy || installing !== null}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void find()
            }}
          />
        </label>
        <button
          type="button"
          className="set-btn primary ysp-find"
          data-testid="ysp-find"
          disabled={busy || installing !== null || !repo.trim()}
          onClick={() => void find()}
        >
          {busy ? y('finding') : y('find')}
        </button>
      </div>
      {notice && (
        <p className="ysp-notice" role="status" data-testid="ysp-notice">
          {notice}
        </p>
      )}
      {errorKey && (
        <p className="ysp-error" role="alert" data-testid="ysp-error">
          {s(errorKey)}
        </p>
      )}
      {preview && (
        <>
          <p className="set-field-desc">
            {preview.origin.kind === 'github'
              ? s('previewFromGitHub', {
                  repo: preview.origin.repo,
                  ref: preview.origin.path
                    ? `${preview.origin.ref}/${preview.origin.path}`
                    : preview.origin.ref,
                  n: preview.candidates.length,
                })
              : s('previewFromFolder', { n: preview.candidates.length })}
          </p>
          <input
            type="search"
            className="ysp-input"
            data-testid="ysp-search"
            aria-label={s('searchPlaceholder')}
            placeholder={s('searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="ysp-cards">
            {preview.candidates
              .filter((candidate) =>
                `${candidate.title} ${candidate.name} ${candidate.description}`
                  .toLocaleLowerCase(lang)
                  .includes(search.toLocaleLowerCase(lang).trim()),
              )
              .map((candidate) => {
                const card = skillHubCandidateCard(candidate, preview.origin)
                return (
                  <li className="ysp-card" key={candidate.key} data-key={candidate.key}>
                    <h3 className="ysp-card-title">{card.title}</h3>
                    {card.description && (
                      <p className="ysp-card-desc" data-testid="ysp-card-desc">
                        {card.description}
                      </p>
                    )}
                    {candidate.problem && (
                      <div className="ysp-error">
                        {candidate.problem === 'duplicate'
                          ? s('problemDuplicate')
                          : s('problemCannot', { reason: s(unreadableKey(candidate.problem)) })}
                      </div>
                    )}
                    {candidate.collision && (
                      <div className="ysp-collision" role="group" aria-label={s('collision')}>
                        <span className="set-field-desc">{s('collision')}</span>
                        {(['replace', 'skip'] as const).map((choice) => (
                          <button
                            key={choice}
                            type="button"
                            className={`set-btn ysp-choice${choices[candidate.key] === choice ? ' active' : ''}`}
                            aria-pressed={choices[candidate.key] === choice}
                            onClick={() =>
                              setChoices((was) => ({ ...was, [candidate.key]: choice }))
                            }
                          >
                            {s(choice === 'replace' ? 'collisionReplace' : 'collisionSkip')}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="ysp-card-footer">
                      {card.publisher && (
                        <span className="ysp-badge" data-testid="ysp-card-publisher">
                          {card.publisher}
                        </span>
                      )}
                      {card.version && (
                        <span className="ysp-badge" data-testid="ysp-card-version">
                          {y('versionBadge', { version: card.version })}
                        </span>
                      )}
                      <div className="ysp-card-actions">
                        <button
                          type="button"
                          className="set-btn"
                          data-testid="ysp-card-preview"
                          aria-expanded={expanded === candidate.key}
                          onClick={() =>
                            setExpanded((was) => (was === candidate.key ? null : candidate.key))
                          }
                        >
                          {expanded === candidate.key ? s('close') : y('previewAction')}
                        </button>
                        {installed[candidate.key] ? (
                          <span className="ysp-badge" data-testid="ysp-card-installed">
                            {y('installedAction')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="set-btn primary"
                            data-testid="ysp-card-install"
                            disabled={!!candidate.problem || busy || installing !== null}
                            onClick={() => void install(candidate)}
                          >
                            {y('installAction')}
                          </button>
                        )}
                      </div>
                    </div>
                    {expanded === candidate.key && (
                      <SkillHubPreviewDetail
                        api={api}
                        lang={lang}
                        locale={locale}
                        token={preview.token}
                        candidate={candidate}
                      />
                    )}
                  </li>
                )
              })}
          </ul>
          <PreviewWarning lang={lang} />
        </>
      )}
    </div>
  )
}

/** One row of the "my skills" list: on/off, source, version, description, delete */
function SkillHubRow({
  api,
  lang,
  row,
  view,
  onDelete,
}: {
  api: SkillHubApi
  lang: Lang
  row: SkillHubRowView
  view: UserSkillView
  onDelete: (view: UserSkillView) => void
}) {
  const s: SkillsText = (key, params) => skillsText(lang, key, params)
  const y = (key: SkillHubStringKey, params?: Record<string, string | number>) =>
    skillHubText(lang, key, params)
  const [pending, setPending] = useState(false)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)
  const toggle = async (enabled: boolean) => {
    setPending(true)
    setErrorKey(null)
    try {
      const answer = await api.setState(row.id, { enabled })
      if (!answer.ok) setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
    } catch {
      setErrorKey('failGeneric')
    } finally {
      setPending(false)
    }
  }
  const badge = row.provenanceSource
    ? y(PROVENANCE_LABEL[row.provenanceSource])
    : sourceLabel(view, s)
  return (
    <li className="ysp-row" data-id={row.id}>
      <input
        type="checkbox"
        className="ysp-check"
        data-testid="ysp-row-toggle"
        checked={row.enabled}
        disabled={pending}
        aria-label={s('switchLabel', { title: row.title })}
        onChange={(e) => void toggle(e.target.checked)}
      />
      <div className="ysp-row-main">
        <div className="ysp-row-head">
          <span className="ysp-row-title">{row.title}</span>
          <span className="ysp-badge" data-testid="ysp-row-source">
            {badge}
          </span>
          {row.version && (
            <span className="ysp-badge" data-testid="ysp-row-version">
              {y('versionBadge', { version: row.version })}
            </span>
          )}
        </div>
        <p className="ysp-row-desc">{skillDisplayDesc(view, lang)}</p>
        {errorKey && (
          <p className="ysp-error" role="alert">
            {s(errorKey)}
          </p>
        )}
      </div>
      {row.canRemove && (
        <button
          type="button"
          className="set-btn ysp-row-delete"
          data-testid="ysp-row-delete"
          onClick={() => onDelete(view)}
        >
          {s('actRemove')}
        </button>
      )}
    </li>
  )
}

/**
 * The "my skills" tab: every installed skill with its state, kept current by
 * the service's change broadcast. Turning on/off and deleting go through the
 * same API the settings screen uses, so what is stored never forks.
 */
function SkillHubMineTab({ api, lang }: { api: SkillHubApi; lang: Lang }) {
  const s: SkillsText = (key, params) => skillsText(lang, key, params)
  const y = (key: SkillHubStringKey, params?: Record<string, string | number>) =>
    skillHubText(lang, key, params)
  const [views, setViews] = useState<UserSkillView[] | null>(null)
  const [confirm, setConfirm] = useState<UserSkillView | null>(null)
  const [errorKey, setErrorKey] = useState<SkillsStringKey | null>(null)

  const refresh = useCallback(() => {
    void api
      .list()
      .then(setViews)
      .catch(() => setErrorKey('failGeneric'))
  }, [api])

  useEffect(() => {
    refresh()
    return api.onChanged(refresh)
  }, [api, refresh])

  const removeNow = async () => {
    const view = confirm
    setConfirm(null)
    if (!view) return
    setErrorKey(null)
    try {
      const answer = await api.remove(view.id)
      if (!answer.ok) setErrorKey(failureKey(answer.reason) ?? 'failGeneric')
      refresh()
    } catch {
      setErrorKey('failGeneric')
    }
  }

  return (
    <div className="ysp-tab">
      {errorKey && (
        <p className="ysp-error" role="alert">
          {s(errorKey)}
        </p>
      )}
      {views === null && !errorKey && <p className="set-field-desc">{s('loading')}</p>}
      {views !== null && views.length === 0 && (
        <p className="set-field-desc" data-testid="ysp-mine-empty">
          {y('mineEmpty')}
        </p>
      )}
      {views !== null && views.length > 0 && (
        <ul className="ysp-rows">
          {views.map((view) => (
            <SkillHubRow
              key={view.id}
              api={api}
              lang={lang}
              view={view}
              row={skillHubInstalledRow(view)}
              onDelete={setConfirm}
            />
          ))}
        </ul>
      )}
      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={s('actRemove')}
            data-testid="ysp-delete-confirm"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{skillDisplayTitle(confirm)}</h3>
            <p>{s('confirmRemove', { title: skillDisplayTitle(confirm) })}</p>
            <div className="modal-buttons">
              <button
                type="button"
                className="btn btn-secondary"
                autoFocus
                onClick={() => setConfirm(null)}
              >
                {s('cancel')}
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void removeNow()}>
                {s('actRemove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The skills forest home page (Ieum Forest): the "get", "my skills" and
 * "share" tabs over one content area. "share" is a placeholder only. Home
 * takes the page away again the moment AI is unavailable (ai-features.ts).
 */
export function SkillHubPanel({
  lang,
  locale,
  api: apiProp,
}: {
  lang: Lang
  /** BCP-47 locale for number formatting */
  locale: string
  api?: SkillHubApi | undefined
}) {
  const y = (key: SkillHubStringKey, params?: Record<string, string | number>) =>
    skillHubText(lang, key, params)
  const [tab, setTab] = useState<SkillHubTab>('get')
  const api = apiProp ?? userSkillsApi()
  // left/right arrows move along the tab strip, as a tablist is expected to
  const moveTab = (from: SkillHubTab, step: 1 | -1, target: EventTarget & HTMLButtonElement) => {
    const index = SKILL_HUB_TABS.indexOf(from)
    const next = SKILL_HUB_TABS[(index + step + SKILL_HUB_TABS.length) % SKILL_HUB_TABS.length]!
    setTab(next)
    target.ownerDocument.getElementById(`ysp-tabbtn-${next}`)?.focus()
  }
  return (
    <main className="content ysp" data-testid="ysp-page">
      <header className="ysp-head">
        <h2 className="ysp-title">{y('name')}</h2>
        <div className="ysp-tabs" role="tablist" aria-label={y('name')}>
          {SKILL_HUB_TABS.map((id) => (
            <button
              key={id}
              id={`ysp-tabbtn-${id}`}
              type="button"
              role="tab"
              className={`ysp-tab-btn${tab === id ? ' active' : ''}`}
              aria-selected={tab === id}
              aria-controls={`ysp-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              data-testid={`ysp-tab-${id}`}
              onClick={() => setTab(id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  moveTab(id, 1, e.currentTarget)
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault()
                  moveTab(id, -1, e.currentTarget)
                }
              }}
            >
              {y(id === 'get' ? 'tabGet' : id === 'mine' ? 'tabMine' : 'tabShare')}
            </button>
          ))}
        </div>
      </header>
      <div
        className="ysp-panel"
        role="tabpanel"
        id={`ysp-panel-${tab}`}
        aria-labelledby={`ysp-tabbtn-${tab}`}
      >
        {!api ? (
          <p className="ysp-error" role="alert">
            {skillsText(lang, 'failGeneric')}
          </p>
        ) : tab === 'get' ? (
          <SkillHubGetTab api={api} lang={lang} locale={locale} />
        ) : tab === 'mine' ? (
          <SkillHubMineTab api={api} lang={lang} />
        ) : (
          <p className="set-field-desc ysp-soon" data-testid="ysp-share-soon">
            {y('shareComingSoon')}
          </p>
        )}
      </div>
    </main>
  )
}
