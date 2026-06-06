import { describe, it, expect } from "vitest";
import { dayStr, routineAppliesOn, completion, completionPct } from "./routines";
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
