import { App, SecretStorage } from "obsidian";

/**
 * Obsidian SecretStorage(@since 1.11.4) 래퍼. 비밀값을 vault별 로컬 스토리지에 저장해 data.json 평문 노출을 막는다.
 * 고정 id로 직접 다뤄 동작을 결정적으로 한다(SecretComponent 위젯 미사용).
 * 모바일 등 secretStorage 미지원 환경을 대비해 항상 런타임 가드 + 평문 폴백을 둔다.
 */

export const YJS_SECRET_ID = "covault-yjs-secret";
export const YJS_TOKEN_ID = "covault-yjs-token";
/** 활성 CouchDB 계정 비밀번호(교사 admin / 학생 본인). replication·프로비저닝에 사용. */
export const COUCH_PASSWORD_ID = "covault-couch-password";

/** 학생별 비밀번호 Secret Storage 키(교사 보유분). id는 소문자-영숫자-대시로 정규화. */
export function memberPasswordId(memberId: string): string {
	const safe = memberId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	return `covault-member-pw-${safe}`;
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
