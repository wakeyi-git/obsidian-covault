import { sha256 } from "../hash/hash";

/**
 * 공유 DB validate_doc_update(v3) — 정책 임베드형 빌더. 평가 보고서 H-5(코드 수준 강제).
 *
 * CouchDB validate 함수는 타 문서(rtcontrol/rtpart)를 읽을 수 없으므로, "공유 파일 읽기전용" 정책과
 * 파일별 허용자(실시간 세션 참여자의 CouchDB username)를 **디자인 문서에 임베드**하고, 정책·참여자가
 * 바뀔 때마다 재배포한다(DeploymentController.redeployValidate — 지문 비교로 멱등).
 *
 * v3 = v2 규칙 전체 유지(교사 _admin 우회 · 교사 전용 타입 차단 · response/grouprequest 소유 검사) +
 * 읽기전용일 때 구성원의 note/asset 쓰기 제한:
 *  - note: 실시간 서비스 계정(서버 스냅샷) 또는 그 파일의 세션 참여자만 — 세션 종료 시 구성원
 *    클라이언트의 보증 업로드(Uploader.uploadContent, 본인 계정 replication)가 막히지 않아야 한다.
 *  - asset: 참여자 합집합(anyAllowed) — Excalidraw 세션 중 생성되는 이미지 asset은 노트와 경로가
 *    달라 파일별 매칭이 불가능한 절충. 노트 본문 보호가 목적이므로 허용 범위가 다소 넓어도 수용.
 *  - version 등 나머지 타입은 기존대로(읽기전용은 파일 콘텐츠만 대상).
 * 거부 사유는 `covault:shared-read-only`로 고정 — 클라이언트(onDenied)가 식별해 안내하는 프로토콜.
 *
 * v5 = message/feedback 소유·역할 검사 추가(평가 P1-1) + shares/rtconfig를 교사 전용에 포함.
 *  - message/feedback는 byUser/createdBy가 작성자(memberId 정규화) 본인이어야 쓰고, 신규/수정 시
 *    byRole/createdByRole에 'manager'를 위조할 수 없다(구성원은 'member'만). 이 규칙은 공유 DB와
 *    구성원 mirror DB(=DM 채널이 사는 곳) 모두에 배포되어, 멤버가 운영자/타 멤버를 사칭한 메시지를
 *    만들거나 타인의 메시지·피드백을 수정·삭제하지 못하게 한다. 운영자(_admin)는 전부 우회한다.
 *  - shares/rtconfig는 운영자(admin.putDoc)만 쓰므로 교사 전용에 넣어 구성원의 임의 주입을 막는다.
 *    mirror DB 정책은 readOnly:false(읽기전용은 공유 공간 전용 개념) — 소유·역할·교사전용 차단만 적용.
 *
 * v6 = ystate(실시간 CRDT 상태 사이드카) 쓰기를 실시간 서비스 계정(svc) 전용으로 제한. 서버가 SQLite 유실
 *  후에도 정확한 Yjs 이력을 복원해 중복 누적을 막으려 CouchDB에 ystate:<dbPath>를 영속하는데, 구성원이 임의의
 *  ystate를 주입하면 실시간 세션 시드를 오염시킬 수 있으므로 svc(없으면 admin만)만 쓰게 한다.
 */

/** validate 배포 버전. 규칙이 바뀌면 올린다(지문에 포함되어 자동 재배포). v7 = rtrequest(1:1 라이브 지도 요청) 본인 쓰기 허용. */
export const VALIDATE_DOC_VERSION = 7;

/** onDenied가 식별하는 거부 사유 문자열(서버↔클라이언트 프로토콜 — 변경 금지). */
export const READONLY_FORBIDDEN_REASON = "covault:shared-read-only";

export interface ValidatePolicy {
	/** 공유 파일 읽기전용 정책(settings.sharedReadOnly). */
	readOnly: boolean;
	/** 실시간 서버 서비스 계정(항상 허용 — 서버 스냅샷 경로). 없으면 생략. */
	svcUsername?: string;
	/** dbPath → 허용 **memberId** 목록(실시간 세션 참여자). 빈 배열 = 아무도(명시적 차단).
	 *  v4: 계정명 대신 memberId를 임베드하고, 계정→memberId 매핑은 accounts로 분리(기기별 계정 지원). */
	allowByPath: Record<string, string[]>;
	/** CouchDB username → memberId(평가 S-2 — 기기별 계정). 소유·참여 검사를 memberId 기준으로 정규화한다.
	 *  기본 계정(username=memberId 관례)도 포함해, username을 따로 정한 구성원의 잠재 불일치도 함께 해소. */
	accounts?: Record<string, string>;
}

