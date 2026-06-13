# CLAUDE.md

CoVault 기여자·에이전트용 안내. 저장소 구조·규칙·검증 방법을 요약한다. (사용자 기능 설명은 [README.md](README.md) / [README.ko.md](README.ko.md) 참고.)

## 제품 한 줄 요약

관리자↔멤버 폴더를 양방향 동기화하는 Obsidian 플러그인. 로컬 **PouchDB** ↔ 원격 **CouchDB**(자가 호스팅, 예: NAS) 라이브 복제로 오프라인 우선 동작하고, 공유 폴더에서 **Yjs + Hocuspocus**로 실시간 공동편집한다. 메신저·피드백 레이어·학급 대시보드가 그 위에 얹힌다. **학급 전용이 아닌 범용 관리자↔멤버 협업 도구를 지향**한다 — UI 문구·폴더명·기본값은 역할 중립·다국어를 우선한다.

## 명령

```bash
npm run dev          # esbuild watch (개발 빌드)
npm run build        # tsc -noEmit -skipLibCheck + esbuild production → main.js
npm test             # vitest run (단위 + 통합)
npm run lint         # eslint src (no-floating-promises 등 비동기 위생)
npm run i18n:check   # en/ko 키 패리티 + 사용/미정의 검사
npm run version:check# manifest/package/versions 버전 정합
npm run loc-check    # 파일 크기 캡(아래 'LOC 캡' 참고)
```

**CI 게이트**(.github/workflows/ci.yml, Node 22): version:check · test · i18n:check · loc-check · lint · build를 모두 통과해야 한다. 변경 후 위 6개를 로컬에서 돌려 확인하라.

## 아키텍처

계층은 단방향이다 — **core(엔진)는 modes/ui를 import하지 않는다**(검증된 불변식). `main.ts`는 컨트롤러 DI 배선과 수명주기만 남긴 컴포지션 루트다.

```
src/
├─ main.ts              진입점·역할 설정·초대 딥링크·커맨드 배선
├─ panelHost.ts         PanelHost를 컨트롤러 컴포지션으로 조립(pick)
├─ core/                엔진(modes/ui 비의존)
│  ├─ couch/            PouchService(로컬 PouchDB+라이브 동기화)·CouchAdmin(프로비저닝)·obsidianFetch(모바일 CORS 우회)
│  ├─ sync/             MirrorSync 외: MirrorApplier(원격→로컬)·Uploader(로컬→원격)·ConflictManager·
│  │                    FullSync·LinkManifest·LocalWatcher·LocalApplier·VersionStore·MirrorContext
│  ├─ realtime/         RealtimeManager·editorBinding·excalidrawBinding·spaceToken(멤버별 HMAC)·seedElection·participants
│  ├─ classroom/        ClassroomStore·notices·assignments·templates·homeroom
│  ├─ couch/validatePolicy.ts  CouchDB validate_doc_update 정책 빌더(쓰기 권한 서버 강제)
│  ├─ feedback/ guard/ invite/ secret.ts model/types.ts ...
├─ modes/               역할 컨트롤러: ManagerMode/MemberMode + Deployment/Member/Classroom/Realtime/Participant/Recovery 등
├─ ui/                  통합 패널(Dashboard·Chat·Groups·Feedback·Realtime·Deploy·Sync status·History·Log) + 모달
├─ settings/            설정 타입·탭·검증·로케일 기본값
└─ i18n/                t() + locales/{en,ko}.json

server/hocuspocus/      실시간 서버(Node): server.js·auth.js(HMAC 검증)·couch.js·docLifecycle.js(문서 시드·스냅샷·언로드)
test/                   harness/(인메모리 obsidian·pouchdb)·integration/·server/
```

동기화 구조: `Vault ◄─(LocalWatcher/LocalApplier)─► 로컬 PouchDB ◄─(라이브 복제)─► 원격 CouchDB`. 관리자는 멤버마다 `MirrorSync` 하나를 둔다.

## 코딩 규칙

- **타입 안전**: 동기화 엔진은 `as any` 대신 타입 가드를 쓴다(core/model/types.ts의 isXxxDoc). `any`/`as any`는 PouchDB·Obsidian 비공개 API 경계로 한정한다.
- **비동기 위생**: floating promise 금지(eslint가 강제). 의도적 fire-and-forget은 `void`.
- **i18n**: 사용자에게 보이는 문자열은 전부 `t("namespace.key")`. en/ko 양쪽에 키를 추가해야 i18n:check 통과. 폴더명·템플릿 본문·기본 표시명도 현지화 대상(하드코딩 한국어 금지) — `localizeDefaultFolders`, `dashboard.subfolder_*`, `dashboard.tpl_*` 참고.
- **LOC 캡**(scripts/loc-check.mjs): 일반 `*.ts` 500줄. 일부 대형 파일은 `OVERRIDES`에 ratchet으로 **고정**돼 있다(성장 차단, 분해 시 하향). 캡을 올리지 말고, 불가피하면 같은 변경 범위에서 줄을 상쇄하라.
- **데이터 무결성**: 동기화 쓰기는 LWW를 피하고 rev 전제조건(`putWithRev`)·CAS(`writeVaultFileIf`/`writeVaultBinaryIf`)·tombstone 보존·버전 스냅샷을 쓴다. 새 쓰기 경로를 추가할 때 이 패턴을 따르라.
- **보안**: CouchDB 쓰기 권한은 `validatePolicy.ts`의 validate_doc_update로 서버가 강제(공유 DB + 멤버 mirror DB). 실시간 토큰은 멤버별 HMAC(`spaceToken.ts` ↔ 서버 `auth.js`, 한 쌍). 자격증명·시크릿은 Secret Storage(미지원 시 data.json 평문 폴백 + 경고).

## 테스트

vitest. 하니스(test/harness/)는 obsidian·pouchdb-browser를 **인메모리 구현으로 대체**하되 실제 엔진(MirrorSync·Uploader·FullSync·MirrorApplier)을 그대로 구동한다 — 목 엔진이 아니다. 통합 테스트는 `Cluster`/`Device`로 여러 기기의 복제·충돌을 재현한다(test/integration/*). 서버 훅은 DI로 분리돼 test/server/에서 mock CouchDB·인메모리 SQLite로 검증한다. 새 동기화/보안 동작은 통합 또는 서버 테스트로 고정하라.

## 코드 주석의 참조 표기

소스·테스트 주석에 `기술문서 §N.N`, `평가 보고서 X-N`(예: D-1, L-1, S-2, P1-1) 같은 참조가 자주 보인다. 이는 **개발 과정의 설계 문서·평가 회차를 가리키는 역사적 라벨**이며, 그 원문 문서는 저장소에 포함하지 않는다(`docs/`는 `.gitignore`로 로컬 전용). 해당 라벨은 "왜 이렇게 했는지"의 출처 표식이니, 변경 시 주석의 **설명 내용**을 기준으로 판단하면 된다(라벨 자체를 좇을 필요 없음).
