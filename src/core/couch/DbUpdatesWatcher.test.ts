import { describe, it, expect } from "vitest";
import { DbUpdatesWatcher } from "./DbUpdatesWatcher";

/** 응답 시퀀스를 차례로 돌려주는 fetch 모킹. 소진되면 영원히 pending(루프 보류 — 핸들 없음). */
function fetchQueue(responses: Array<{ status: number; body?: unknown } | "network-error">): {
	fetchImpl: typeof fetch;
	urls: string[];
} {
	const urls: string[] = [];
	let i = 0;
	const fetchImpl = (async (input: RequestInfo | URL) => {
		urls.push(String(input));
		const r = responses[i++];
		if (r === undefined) return new Promise(() => {}) as never; // 시퀀스 끝 — 보류
		if (r === "network-error") throw new Error("ECONNREFUSED");
		return {
			status: r.status,
			ok: r.status < 400,
			json: async () => r.body ?? {},
		} as Response;
	}) as typeof fetch;
	return { fetchImpl, urls };
}

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
			setTimeout(tick, 5);
		};
		tick();
	});
}

describe("DbUpdatesWatcher", () => {
	it("이벤트 → 디바운스 콜백, since 전파, 네트워크 오류 후 재시도", async () => {
		const q = fetchQueue([
			{ status: 200, body: { results: [{ db_name: "mirror_a", type: "updated" }], last_seq: "10-x" } },
			"network-error",
			{ status: 200, body: { results: [{ db_name: "share_g", type: "updated" }], last_seq: "11-y" } },
		]);
		const changed: string[] = [];
		const w = new DbUpdatesWatcher({
			baseUrl: "http://couch",
			username: "u",
			password: "p",
			dbs: () => new Set(["mirror_a", "share_g"]),
			onDbChanged: (db) => changed.push(db),
			onFatal: () => {},
			retryDelayMs: 10,
			debounceMs: 5,
			fetchImpl: q.fetchImpl,
		});
		w.start();
		await waitFor(() => changed.includes("mirror_a") && changed.includes("share_g"));
		expect(q.urls[0]).toContain("since=now");
		expect(q.urls[2]).toContain(`since=${encodeURIComponent("10-x")}`); // 오류 재시도는 같은 since
		w.stop();
		expect(w.running).toBe(false);
	});

	it("403 → onFatal(forbidden) + 자체 정지", async () => {
		const q = fetchQueue([{ status: 403 }]);
		let fatal: string | null = null;
		const w = new DbUpdatesWatcher({
			baseUrl: "http://couch",
			username: "u",
			password: "p",
			dbs: () => new Set(["mirror_a"]),
			onDbChanged: () => {},
			onFatal: (reason) => (fatal = reason),
			fetchImpl: q.fetchImpl,
		});
		w.start();
		await waitFor(() => fatal !== null);
		expect(fatal).toBe("forbidden");
		expect(w.running).toBe(false);
	});

	it("last_seq 소실 → 전 DB broadcast + since 리셋", async () => {
		const q = fetchQueue([{ status: 200, body: { results: [] } }]); // last_seq 없음
		const changed: string[] = [];
		const w = new DbUpdatesWatcher({
			baseUrl: "http://couch",
			username: "u",
			password: "p",
			dbs: () => new Set(["mirror_a", "mirror_b"]),
			onDbChanged: (db) => changed.push(db),
			onFatal: () => {},
			debounceMs: 5,
			fetchImpl: q.fetchImpl,
		});
		w.start();
		await waitFor(() => changed.length === 2);
		expect(changed.sort()).toEqual(["mirror_a", "mirror_b"]);
		w.stop();
	});

	it("stop 후 도착한 응답은 무시(세대 토큰)", async () => {
		let release: (() => void) | null = null;
		const gate = new Promise<void>((r) => (release = r));
		const changed: string[] = [];
		const fetchImpl = (async () => {
			await gate; // stop 이후에 응답 도착을 흉내
			return { status: 200, ok: true, json: async () => ({ results: [{ db_name: "mirror_a", type: "updated" }], last_seq: "1" }) } as Response;
		}) as typeof fetch;
		const w = new DbUpdatesWatcher({
			baseUrl: "http://couch",
			username: "u",
			password: "p",
			dbs: () => new Set(["mirror_a"]),
			onDbChanged: (db) => changed.push(db),
			onFatal: () => {},
			debounceMs: 1,
			fetchImpl,
		});
		w.start();
		w.stop();
		release!();
		await new Promise((r) => setTimeout(r, 30));
		expect(changed).toEqual([]);
	});
});
