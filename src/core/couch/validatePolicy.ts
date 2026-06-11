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
 *  - message/feedback/response/version 등 나머지 타입은 기존대로(읽기전용은 파일 콘텐츠만 대상).
 * 거부 사유는 `covault:shared-read-only`로 고정 — 클라이언트(onDenied)가 식별해 안내하는 프로토콜.
 */

/** validate 배포 버전. 규칙이 바뀌면 올린다(지문에 포함되어 자동 재배포). */
export const VALIDATE_DOC_VERSION = 3;

/** onDenied가 식별하는 거부 사유 문자열(서버↔클라이언트 프로토콜 — 변경 금지). */
export const READONLY_FORBIDDEN_REASON = "covault:shared-read-only";

export interface ValidatePolicy {
	/** 공유 파일 읽기전용 정책(settings.sharedReadOnly). */
	readOnly: boolean;
	/** 실시간 서버 서비스 계정(항상 허용 — 서버 스냅샷 경로). 없으면 생략. */
	svcUsername?: string;
	/** dbPath → 허용 username 목록(실시간 세션 참여자). 빈 배열 = 아무도(명시적 차단). */
	allowByPath: Record<string, string[]>;
}

/** 키·값 정렬된 사본(지문 결정성 + 임베드 결정성). */
function normalized(policy: ValidatePolicy): { ro: boolean; svc?: string; allow: Record<string, string[]> } {
	const allow: Record<string, string[]> = {};
	for (const key of Object.keys(policy.allowByPath).sort()) {
		allow[key] = [...policy.allowByPath[key]].sort();
	}
	return { ro: !!policy.readOnly, ...(policy.svcUsername ? { svc: policy.svcUsername } : {}), allow };
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
	const embedded = JSON.stringify({ ro: n.ro, svc: n.svc ?? null, allow: n.allow, any: anyAllowed });
	return (
		"function (newDoc, oldDoc, userCtx) {\n" +
		"  if (userCtx && userCtx.roles && userCtx.roles.indexOf('_admin') >= 0) return;\n" +
		"  var t = newDoc.type || (oldDoc && oldDoc.type);\n" +
		"  var teacherOnly = ['notice','timetable','routine','assignment','chatgroup','rtpart','rtcontrol','roster'];\n" +
		"  if (teacherOnly.indexOf(t) >= 0) throw({ forbidden: 'teacher only' });\n" +
		"  if (t === 'response') {\n" +
		"    var owner = newDoc._deleted ? (oldDoc && oldDoc.byUser) : newDoc.byUser;\n" +
		"    if (owner && owner !== userCtx.name) throw({ forbidden: 'own doc only' });\n" +
		"  }\n" +
		"  if (t === 'grouprequest') {\n" +
		"    var reqOwner = newDoc._deleted ? (oldDoc && oldDoc.byUsername) : newDoc.byUsername;\n" +
		"    if (!reqOwner || reqOwner !== userCtx.name) throw({ forbidden: 'own request only' });\n" +
		"    if (oldDoc && oldDoc.byUsername && oldDoc.byUsername !== userCtx.name) throw({ forbidden: 'own request only' });\n" +
		"    if (!newDoc._deleted && newDoc.status !== 'pending') throw({ forbidden: 'status is manager-only' });\n" +
		"  }\n" +
		`  var POLICY = ${embedded};\n` +
		"  if (POLICY.ro && (t === 'note' || t === 'asset')) {\n" +
		"    var u = userCtx && userCtx.name;\n" +
		"    if (POLICY.svc && u === POLICY.svc) return;\n" +
		"    if (t === 'asset') {\n" +
		"      if (POLICY.any.indexOf(u) >= 0) return;\n" +
		`      throw({ forbidden: '${READONLY_FORBIDDEN_REASON}' });\n` +
		"    }\n" +
		"    var id = newDoc._id || (oldDoc && oldDoc._id) || '';\n" +
		"    var p = id.indexOf('note:') === 0 ? id.slice(5) : null;\n" +
		"    var allowed = p !== null ? POLICY.allow[p] : null;\n" +
		"    if (allowed && allowed.indexOf(u) >= 0) return;\n" +
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
 * rtpart 문서들 → dbPath별 허용 username 맵. memberId→username 매핑(settings.members),
 * 미매핑 memberId·삭제 문서는 제외. memberIds가 빈 배열이면 "아무도"(빈 배열 유지 — 명시적 차단).
 */
export function allowMapFromRtParts(
	rtparts: Array<{ dbPath?: string; memberIds?: string[]; deleted?: boolean }>,
	members: Array<{ memberId: string; username: string }>,
): Record<string, string[]> {
	const byId = new Map(members.filter((m) => m.memberId && m.username).map((m) => [m.memberId, m.username]));
	const out: Record<string, string[]> = {};
	for (const d of rtparts) {
		if (!d || d.deleted || !d.dbPath || !Array.isArray(d.memberIds)) continue;
		out[d.dbPath] = d.memberIds
			.map((id) => byId.get(id))
			.filter((u): u is string => !!u)
			.sort();
	}
	return out;
}
