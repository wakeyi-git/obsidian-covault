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
}

export const INVITE_ACTION = "covault-invite";

/** base64url 인코딩(UTF-8 안전). */
function toBase64Url(s: string): string {
	const b64 = btoa(unescape(encodeURIComponent(s)));
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return decodeURIComponent(escape(atob(b64)));
}

/** 페이로드 → base64url 코드. */
export function encodeInvite(payload: InvitePayload): string {
	return toBase64Url(JSON.stringify(payload));
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
		return obj;
	} catch {
		return null;
	}
}

/** 초대 딥링크 URI. 학생이 폰 카메라로 QR을 찍으면 Obsidian이 열린다. */
export function buildInviteUri(payload: InvitePayload): string {
	return `obsidian://${INVITE_ACTION}?d=${encodeURIComponent(encodeInvite(payload))}`;
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
