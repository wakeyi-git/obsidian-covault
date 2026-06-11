import { describe, it, expect, vi, afterEach } from "vitest";
import { parseDbUpdates, PerDbDebouncer, chooseTransport } from "./dbUpdatesLogic";

describe("parseDbUpdates", () => {
	const filter = (db: string) => db.startsWith("mirror_") || db.startsWith("share_");

	it("updated/created만, 필터 통과만, 중복 제거", () => {
		const out = parseDbUpdates(
			{
				results: [
					{ db_name: "mirror_a", type: "updated" },
					{ db_name: "mirror_a", type: "updated" },
					{ db_name: "share_g1", type: "created" },
					{ db_name: "mirror_b", type: "deleted" },
					{ db_name: "_users", type: "updated" },
				],
				last_seq: "42-abc",
			},
			filter,
		);
		expect(out).toEqual({ lastSeq: "42-abc", dbs: ["mirror_a", "share_g1"] });
	});

	it("형식 이상에 안전(빈 결과 + lastSeq null)", () => {
		expect(parseDbUpdates(null, filter)).toEqual({ lastSeq: null, dbs: [] });
		expect(parseDbUpdates("garbage", filter)).toEqual({ lastSeq: null, dbs: [] });
		expect(parseDbUpdates({ results: "not-array" }, filter)).toEqual({ lastSeq: null, dbs: [] });
	});

	it("숫자 last_seq도 문자열로 정규화", () => {
		expect(parseDbUpdates({ results: [], last_seq: 7 }, filter).lastSeq).toBe("7");
	});
});

describe("PerDbDebouncer", () => {
	afterEach(() => vi.useRealTimers());

	it("DB별 독립 코얼레싱 — 연속 hit은 1회 발화", () => {
		vi.useFakeTimers();
		const fired: string[] = [];
		const d = new PerDbDebouncer(100, (db) => fired.push(db));
		d.hit("a");
		d.hit("a");
		d.hit("b");
		vi.advanceTimersByTime(99);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(2);
		expect(fired.sort()).toEqual(["a", "b"]);
		d.dispose();
	});

	it("dispose는 대기 발화를 취소", () => {
		vi.useFakeTimers();
		const fired: string[] = [];
		const d = new PerDbDebouncer(100, (db) => fired.push(db));
		d.hit("a");
		d.dispose();
		vi.advanceTimersByTime(200);
		expect(fired).toEqual([]);
	});
});

describe("chooseTransport", () => {
	it("운영자 + 옵션 + 자격 + probe 성공일 때만 event", () => {
		const base = { enabled: true, isManager: true, hasCreds: true, probeOk: true };
		expect(chooseTransport(base)).toBe("event");
		expect(chooseTransport({ ...base, enabled: false })).toBe("live");
		expect(chooseTransport({ ...base, isManager: false })).toBe("live");
		expect(chooseTransport({ ...base, hasCreds: false })).toBe("live");
		expect(chooseTransport({ ...base, probeOk: false })).toBe("live");
	});
});
