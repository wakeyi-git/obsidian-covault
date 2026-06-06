/**
 * 공유 공간(room)별 실시간 토큰 — HMAC-SHA256 서명. 기술문서 §19.3.
 *
 * 토큰 = `<payloadB64url>.<sigB64url>` 형태로, payload는 `{c:workspaceId, s:spaceId, e?:exp(sec)}`.
 * Yjs 서버(docs/server.js)가 같은 시크릿으로 서명을 검증하고, 접속한 room이 `class_<c>/share/<s>/`로
 * 시작하는지 확인한다. 따라서 한 학생의 토큰이 유출돼도 **그 공간 room에만** 접근할 수 있다(학급 전체가
 * 아니라). 무상태 서버라 단일 공간 즉시 폐기는 불가 — 전체 회전은 시크릿 교체, 만료는 exp로 처리.
 */

export interface SpaceTokenClaims {
	workspaceId: string;
	spaceId: string;
	/** 만료(Unix epoch 초). 생략 시 무만료. */
	exp?: number;
}

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function bytesToB64Url(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToUtf8(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return decodeURIComponent(escape(atob(b64)));
}

async function hmacB64Url(secret: string, message: string): Promise<string> {
	const keyData = utf8(secret) as BufferSource;
	const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, utf8(message) as BufferSource);
	return bytesToB64Url(new Uint8Array(sig));
}

/**
 * HMAC 시크릿이 없을 때 stale 공간 토큰을 제거(순수). 시크릿을 비우거나 legacy 전역 토큰으로 전환했는데
 * 옛 `sp.token`이 남아 shares 문서로 학생에게 재배포되는 것을 막는다(보고서 P1).
 */
export function clearSpaceTokens(spaces: Array<{ token?: string }>): void {
	for (const sp of spaces) delete sp.token;
}

/** 공간 토큰 발급(교사). secret은 서버 YJS_SECRET와 동일해야 한다. */
export async function mintSpaceToken(secret: string, claims: SpaceTokenClaims): Promise<string> {
	const payload: Record<string, unknown> = { c: claims.workspaceId, s: claims.spaceId };
	if (claims.exp && claims.exp > 0) payload.e = claims.exp;
	const payloadB64 = bytesToB64Url(utf8(JSON.stringify(payload)));
	const sig = await hmacB64Url(secret, payloadB64);
	return `${payloadB64}.${sig}`;
}

/**
 * 공간 토큰 검증(클라이언트 단위 테스트/방어용). 서버도 동일 규칙으로 검증한다.
 * 서명 일치 + payload의 workspaceId/spaceId 일치 + (exp 있으면) 미만료면 true.
 */
export async function verifySpaceToken(
	secret: string,
	token: string,
	workspaceId: string,
	spaceId: string,
	nowSec: number,
): Promise<boolean> {
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return false;
	const payloadB64 = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = await hmacB64Url(secret, payloadB64);
	if (sig !== expected) return false;
	let payload: { c?: string; s?: string; e?: number };
	try {
		payload = JSON.parse(b64UrlToUtf8(payloadB64));
	} catch {
		return false;
	}
	if (payload.c !== workspaceId || payload.s !== spaceId) return false;
	if (typeof payload.e === "number" && nowSec > payload.e) return false;
	return true;
}
