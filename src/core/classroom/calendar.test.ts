import { describe, it, expect } from "vitest";
import { monthMatrix, shiftMonth } from "./calendar";

describe("monthMatrix", () => {
	it("일요일 시작, 1일 요일 위치에 맞춰 앞쪽을 인접 달로 채운다", () => {
		// 2026-06: 1일이 월요일(getDay()=1) → 첫 주 앞에 5월 31일(일) 1칸.
		const m = monthMatrix(2026, 5);
		expect(m[0].length).toBe(7);
		expect(m[0][0].inMonth).toBe(false); // 5/31 (일)
		expect(new Date(m[0][1].ts).getDate()).toBe(1); // 6/1 (월)
		expect(m[0][1].inMonth).toBe(true);
	});

	it("해당 월의 모든 날짜를 포함한다", () => {
		const m = monthMatrix(2026, 5).flat().filter((c) => c.inMonth);
		expect(m.length).toBe(30); // 6월은 30일
		expect(new Date(m[0].ts).getDate()).toBe(1);
		expect(new Date(m[m.length - 1].ts).getDate()).toBe(30);
	});

	it("모든 칸은 일요일 시작 정렬", () => {
		const m = monthMatrix(2026, 0);
		for (const week of m) expect(new Date(week[0].ts).getDay()).toBe(0);
	});
});

describe("shiftMonth", () => {
	it("연도 경계를 넘는다", () => {
		expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month0: 11 });
		expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month0: 0 });
		expect(shiftMonth(2026, 5, 3)).toEqual({ year: 2026, month0: 8 });
	});
});
