import { createObsidianFetch } from "./obsidianFetch";

/**
 * 본인 CouchDB 계정 비밀번호 회전(평가 S-2 — 초대 일회성화의 핵심).
 *
 * CouchDB는 사용자가 자기 _users 문서를 갱신할 수 있다. 초대를 적용한 기기가 즉시 비밀번호를
 * 회전하면, QR/코드/딥링크에 평문으로 담겨 배포된 비밀번호가 그 시점부터 무효가 된다 —
 * 초대 코드가 사실상 일회성이 된다(기기별 계정이라 다른 기기에는 영향 없음).
 */
export async function rotateOwnPassword(
	baseUrl: string,
	username: string,
	currentPw: string,
	nextPw: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const f = createObsidianFetch(username, currentPw);
		const url = `${baseUrl.replace(/\/+$/, "")}/_users/${encodeURIComponent(`org.couchdb.user:${username}`)}`;
		const got = await f(url);
		if (got.status >= 400) return { ok: false, error: `HTTP ${got.status}` };
		const doc = JSON.parse(await got.text()) as Record<string, unknown>;
		// 해시 필드를 제거하고 평문 password를 넣으면 서버가 재해시한다.
		delete doc.password_scheme;
		delete doc.iterations;
		delete doc.derived_key;
		delete doc.salt;
		delete doc.pbkdf2_prf;
		doc.password = nextPw;
		const put = await f(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(doc),
		});
		if (put.status >= 300) return { ok: false, error: `HTTP ${put.status}` };
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String((e as Error)?.message ?? e) };
	}
}
