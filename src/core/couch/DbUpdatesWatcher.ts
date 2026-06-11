import { createObsidianFetch } from "./obsidianFetch";
import { parseDbUpdates, PerDbDebouncer } from "./dbUpdatesLogic";

/**
 * CouchDB `_db_updates` 통합 변경 감지(평가 H-6, 운영자 전용 — server admin 권한 필요).
 *
 * longpoll은 이벤트 발생/타임아웃 시 응답이 완결되는 단발 HTTP라 requestUrl(obsidianFetch) 루프로
 * 구현한다 — server/hocuspocus/couch.js의 watchChanges와 동형 패턴.
 *
 * ⚠ requestUrl은 진행 중 요청을 abort할 수 없다 — longpoll timeout을 30초로 짧게 잡고
 * 세대(generation) 토큰으로 stale 응답을 폐기한다. stop()/pause 후 최대 30초간 연결이 남을 수 있다.
 */
export interface DbUpdatesWatcherOpts {
	baseUrl: string;
	username: string;
	password: string;
	/** 관리 대상 DB 집합(동적 — 매 이벤트마다 조회). */
	dbs: () => Set<string>;
	/** 변경 DB 콜백(디바운스 적용 후). */
	onDbChanged: (db: string) => void;
	/** 권한 회수(forbidden)·서버 미지원(unsupported) — 호출측이 live로 폴백한다. watcher는 자체 정지. */
	onFatal: (reason: "forbidden" | "unsupported", detail: string) => void;
	longpollTimeoutMs?: number; // 기본 30000
	retryDelayMs?: number; // 기본 5000
	debounceMs?: number; // 기본 1000
	/** 테스트 주입용. 기본 createObsidianFetch. */
	fetchImpl?: typeof fetch;
}

export class DbUpdatesWatcher {
	private generation = 0;
	private active = false;
	private since = "now";
	private readonly debouncer: PerDbDebouncer;
	private readonly fetchImpl: typeof fetch;

	constructor(private opts: DbUpdatesWatcherOpts) {
		this.debouncer = new PerDbDebouncer(opts.debounceMs ?? 1000, opts.onDbChanged);
		this.fetchImpl = opts.fetchImpl ?? createObsidianFetch(opts.username, opts.password);
	}

	/** `_db_updates` 접근 가능 여부(시작 전 판정). 401/403/404/400 → 사용 불가(live 폴백). */
	static async probe(
		baseUrl: string,
		username: string,
		password: string,
		fetchImpl?: typeof fetch,
	): Promise<{ ok: boolean; status?: number }> {
		const f = fetchImpl ?? createObsidianFetch(username, password);
		try {
			const resp = await f(`${baseUrl.replace(/\/+$/, "")}/_db_updates?feed=normal&limit=1`);
			return { ok: resp.status < 400, status: resp.status };
		} catch {
			return { ok: false };
		}
	}

	get running(): boolean {
		return this.active;
	}

	/** 감지 루프 시작(멱등). since는 "now"부터 — 시작 이전 누락분은 호출측 캐치업(runStartup)이 흡수. */
	start(): void {
		if (this.active) return;
		this.active = true;
		this.since = "now";
		const gen = ++this.generation;
		void this.loop(gen);
	}

	/** 루프 종료. 진행 중 longpoll은 끊을 수 없으므로(generation 토큰) 다음 응답부터 무시된다. */
	stop(): void {
		if (!this.active) return;
		this.active = false;
		this.generation++;
		this.debouncer.dispose();
	}

	private url(): string {
		const base = this.opts.baseUrl.replace(/\/+$/, "");
		const timeout = this.opts.longpollTimeoutMs ?? 30_000;
		return `${base}/_db_updates?feed=longpoll&timeout=${timeout}&since=${encodeURIComponent(this.since)}`;
	}

	private async loop(gen: number): Promise<void> {
		while (gen === this.generation) {
			try {
				const resp = await this.fetchImpl(this.url());
				if (gen !== this.generation) return; // stop/재시작 후 도착한 stale 응답 폐기
				if (resp.status === 401 || resp.status === 403) {
					this.stop();
					this.opts.onFatal("forbidden", `HTTP ${resp.status}`);
					return;
				}
				if (resp.status === 404 || resp.status === 400) {
					this.stop();
					this.opts.onFatal("unsupported", `HTTP ${resp.status}`);
					return;
				}
				if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
				const body: unknown = await resp.json();
				if (gen !== this.generation) return;
				const parsed = parseDbUpdates(body, (db) => this.opts.dbs().has(db));
				if (parsed.lastSeq != null) {
					this.since = parsed.lastSeq;
					for (const db of parsed.dbs) this.debouncer.hit(db);
				} else {
					// last_seq를 잃었다(형식 이상/서버 교체 등) — 누락 방지를 위해 전 DB를 깨우고 since 리셋.
					this.since = "now";
					for (const db of this.opts.dbs()) this.debouncer.hit(db);
				}
			} catch {
				if (gen !== this.generation) return;
				// 네트워크 오류 — 잠시 후 재시도(오프라인 동안 조용히 대기). 복구 시 캐치업은 안전망이 보완.
				await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 5000));
			}
		}
	}
}