/** 키·값 정렬된 사본(지문 결정성 + 임베드 결정성). */
function normalized(policy: ValidatePolicy): {
	ro: boolean;
	svc?: string;
	allow: Record<string, string[]>;
	acct: Record<string, string>;
} {
	const allow: Record<string, string[]> = {};
	for (const key of Object.keys(policy.allowByPath).sort()) {
		allow[key] = [...policy.allowByPath[key]].sort();
	}
	const acct: Record<string, string> = {};
	for (const key of Object.keys(policy.accounts ?? {}).sort()) {
		acct[key] = (policy.accounts ?? {})[key];
	}
	return { ro: !!policy.readOnly, ...(policy.svcUsername ? { svc: policy.svcUsername } : {}), allow, acct };
}

/** settings.members → username→memberId 맵(기본 계정 + 기기 계정 — 평가 S-2). */
export function accountsMapFromMembers(
	members: Array<{ memberId: string; username?: string; deviceAccounts?: Array<{ username: string }> }>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of members) {
		if (!m.memberId) continue;
		if (m.username) out[m.username] = m.memberId;
		for (const d of m.deviceAccounts ?? []) if (d.username) out[d.username] = m.memberId;
	}
	return out;
}

/** 임베드 소스가 과대해지면 경고할 기준(현실적으로 1,000파일×5명 ≈ 60KB 수준). */
export const VALIDATE_SOURCE_WARN_BYTES = 200 * 1024;

/**
 * 정책 임베드형 validate_doc_update 소스 생성(CouchDB가 평가하는 함수 문자열).
 * CouchDB의 JS 엔진은 구식일 수 있어 var/function 문법만 쓴다.
 */
