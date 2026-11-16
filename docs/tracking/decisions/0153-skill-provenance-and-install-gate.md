# 0153 — 스킬 설치의 출처·버전 기록과 엄격한 설치 검사

## 맥락

스킬을 고르는 화면이 "이 스킬이 어디서 온 것인지, 몇 판인지"를 보여 달라고 했다. 기본 스킬, 공식 저장소에서 설치한 스킬, 커뮤니티 저장소에서 설치한 스킬, 이 PC에서 만든 스킬을 한 눈에 구분해야 한다. 지금은 GitHub에서 설치한 스킬만 `.ieum-source.json` 덕에 출처를 되짚을 수 있고, 나머지는 아무 기록이 없다.

또한 가져오기 파이프라인은 폴더를 **너그럽게** 읽는다(믿을 수 없는 항목은 조용히 건너뛴다, `listSkillFolderFiles`). 그렇게 읽은 폴더를 설치할 때는 엄격해야 한다. 링크 밖으로 이어지는 파일 이름(`..\`), 폴더 밖으로 이어지는 심볼릭 링크, 크기 한도를 넘는 내용, 앞머리가 망가진 `SKILL.md`가 통째로 넘어가거나 조용히 잘려 들어가면 안 된다(공개 스킬 장터의 악성 스킬 보고, 결정 0048).

외부 에이전트 스킬용 장부(`agentSkillInstalls`, `@genoffice/cli/agent-skills`의 `SkillLedger`)는 이미 `app-settings.json`에 있지만, 그것은 터미널 명령어가 다른 프로그램의 스킬 폴더에 무엇을 썼는지에 대한 기록이다. 앱이 스스로 설치한 스킬의 출처와는 대상이 다르다.

## 결정

- **출처·버전 기록은 `app-settings.json`의 `skillProvenance`에 둔다.** 외부 장부(`agentSkillInstalls`)와 나란히 두되 **섞지 않는다**: 자기 키, 자기 모양, 식별자(`app:<이름>`)로 찾는 별도 장부다. 읽기는 모양이 어긋난 항목을 버리고 남긴다(`skillProvenanceFromSettings`, `ledgerFromSettings`를 비껴난 방식).
- **기록 항목의 모양.** `{ source, sourceUrl?, version?, at }`. `source`는 `official`(제품의 공식 저장소 `PRODUCT_REPO_SLUG`) · `community`(그 밖의 GitHub 저장소) · `local`(이 PC에서 만들거나 폴더·zip·글로 들여온 것) 셋이다. `sourceUrl`은 GitHub 스킬만, `https://github.com/<owner>/<repo>/tree/<commit>/<경로>`로 만든다(경로는 출처 기록과 같은 값, 후보의 `rel`). `version`은 설치할 때 그 스킬의 `SKILL.md` 앞머리가 적은 값이다(아래). `at`은 기록 시각(ISO 8601, UTC, 정수 초).
- **버전은 `SKILL.md` 앞머리의 `version`(맨 위 또는 `metadata.version`)에서 읽는다.** 파서는 모르는 값을 그대로 두므로 설치 검사·기록 단계에서 읽기만 한다. 긴 값(128자 초과)은 버전으로 보지 않는다.
- **언제 기록하는가.** 설치(`install`)·업데이트(`applyUpdate`)·만들기/사본(`writeSkill` 새 스킬, `copyToMine`)·지우기(`remove`)·이름 바꾸기·되돌리기 때 장부를 함께 갱신한다. 고치기·되돌리기는 **기존 기록을 지키고**(출처와 주소 유지) 이름이 바뀌면 항목이 따라 움직이며, 파일이 버전을 적지 않았으면 예전 값을 남긴다. 지우기는 항목을 지운다. 업데이트는 `sourceUrl`의 커밋을 새 커밋으로 바꾼다.
- **화면 계약(선택 필드, `packages/electron-utils/src/user-skills-channels.ts`).** `UserSkillView`에 `version?: string`과 `provenance?: { source: 'builtin' | 'official' | 'community' | 'local'; sourceUrl?: string }`, `UserSkillImportCandidateView`에 `version?: string`을 더했다. `builtin` 스킬의 출처는 `{ source: 'builtin' }`(기록 없음), 내 스킬은 장부, 장부가 없으면 `.ieum-source.json`에서 도출(없으면 `local`). 다른 프로그램의 폴더(Claude·플러그인·Codex)는 앱이 설치한 것이 아니므로 두 값 모두 비운다. 미리보기 후보의 `version`은 그 후보의 `SKILL.md`에서 읽는다.
- **설치 검사(`checkSkillInstallDir`, `apps/shell/src/main/skill-target.ts`).** 설치 직전의 폴더를 통째로 판정한다: (1) 항목 이름에 경로 구분자·`..`·드라이브 모양이 있으면 거절, (2) 심볼릭 링크가 폴더 밖으로 이어지거나 해석되지 않으면 거절(폴더 안 링크는 허용), (3) 파일 수·바이트 한도(`MAX_USER_SKILL_FILES`, `MAX_USER_SKILL_BYTES`)를 넘으면 거절, (4) `SKILL.md`의 앞머리에 꼭 있어야 하는 `name`·`description`이 없거나 해석되지 않으면 거절, (5) `name`이 읽을 수 없는 이름이거나 예약 이름이면 거절. **거절이 목적이므로 잘라내거나 정규화하지 않는다.** 너그러운 읽기가 건너뛴 것을 설치 단계에서 통째로 막는 것이다.
- **검사를 거치는 곳.** `install`(사용자가 고른 후보 가운데 실제로 복사될 것), `place`(내 스킬 쓰기·사본이 폴더를 놓기 직전), `applyUpdate`(교체될 새 폴더). 파이프라인이 이미 거절하는 후보(앞머리 문제·예약 이름)와 `needs-choice`로 물어야 하는 것은 종전대로 그 이유로 남는다. 거절 이유는 화면의 이유 낱말로 바뀐다: 구조 문제(`traversal`·`absolute`·`escaping-link`·`outside`) → `unsafe`, 크기 → `too-large`, 앞머리·이름 → `not-installable`, 읽기 실패 → `unreadable`.
- **앞머리 문법은 설치할 때 별도로 확인한다.** 편집용 `parseSkillMd`는 모르는 줄을 보존하는 너그러운 파서다. 설치에서는 `js-yaml`의 `FAILSAFE_SCHEMA`로 앞머리 전체를 데이터로만 읽어 중복 키·망가진 YAML·사용자 정의 태그·이름/설명의 배열·객체를 거절한다. 기존 잠금 파일에 있는 `js-yaml`을 셸의 직접 빌드 의존성으로 선언한다. 앞머리는 64 KiB, 폴더 깊이는 64단계, 디렉터리를 포함한 항목 수는 파일 수 한도의 네 배로 제한한다. 설치 시 스크립트를 실행하는 경로는 없다.
- **별도 폴더 경로는 기본 가지에서 찾는다.** 받기 화면의 `owner/repo`와 폴더 경로는 `/tree/HEAD/<경로>`로 전달한다. 기존 GitHub 커밋 해석기가 `HEAD`를 커밋으로 확정하므로 폴더의 첫 부분을 가지 이름으로 오해하지 않는다. 가지를 직접 고르려면 기존 GitHub `tree/<가지>/<경로>` 주소를 쓴다. 절대 경로·상위 경로·빈 경로 조각은 정규화해 고치지 않고 거절한다.
- **기존 사용자 스킬 고치기는 그대로다.** 편집기에서 저장하는 길은 너그러운 파서를 그대로 쓰고 검사를 새로 들이지 않았다(이미 만든 파일의 편집을 깨지 않기 위해). 검사가 거절하는 것은 새로 **설치**되는 폴더다.

## 택하지 않은 것

- **기록을 스킬 폴더 안 파일에 넣는다.** 내보내기·다른 프로그램으로의 이동에 따라 나가고, 문서 옆 파일 규칙(결정 0018의 취지)과도 어긋난다. 설정 파일에 남긴다.
- **외부 장부(`agentSkillInstalls`)에 함께 적는다.** 대상이 다른 기록(터미널 명령어가 쓴 파일)을 오염시키고, 지우기·이름 바꾸기 규칙이 서로 다르다. 키를 나눠 뒀다.
- **다른 프로그램 폴더의 스킬에도 출처를 붙인다.** 그 스킬을 앱이 설치한 것이 아니므로 아는 것을 넘겨 지어내지 않는다. 화면에서 비워 둔다.
- **MCP 리소스로 게시한다.** 이 단계의 범위가 아니며 하지 않았다.
