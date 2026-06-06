import { describe, it, expect } from "vitest";
import { dayStr, routineAppliesOn, completion, completionPct, computeStreak } from "./routines";
import { RoutineDoc, RoutineStateDoc } from "../model/types";

describe("dayStr", () => {
	it("로컬 YYYY-MM-DD", () => {
		expect(/^\d{4}-\d{2}-\d{2}$/.test(dayStr(1_700_000_000_000))).toBe(true);
	});
});

describe("routineAppliesOn", () => {
	it("daily는 항상, weekly는 요일 매칭", () => {
		const ts = new Date(2026, 5, 8, 9, 0).getTime(); // 2026-06-08 = 월요일(getDay=1)
		expect(routineAppliesOn({ recurrence: "daily" }, ts)).toBe(true);
		expect(routineAppliesOn({ recurrence: "weekly", weekdays: [1] }, ts)).toBe(true);
		expect(routineAppliesOn({ recurrence: "weekly", weekdays: [2, 3] }, ts)).toBe(false);
		expect(routineAppliesOn({ recurrence: "weekly" }, ts)).toBe(false);
	});
});

function routine(items: string[]): Pick<RoutineDoc, "items"> {
	return { items: items.map((label, i) => ({ id: `i${i}`, label })) };
}
function st(checked: string[]): RoutineStateDoc {
	return {
		_id: "routine-state:r1:m:2026-06-08",
		type: "routine-state",
		schemaVersion: 1,
		workspaceId: "ws",
		routineUid: "r1",
		memberId: "m",
		day: "2026-06-08",
		checked,
		updatedAtMs: 0,
	};
}

describe("completion / completionPct", () => {
	it("체크 개수/전체(없는 id 무시)", () => {
		const r = routine(["a", "b", "c", "d"]);
		expect(completion(r, null)).toEqual({ done: 0, total: 4 });
		expect(completion(r, st(["i0", "i2", "i99"]))).toEqual({ done: 2, total: 4 });
		expect(completionPct({ done: 2, total: 4 })).toBe(50);
		expect(completionPct({ done: 0, total: 0 })).toBe(0);
	});
});

describe("computeStreak", () => {
	const DAY = 86_400_000;
	const today = new Date(2026, 5, 10, 12, 0).getTime(); // 2026-06-10
	const d = (offset: number) => dayStr(today - offset * DAY);

	it("daily: 오늘 포함 연속 완료", () => {
		const done = new Set([d(0), d(1), d(2)]);
		expect(computeStreak({ recurrence: "daily" }, done, today)).toBe(3);
	});
	it("daily: 오늘 미완료여도 어제까지 streak 유지", () => {
		const done = new Set([d(1), d(2), d(3)]);
		expect(computeStreak({ recurrence: "daily" }, done, today)).toBe(3);
	});
	it("daily: 중간에 끊기면 거기서 중단", () => {
		const done = new Set([d(0), d(1), d(3), d(4)]);
		expect(computeStreak({ recurrence: "daily" }, done, today)).toBe(2);
	});
	it("weekly: 적용 안 되는 요일은 건너뜀(끊김 아님)", () => {
		// 적용 요일을 오늘 요일만으로 한정 → 지난주 같은 요일과 연속
		const wd = new Date(today).getDay();
		const done = new Set([d(0), d(7), d(14)]);
		expect(computeStreak({ recurrence: "weekly", weekdays: [wd] }, done, today)).toBe(3);
	});
});