export function buildValidateSource(policy: ValidatePolicy): string {
	const n = normalized(policy);
	const anyAllowed = [...new Set(Object.values(n.allow).flat())].sort();
	const embedded = JSON.stringify({ ro: n.ro, svc: n.svc ?? null, allow: n.allow, any: anyAllowed, acct: n.acct });
	return (
		"function (newDoc, oldDoc, userCtx) {\n" +
		"  if (userCtx && userCtx.roles && userCtx.roles.indexOf('_admin') >= 0) return;\n" +
		`  var POLICY = ${embedded};\n` +
		// cn: 계정명 → memberId 정규화(v4 — 기기별 계정). 미등록 이름은 그대로(레거시 username=memberId 관례 호환).
		"  function cn(x) { return (POLICY.acct && POLICY.acct[x]) || x; }\n" +
		"  var me = cn(userCtx && userCtx.name);\n" +
		"  var t = newDoc.type || (oldDoc && oldDoc.type);\n" +
		"  var teacherOnly = ['notice','timetable','routine','assignment','chatgroup','rtpart','rtcontrol','roster','shares','rtconfig'];\n" +
		"  if (teacherOnly.indexOf(t) >= 0) throw({ forbidden: 'teacher only' });\n" +
		// ystate: 실시간 서버가 영속하는 CRDT 상태 사이드카 — 서비스 계정만 쓴다(구성원 위조 차단). svc 미설정이면
		// 서버는 admin 자격으로 쓰므로(_admin 우회) 여기서 막혀도 무방하고, 비-admin 구성원은 전부 거부된다.
		"  if (t === 'ystate') {\n" +
		"    if (POLICY.svc && (userCtx && userCtx.name) === POLICY.svc) return;\n" +
		"    throw({ forbidden: 'server only' });\n" +
		"  }\n" +
		// ownedByMe: 신규/수정 문서와 기존 문서의 작성자(field)가 모두 나여야 한다(타인 문서 위조·수정·삭제 차단).
		"  function ownedByMe(f) {\n" +
		"    var nv = newDoc._deleted ? (oldDoc && oldDoc[f]) : newDoc[f];\n" +
		"    if (!nv || cn(nv) !== me) return false;\n" +
		"    if (oldDoc && oldDoc[f] && cn(oldDoc[f]) !== me) return false;\n" +
		"    return true;\n" +
		"  }\n" +
		"  if (t === 'response') {\n" +
		"    var owner = newDoc._deleted ? (oldDoc && oldDoc.byUser) : newDoc.byUser;\n" +
		"    if (owner && cn(owner) !== me) throw({ forbidden: 'own doc only' });\n" +
		"  }\n" +
		// message/feedback: 작성자 본인만, 그리고 신규/수정 시 manager 역할 위조 금지(P1-1).
		"  if (t === 'message') {\n" +
		"    if (!ownedByMe('byUser')) throw({ forbidden: 'own message only' });\n" +
		"    if (!newDoc._deleted && newDoc.byRole && newDoc.byRole !== 'member') throw({ forbidden: 'member role only' });\n" +
		"  }\n" +
		"  if (t === 'feedback') {\n" +
		"    if (!ownedByMe('createdBy')) throw({ forbidden: 'own feedback only' });\n" +
		"    if (!newDoc._deleted && newDoc.createdByRole && newDoc.createdByRole !== 'member') throw({ forbidden: 'member role only' });\n" +
		"  }\n" +
		"  if (t === 'grouprequest') {\n" +
		"    var reqOwner = newDoc._deleted ? (oldDoc && oldDoc.byUsername) : newDoc.byUsername;\n" +
		"    if (!reqOwner || cn(reqOwner) !== me) throw({ forbidden: 'own request only' });\n" +
		"    if (oldDoc && oldDoc.byUsername && cn(oldDoc.byUsername) !== me) throw({ forbidden: 'own request only' });\n" +
		"    if (!newDoc._deleted && newDoc.status !== 'pending') throw({ forbidden: 'status is manager-only' });\n" +
		"  }\n" +
		// rtrequest: 1:1 라이브 지도 요청 — 본인(byUsername) 문서만 쓰기/취소. 교사는 _admin 우회로 승인(rtpart 변환)·삭제.
		"  if (t === 'rtrequest') {\n" +
		"    var rqOwner = newDoc._deleted ? (oldDoc && oldDoc.byUsername) : newDoc.byUsername;\n" +
		"    if (!rqOwner || cn(rqOwner) !== me) throw({ forbidden: 'own request only' });\n" +
		"    if (oldDoc && oldDoc.byUsername && cn(oldDoc.byUsername) !== me) throw({ forbidden: 'own request only' });\n" +
		"  }\n" +
		"  if (POLICY.ro && (t === 'note' || t === 'asset')) {\n" +
		"    var u = userCtx && userCtx.name;\n" +
		"    if (POLICY.svc && u === POLICY.svc) return;\n" +
		"    if (t === 'asset') {\n" +
		"      if (POLICY.any.indexOf(me) >= 0) return;\n" +
		`      throw({ forbidden: '${READONLY_FORBIDDEN_REASON}' });\n` +
		"    }\n" +
		"    var id = newDoc._id || (oldDoc && oldDoc._id) || '';\n" +
		"    var p = id.indexOf('note:') === 0 ? id.slice(5) : null;\n" +
		"    var allowed = p !== null ? POLICY.allow[p] : null;\n" +
		"    if (allowed && allowed.indexOf(me) >= 0) return;\n" +
		`    throw({ forbidden: '${READONLY_FORBIDDEN_REASON}' });\n` +
		"  }\n" +
		"}"
	);
}

/**
 * 배포 필요 판정용 결정적 지문(버전 포함, 키·값 정렬). DB별로 "마지막 성공 배포 지문"과 비교해
 * 다를 때만 PUT — 시작 시 호출해도 멱등하고, 실패 DB는 지문 미기록으로 자동 재시도된다.
 */
export async function policyFingerprint(policy: ValidatePolicy): Promise<string> {
	return sha256(JSON.stringify({ v: VALIDATE_DOC_VERSION, ...normalized(policy) }));
}

/**
 * rtpart 문서들 → dbPath별 허용 **memberId** 맵(v4). 명단에 없는 memberId·삭제 문서는 제외.
 * memberIds가 빈 배열이면 "아무도"(빈 배열 유지 — 명시적 차단). 계정 매핑은 ValidatePolicy.accounts가 담당.
 */
export function allowMapFromRtParts(
	rtparts: Array<{ dbPath?: string; memberIds?: string[]; deleted?: boolean }>,
	members: Array<{ memberId: string }>,
): Record<string, string[]> {
	const known = new Set(members.map((m) => m.memberId).filter(Boolean));
	const out: Record<string, string[]> = {};
	for (const d of rtparts) {
		if (!d || d.deleted || !d.dbPath || !Array.isArray(d.memberIds)) continue;
		out[d.dbPath] = d.memberIds.filter((id) => known.has(id)).sort();
	}
	return out;
}
