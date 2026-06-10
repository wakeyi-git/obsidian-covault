/**
 * 실시간 토큰 검증(HMAC-SHA256) — 플러그인 src/core/realtime/spaceToken.ts 의 mintSpaceToken과 한 쌍.
 *
 * 토큰 = `<payloadB64url>.<sigB64url>`, payload = `{c, s, d, m, r, e?}`
 *   c: workspaceId   s: spaceId   d: CouchDB DB명(share_~ / mirror_~)
 *   m: 주체(memberId, 교사는 userId)   r: "manager"|"member"   e: 만료(epoch sec, 생략=무만료)
 *
 * room(documentName) = `<workspaceId>/share/<spaceId>/<dbPath>` — 토큰의 c/s가 허용하는
 * 공간에 속하는지 prefix로 확인한다(공간 간 격리). 파일 단위 인가(rtpart)는 server.js가 수행.
 */
import crypto from "crypto";

/** 알려진 플레이스홀더/너무 짧은 시크릿으로 운영되는 사고를 막는다 — 설정됐다면 반드시 교체해야 한다. */
export function rejectPlaceholder(name, value) {
	if (!value) return;
	if (/^(CHANGE_ME|changeme|replace)/i.test(value) || value.length < 16) {
		console.error(`[FATAL] ${name} must be replaced with a long random value before use (>=16 chars, not a placeholder).`);
		process.exit(1);
	}
}

function b64url(buf) {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** room(documentName) 분해. `<c>/share/<s>/<dbPath>` 형식이 아니면 null. */
export function parseRoom(documentName) {
	const m = /^([^/]+)\/share\/([^/]+)\/(.+)$/.exec(documentName);
	if (!m) return null;
	return { workspaceId: m[1], spaceId: m[2], dbPath: m[3] };
}

/**
 * 토큰 검증: 서명 일치 + room이 payload의 공간(`<c>/share/<s>/`)에 속함 + 클레임(d/m/r) 형식 + (e 있으면) 미만료.
 * 성공 시 클레임 객체를, 실패 시 null을 반환한다.
 */
export function verifyToken(secret, documentName, token) {
	if (!token || typeof token !== "string") return null;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const payloadB64 = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	const expected = b64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	let payload;
	try {
		payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
	} catch {
		return null;
	}
	if (!payload || typeof payload.c !== "string" || typeof payload.s !== "string") return null;
	if (typeof payload.d !== "string" || typeof payload.m !== "string") return null;
	if (payload.r !== "manager" && payload.r !== "member") return null;
	// room이 이 토큰이 허용하는 공간(<workspaceId>/share/<spaceId>/...)에 속하는지 확인 → 공간 간 격리.
	const prefix = `${payload.c}/share/${payload.s}/`;
	if (!documentName.startsWith(prefix)) return null;
	if (typeof payload.e === "number" && Math.floor(Date.now() / 1000) > payload.e) return null;
	return payload;
}
