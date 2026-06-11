/**
 * `_db_updates` 통합 변경 감지의 순수 로직(평가 H-6). DbUpdatesWatcher가 사용한다.
 * 운영자 모드가 DB마다 상시 live longpoll을 유지하는 대신, 서버 전체 변경 피드 1개를 보고
 * 변경된 DB만 1회 replicate하기 위한 파싱·디바운스·전송 방식 결정.
 */

export interface DbUpdatesParse {
	/** 응답의 last_seq(다음 longpoll의 since). 형식 미상이면 null — 호출측이 since 리셋 처리. */
	lastSeq: string | null;
	/** 필터를 통과한 변경 DB(중복 제거, updated/created만). */
	dbs: string[];
}

/** `_db_updates` longpoll 응답 파싱. 형식 이상에도 안전(빈 결과로 폴백). */
export function parseDbUpdates(body: unknown, filter: (db: string) => boolean): DbUpdatesParse {
	const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const rawSeq = o.last_seq;
	const lastSeq = typeof rawSeq === "string" ? rawSeq : typeof rawSeq === "number" ? String(rawSeq) : null;
	const results = Array.isArray(o.results) ? o.results : [];
	const dbs: string[] = [];
	const seen = new Set<string>();
	for (const r of results) {
		if (typeof r !== "object" || r === null) continue;
		const rr = r as Record<string, unknown>;
		const db = typeof rr.db_name === "string" ? rr.db_name : null;
		const type = typeof rr.type === "string" ? rr.type : "updated";
		if (!db || (type !== "updated" && type !== "created")) continue; // deleted DB는 동기화 대상 아님
		if (!filter(db) || seen.has(db)) continue;
		seen.add(db);
		dbs.push(db);
	}
	return { lastSeq, dbs };
}

/** DB별 디바운스 발화기 — 짧은 시간의 연속 변경 이벤트를 DB 단위로 코얼레싱한다. */
export class PerDbDebouncer {
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private delayMs: number,
		private onFire: (db: string) => void,
	) {}

	hit(db: string): void {
		const prev = this.timers.get(db);
		if (prev) clearTimeout(prev);
		this.timers.set(
			db,
			setTimeout(() => {
				this.timers.delete(db);
				this.onFire(db);
			}, this.delayMs),
		);
	}

	dispose(): void {
		for (const tm of this.timers.values()) clearTimeout(tm);
		this.timers.clear();
	}
}

/**
 * 전송 방식 결정(순수). `_db_updates`는 서버 admin 전용이라 운영자 + 자격증명 + probe 성공일 때만
 * "event"(통합 감지). 그 외는 기존 "live"(DB별 상시 replication) — 기능 동등성 보장 폴백.
 */
export function chooseTransport(opts: { enabled: boolean; isManager: boolean; hasCreds: boolean; probeOk: boolean }): "live" | "event" {
	return opts.enabled && opts.isManager && opts.hasCreds && opts.probeOk ? "event" : "live";
}
