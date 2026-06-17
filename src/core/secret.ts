import { App, Notice, SecretStorage } from "obsidian";
import { t } from "../i18n";

/**
 * Obsidian SecretStorage(@since 1.11.4) 래퍼. 비밀값을 vault별 로컬 스토리지에 저장해 data.json 평문 노출을 막는다.
 * 고정 id로 직접 다뤄 동작을 결정적으로 한다(SecretComponent 위젯 미사용).
 * 모바일 등 secretStorage 미지원 환경을 대비해 항상 런타임 가드 + 평문 폴백을 둔다.
 */

export const YJS_SECRET_ID = "covault-yjs-secret";
/** 활성 CouchDB 계정 비밀번호(교사 admin / 학생 본인). replication·프로비저닝에 사용. */
export const COUCH_PASSWORD_ID = "covault-couch-password";
/** 실시간 서버 전용 CouchDB 서비스 계정 비밀번호(교사 보유). 배포 시 계정 생성·DB 멤버 추가에 사용. */
export const RT_SERVICE_PASSWORD_ID = "covault-rt-service-password";

/**
 * Secret Storage 키 슬러그 — Obsidian `setSecret`은 **소문자 영숫자+하이픈** id만 허용하고 그 외엔 throw한다
 * (obsidian.d.ts: "Lowercase alphanumeric ID with optional dashes"). memberId/spaceId의 임의 문자(대문자·`_`·
 * 유니코드)를 UTF-8 16진수로 인코딩해 항상 `[0-9a-f]`만 남긴다 — 충돌 없이 유효한 키를 만든다.
 * (이전엔 base64url을 써서 대문자·`_`가 섞여 setSecret이 throw → 토큰·구성원 비밀번호가 평문으로 떨어졌다.)
 */
