import { b64ToUtf8, utf8ToB64 } from "../util/b64";
/**
 * 학생 초대 페이로드. 기술문서 §22.4 (setup URI).
 * 학생 Member Mode를 자동 설정하는 데 필요한 최소 정보 + 학생 전용 자격증명.
 */
export interface InvitePayload {
	v: 1;
	couchdbUrl: string;
	workspaceId: string;
	memberId: string;
	memberName: string;
	remoteDb: string;
	username: string;
	password: string;
	/** 발급 시각(Unix epoch 초). 선택 — 구버전 초대 호환. */
	iat?: number;
	/** 만료 시각(Unix epoch 초). 있으면 이후 적용 차단. 선택 — 무만료/구버전 호환. */
	exp?: number;
}

export const INVITE_ACTION = "covault-invite";

/** base64url 인코딩(UTF-8 안전). */
function toBase64Url(s: string): string {
	return utf8ToB64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return b64ToUtf8(b64);
}

/** 페이로드 → base64url 코드. */
export function encodeInvite(payload: InvitePayload): string {
	return toBase64Url(JSON.stringify(payload));
}

/** couchdbUrl이 http(s) URL인지. 딥링크는 클릭 한 번으로 도달하므로 임의 스킴/형식 주입을 차단한다. */
function isHttpUrl(s: string): boolean {
	try {
		const u = new URL(s);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
}

/** 코드 또는 obsidian:// URI → 페이로드(검증). 실패 시 null. */
export function parseInvite(input: string): InvitePayload | null {
	let code = input.trim();
	// obsidian://covault-invite?d=... 형태면 d 추출
	const m = code.match(/[?&]d=([^&]+)/);
	if (m) code = decodeURIComponent(m[1]);
	try {
		const obj = JSON.parse(fromBase64Url(code)) as InvitePayload;
		if (obj?.v !== 1 || !obj.couchdbUrl || !obj.remoteDb || !obj.username || !obj.password) return null;
		if (!isHttpUrl(obj.couchdbUrl)) return null;
		return obj;
	} catch {
		return null;
	}
}

/** 초대 딥링크 URI. 학생이 폰 카메라로 QR을 찍으면 Obsidian이 열린다. */
export function buildInviteUri(payload: InvitePayload): string {
	return `obsidian://${INVITE_ACTION}?d=${encodeURIComponent(encodeInvite(payload))}`;
}

/**
 * 초대 만료 여부(순수). `exp`가 있고 `nowSec`가 그 이후면 true. `exp` 없으면(구버전/무만료) 항상 false.
 * 만료된 초대는 적용을 차단해 장기 유효 비밀번호가 든 오래된 QR/딥링크 사용을 줄인다(보고서 P2 완화).
 */
export function isInviteExpired(payload: InvitePayload, nowSec: number): boolean {
	return typeof payload.exp === "number" && nowSec > payload.exp;
}

/** 랜덤 비밀번호 생성(영숫자). */
export function genPassword(len = 20): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
	const arr = new Uint8Array(len);
	crypto.getRandomValues(arr);
	let out = "";
	for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
	return out;
}
