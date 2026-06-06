import { describe, it, expect } from "vitest";
import { dayStr, itemAppliesOn, itemsOn, routineAppliesOn, completion, completionPct, computeStreak } from "./routines";
import { RoutineDoc, RoutineItem, RoutineStateDoc } from "../model/types";

describe("dayStr", () => {
	it("로컬 YYYY-MM-DD", () => {
		expect(/^\d{4}-\d{2}-\d{2}$/.test(dayStr(1_700_000_000_000))).toBe(true);
	});
});

const MON = new Date(2026, 5, 8, 9, 0).getTime(); // 2026-06-08 월(getDay=1)
const TUE = new Date(2026, 5, 9, 9, 0).getTime(); // 화(getDay=2)

describe("itemAppliesOn / itemsOn / routineAppliesOn", () => {
	const daily: RoutineItem = { id: "i0", label: "매일", recurrence: "daily" };
	const monOnly: RoutineItem = { id: "i1", label: "월", recurrence: "weekly", weekdays: [1] };
	const routine = { items: [daily, monOnly] };

	it("항목별 적용 판정", () => {
		expect(itemAppliesOn(daily, TUE)).toBe(true);
		expect(itemAppliesOn(monOnly, MON)).toBe(true);
		expect(itemAppliesOn(monOnly, TUE)).toBe(false);
	});
	it("그날 적용 항목만", () => {
		expect(itemsOn(routine, MON).map((i) => i.id)).toEqual(["i0", "i1"]);
		expect(itemsOn(routine, TUE).map((i) => i.id)).toEqual(["i0"]);
	});
	it("적용 항목이 있으면 루틴 표시", () => {
		expect(routineAppliesOn(routine, TUE)).toBe(true);
		expect(routineAppliesOn({ items: [monOnly] }, TUE)).toBe(false);
	});
});

function st(day: string, checked: string[]): RoutineStateDoc {
	return {
		_id: `routine-state:r1:m:${day}`,
		type: "routine-state",
		schemaVersion: 1,
		workspaceId: "ws",
		routineUid: "r1",
		memberId: "m",
		day,
		checked,
		updatedAtMs: 0,
	};
}

describe("completion", () => {
	const routine: Pick<RoutineDoc, "items"> = {
		items: [
			{ id: "i0", label: "매일", recurrence: "daily" },
			{ id: "i1", label: "월", recurrence: "weekly", weekdays: [1] },
		],
	};
	it("적용 항목만 분모로 계산", () => {
		// 화요일: 적용 항목은 i0뿐
		expect(completion(routine, st(dayStr(TUE), ["i0"]), TUE)).toEqual({ done: 1, total: 1 });
		// 월요일: i0,i1 둘 다 적용 — i0만 체크
		expect(completion(routine, st(dayStr(MON), ["i0"]), MON)).toEqual({ done: 1, total: 2 });
		expect(completionPct({ done: 1, total: 2 })).toBe(50);
	});
});

describe("computeStreak (항목별 반복)", () => {
	const DAY = 86_400_000;
	const today = MON; // 월
	const d = (off: number) => dayStr(today - off * DAY);
	const routine: Pick<RoutineDoc, "items"> = {
		items: [
			{ id: "i0", label: "매일", recurrence: "daily" },
			{ id: "i1", label: "월", recurrence: "weekly", weekdays: [1] },
		],
	};

	it("그날 적용 항목 전부 완료해야 streak 인정", () => {
		// 오늘(월): i0,i1 적용. 둘 다 체크. 어제(일): i0만 적용, 체크. 그제(토): i0 적용, 체크.
		const states = new Map([
			[d(0), st(d(0), ["i0", "i1"])],
			[d(1), st(d(1), ["i0"])],
			[d(2), st(d(2), ["i0"])],
		]);
		expect(computeStreak(routine, states, today)).toBe(3);
	});
	it("월요일에 i1 미완료면 그날에서 끊김", () => {
		const states = new Map([
			[d(0), st(d(0), ["i0"])], // 오늘 월: i1 미완료 → 오늘은 미완료지만 i===0이라 건너뜀
			[d(1), st(d(1), ["i0"])], // 어제 일: 완료
			[d(7), st(d(7), ["i0", "i1"])], // 지난 월
		]);
		// 오늘 건너뜀 → 어제(완료) → ... d(2)~d(6)는 daily만 적용인데 상태 없음 → 미완료로 끊김
		expect(computeStreak(routine, states, today)).toBe(1);
	});
});