function keySlug(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/**
 * 구성원별 비밀번호 Secret Storage 키(교사 보유분). memberId를 16진수로 담아 충돌을 없앤다.
 * (정규화 방식은 `member_a`와 `member-a`가 같은 키로 충돌하므로 쓰지 않는다.)
 */
export function memberPasswordId(memberId: string): string {
	return `covault-member-pw-${keySlug(memberId)}`;
}

export function getMemberPassword(app: App, memberId: string, fallback: string | undefined): string {
	return getSecretValue(app, memberPasswordId(memberId), fallback);
}

export function setMemberPassword(app: App, memberId: string, password: string): boolean {
	return setSecretValue(app, memberPasswordId(memberId), password);
}

function store(app: App): SecretStorage | undefined {
	return app.secretStorage as SecretStorage | undefined;
}

/** secretStorage에 값이 있으면 그것을, 없으면 평문 fallback을 반환. */
export function getSecretValue(app: App, id: string, fallback: string | undefined): string {
	const ss = store(app);
	if (ss) {
		try {
			const v = ss.getSecret(id);
			if (v != null && v !== "") return v;
		} catch {
			/* 미지원/오류 → 폴백 */
		}
	}
	return fallback ?? "";
}

/** secretStorage에 값을 저장(가능할 때). 저장 성공 여부 반환. */
export function setSecretValue(app: App, id: string, secret: string): boolean {
	const ss = store(app);
	if (!ss) return false;
	try {
		ss.setSecret(id, secret);
		return true;
	} catch {
		return false;
	}
}

/** secretStorage 지원 여부. */
export function hasSecretStorage(app: App): boolean {
	return !!store(app);
}

// --- 도메인별 편의(고정 id 반복·persist 로직 중복 제거) ---

/** 활성 CouchDB 비밀번호 조회(시크릿 우선, 없으면 평문 fallback). */
export function getCouchPassword(app: App, fallback: string | undefined): string {
	return getSecretValue(app, COUCH_PASSWORD_ID, fallback);
}

/** 진단용 비밀번호 출처(값은 노출하지 않는다). */
export type CouchPasswordSource = "secret-storage" | "plaintext-fallback" | "empty";

/**
 * 활성 CouchDB 비밀번호가 **어느 경로**에서 해석되는지 보고(값 비노출). getCouchPassword와 동일한
 * 해석 규칙을 따른다 — 인증 실패 진단에서 "이 기기에 자격증명이 없음(empty)"과 "설정돼 있는데 서버가
 * 거부(스테일/회전)"를 구분한다. empty면 빈 로그인이 서버 잠금을 유발한 것이므로 재온보딩이 필요하다.
 */
export function describeCouchPassword(app: App, fallback: string | undefined): { source: CouchPasswordSource; hasSecretStorage: boolean } {
	const hasSS = hasSecretStorage(app);
	const ss = store(app);
	if (ss) {
		try {
			const v = ss.getSecret(COUCH_PASSWORD_ID);
			if (v != null && v !== "") return { source: "secret-storage", hasSecretStorage: hasSS };
		} catch {
			/* 미지원/오류 → 평문 폴백 판정 */
		}
	}
	return { source: fallback && fallback !== "" ? "plaintext-fallback" : "empty", hasSecretStorage: hasSS };
}

/** Yjs 공간 시크릿 조회(시크릿 우선, 없으면 평문 fallback). */
export function getYjsSecret(app: App, fallback: string | undefined): string {
	return getSecretValue(app, YJS_SECRET_ID, fallback);
}

/** 실시간 서버 CouchDB 서비스 계정 비밀번호 조회(교사). 평문 폴백 없음(Secret Storage 전용). */
export function getRtServicePassword(app: App): string {
	return getSecretValue(app, RT_SERVICE_PASSWORD_ID, undefined);
}

/**
 * CouchDB 비밀번호 저장: Secret Storage 우선(성공 시 평문 제거+플래그), 미지원이면 평문 보관.
 * settings를 구조적으로만 받아 core가 설정 타입에 결합되지 않게 한다(ingestInvite·설정 탭 공용).
 */
let warnedPlaintextFallback = false;

export function persistCouchPassword(app: App, settings: { password?: string; passwordSet?: boolean }, pw: string): void {
	if (setSecretValue(app, COUCH_PASSWORD_ID, pw)) {
		settings.passwordSet = true;
		settings.password = "";
	} else {
		settings.password = pw;
		// Secret Storage 미지원(구버전/일부 모바일) — 비밀번호가 data.json에 평문으로 남는다.
		// 조용히 넘어가면 사용자가 노출 사실을 모른다 → 세션당 1회 경고.
		warnPlaintextFallbackOnce();
	}
}

function warnPlaintextFallbackOnce(): void {
	if (warnedPlaintextFallback) return;
	warnedPlaintextFallback = true;
	new Notice(t("settings.secret_storage_unavailable_plaintext"));
}

// --- 실시간 베어러 토큰(평가 S-1) ---
// HMAC 서명 토큰은 서버가 그대로 신뢰하는 베어러 자격증명인데 data.json에 평문으로 남았다
// (.obsidian이 클라우드 동기화·백업되는 환경에서 전 구성원·전 공간 토큰이 유출된다).
// 비밀번호·yjsSecret과 같은 패턴: Secret Storage 우선 + 설정에는 *Set 플래그, 미지원이면 평문 폴백.

/** 공유 공간의 교사 본인용 토큰(sp.token) 키. */
export function spaceTokenId(spaceId: string): string {
	return `covault-rt-space-token-${keySlug(spaceId)}`;
}
/** 개인 mirror 구성원용 토큰(member.realtimeToken) 키 — shares 배포 시 읽는다. */
export function memberMirrorTokenId(memberId: string): string {
	return `covault-rt-member-token-${keySlug(memberId)}`;
}
/** 개인 mirror 운영자 본인용 토큰(member.managerMirrorToken) 키. */
export function managerMirrorTokenId(memberId: string): string {
	return `covault-rt-manager-token-${keySlug(memberId)}`;
}

/** 토큰 저장. Secret Storage 성공 시 true(호출측: 평문 비우고 *Set 플래그), 실패 시 false(평문 보관 + 1회 경고). */
export function persistBearerToken(app: App, id: string, token: string): boolean {
	if (setSecretValue(app, id, token)) return true;
	warnPlaintextFallbackOnce();
	return false;
}

/** 토큰 회수. ""를 저장하면 getSecretValue가 빈 값으로 보고 무시한다(removeSecret API 의존 없음). */
export function clearBearerToken(app: App, id: string): void {
	setSecretValue(app, id, "");
}

/** 토큰 조회(시크릿 우선, 평문 폴백). 없으면 undefined. */
export function getBearerToken(app: App, id: string, fallback: string | undefined): string | undefined {
	const v = getSecretValue(app, id, fallback);
	return v === "" ? undefined : v;
}

/**
 * data.json에 평문으로 남은 실시간 토큰을 Secret Storage로 1회 이전. 변경이 있으면 true(호출측이 저장).
 * 설정 타입에 결합되지 않도록 구조적 타입만 받는다(persistCouchPassword와 동일 원칙).
 */
export function migratePlaintextTokens(
	app: App,
	s: {
		sharedSpaces?: Array<{ id: string; token?: string; tokenSet?: boolean }>;
		members?: Array<{
			memberId: string;
			realtimeToken?: string;
			realtimeTokenSet?: boolean;
			managerMirrorToken?: string;
			managerMirrorTokenSet?: boolean;
		}>;
	},
): boolean {
	if (!hasSecretStorage(app)) return false;
	let changed = false;
	for (const sp of s.sharedSpaces ?? []) {
		if (sp.id && sp.token && setSecretValue(app, spaceTokenId(sp.id), sp.token)) {
			sp.token = undefined;
			sp.tokenSet = true;
			changed = true;
		}
	}
	for (const m of s.members ?? []) {
		if (!m.memberId) continue;
		if (m.realtimeToken && setSecretValue(app, memberMirrorTokenId(m.memberId), m.realtimeToken)) {
			m.realtimeToken = undefined;
			m.realtimeTokenSet = true;
			changed = true;
		}
		if (m.managerMirrorToken && setSecretValue(app, managerMirrorTokenId(m.memberId), m.managerMirrorToken)) {
			m.managerMirrorToken = undefined;
			m.managerMirrorTokenSet = true;
			changed = true;
		}
	}
	return changed;
}
