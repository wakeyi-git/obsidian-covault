/**
 * 공유 공간(room)별 실시간 토큰 — HMAC-SHA256 서명. 기술문서 §19.3.
 *
 * 토큰 = `<payloadB64url>.<sigB64url>` 형태로, payload는
 * `{c:workspaceId, s:spaceId, d:remoteDb, m:memberId, r:role, e?:exp(sec)}`.
 * Hocuspocus 서버(server/hocuspocus)가 같은 시크릿으로 서명을 검증하고, 접속한 room이
 * `<workspaceId>/share/<spaceId>/`로 시작하는지 확인한 뒤, 공유 공간이면 `d` DB의 rtpart 문서로
 * `m`(주체)의 파일 단위 참여를 인가한다(r=manager는 우회). 토큰은 멤버별로 발급되므로 한 학생의
 * 토큰이 유출돼도 **그 공간 room + 그 학생의 권한**으로만 접근할 수 있다.
 * 전체 회전은 시크릿 교체, 만료는 exp로 처리.
 */
import { b64ToUtf8 } from "../util/b64";

export interface SpaceTokenClaims {
	workspaceId: string;
	spaceId: string;
	/** CouchDB DB명(share_<id> / mirror_<memberId>). 서버가 인가(rtpart)·스냅샷(NoteDoc) 조회에 사용. */
	remoteDb: string;
	/** 토큰 주체(구성원 memberId, 교사는 userId). 파일 단위 인가의 기준. */
	memberId: string;
	/** 역할. manager는 파일 단위 인가를 우회(모든 세션 참관/편집). */
	role: "manager" | "member";
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
	return b64ToUtf8(b64);
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
/** 토큰 payload의 만료(epoch sec). 토큰 형식이 아니거나 무만료면 undefined. 서명은 검증하지 않는다(로컬 점검용). */
export function tokenExp(token: string | undefined): number | undefined {
	if (!token) return undefined;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return undefined;
	try {
		const b64 = token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((token.slice(0, dot).length + 3) % 4);
		const payload = JSON.parse(b64ToUtf8(b64)) as { e?: number };
		return typeof payload.e === "number" ? payload.e : undefined;
	} catch {
		return undefined;
	}
}

export function clearSpaceTokens(spaces: Array<{ token?: string }>): void {
	for (const sp of spaces) delete sp.token;
}

/** 공간 토큰 발급(교사). secret은 서버 YJS_SECRET와 동일해야 한다. */
export async function mintSpaceToken(secret: string, claims: SpaceTokenClaims): Promise<string> {
	const payload: Record<string, unknown> = {
		c: claims.workspaceId,
		s: claims.spaceId,
		d: claims.remoteDb,
		m: claims.memberId,
		r: claims.role,
	};
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
	let payload: { c?: string; s?: string; d?: string; m?: string; r?: string; e?: number };
	try {
		payload = JSON.parse(b64UrlToUtf8(payloadB64));
	} catch {
		return false;
	}
	if (payload.c !== workspaceId || payload.s !== spaceId) return false;
	// 서버 인가에 필요한 클레임(d/m/r)이 빠진 구식 토큰은 거부 — 재배포(재발급)를 유도한다.
	if (typeof payload.d !== "string" || typeof payload.m !== "string") return false;
	if (payload.r !== "manager" && payload.r !== "member") return false;
	if (typeof payload.e === "number" && nowSec > payload.e) return false;
	return true;
}
