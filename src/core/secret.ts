import { App, SecretStorage } from "obsidian";

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

/** base64url 인코딩(UTF-8 안전). 키에 memberId를 충돌 없이 담는 용도. */
function b64url(s: string): string {
	return btoa(unescape(encodeURIComponent(s)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * 구성원별 비밀번호 Secret Storage 키(교사 보유분). memberId를 base64url로 담아 충돌을 없앤다.
 * (정규화 방식은 `member_a`와 `member-a`가 같은 키로 충돌하므로 쓰지 않는다.)
 */
export function memberPasswordId(memberId: string): string {
	return `covault-member-pw-${b64url(memberId)}`;
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
export function persistCouchPassword(app: App, settings: { password?: string; passwordSet?: boolean }, pw: string): void {
	if (setSecretValue(app, COUCH_PASSWORD_ID, pw)) {
		settings.passwordSet = true;
		settings.password = "";
	} else {
		settings.password = pw;
	}
}
