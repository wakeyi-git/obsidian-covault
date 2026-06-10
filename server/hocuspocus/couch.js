/**
 * 최소 CouchDB REST 클라이언트(fetch 기반, Node 20+).
 *
 * 실시간 서버가 CouchDB와 통신하는 모든 지점:
 *   - getDoc:   인가 조회(rtpart/rtcontrol), 스냅샷 대상 note 문서 조회
 *   - putDoc:   note 스냅샷 upsert(409 시 rev 재조회 후 재시도)
 *   - watchChanges: rtpart/rtcontrol 변경 감시(longpoll) → 참가자 제거 즉시 강퇴
 *
 * 권장 계정은 전용 서비스 계정(플러그인 설정의 '실시간 서버 계정') — 각 share/mirror DB의
 * _security.members에 추가되어 admin 비밀번호 없이 동작한다. admin 계정도 사용 가능.
 */

export class CouchClient {
	constructor(baseUrl, user, pass) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.headers = { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") };
	}

	url(db, path = "") {
		return `${this.baseUrl}/${encodeURIComponent(db)}${path}`;
	}

	/** 문서 조회. 404면 null, 그 외 오류는 throw(인가는 fail-closed가 안전). */
	async getDoc(db, id) {
		const res = await fetch(`${this.url(db)}/${encodeURIComponent(id)}`, { headers: this.headers });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`CouchDB GET ${db}/${id} -> HTTP ${res.status}`);
		return res.json();
	}

	/** 문서 upsert(멱등). 409(rev 충돌)면 최신 _rev로 최대 3회 재시도. */
	async putDoc(db, doc) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await fetch(`${this.url(db)}/${encodeURIComponent(doc._id)}`, { headers: this.headers });
			const body = { ...doc };
			if (existing.status === 200) {
				const cur = await existing.json();
				if (cur?._rev) body._rev = cur._rev;
			}
			const put = await fetch(`${this.url(db)}/${encodeURIComponent(doc._id)}`, {
				method: "PUT",
				headers: { ...this.headers, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (put.ok) return put.json();
			if (put.status === 409) continue;
			throw new Error(`CouchDB PUT ${db}/${doc._id} -> HTTP ${put.status}`);
		}
		throw new Error(`CouchDB PUT ${db}/${doc._id} -> repeated 409`);
	}

	/** 현재 update seq(감시 시작점). */
	async currentSeq(db) {
		const res = await fetch(this.url(db), { headers: this.headers });
		if (!res.ok) throw new Error(`CouchDB GET ${db} -> HTTP ${res.status}`);
		const info = await res.json();
		return info.update_seq;
	}

	/**
	 * _changes longpoll 루프. 변경 문서 id가 idFilter를 통과하면 onChange(doc id 배열)를 호출한다.
	 * signal(AbortController)로 중단한다. 네트워크 오류 시 5초 후 재시도(영구 루프).
	 */
	async watchChanges(db, idFilter, onChange, signal) {
		let since;
		try {
			since = await this.currentSeq(db);
		} catch {
			since = "now";
		}
		while (!signal.aborted) {
			try {
				const res = await fetch(
					`${this.url(db)}/_changes?feed=longpoll&timeout=55000&since=${encodeURIComponent(since)}`,
					{ headers: this.headers, signal },
				);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const body = await res.json();
				since = body.last_seq ?? since;
				const ids = (body.results ?? []).map((r) => r.id).filter(idFilter);
				if (ids.length > 0) onChange(ids);
			} catch (e) {
				if (signal.aborted) return;
				console.warn(`[watch] ${db} _changes error: ${e?.message ?? e} — retrying in 5s`);
				await new Promise((r) => setTimeout(r, 5000));
			}
		}
	}
}
