import { describe, it, expect } from "vitest";
import { weekStart, addWeeks, weekRangeLabel, weekContains } from "./week";

describe("week helpers", () => {
	// 2026-06-10 = 수요일. 그 주 월요일 = 2026-06-08.
	const wed = new Date(2026, 5, 10, 15, 0).getTime();

	it("weekStart는 그 주 월요일", () => {
		expect(weekStart(wed)).toBe("2026-06-08");
		// 월요일 자체
		expect(weekStart(new Date(2026, 5, 8, 0, 0).getTime())).toBe("2026-06-08");
		// 일요일은 같은 주(이전 월요일)
		expect(weekStart(new Date(2026, 5, 14, 23, 0).getTime())).toBe("2026-06-08");
		// 다음 월요일은 다음 주
		expect(weekStart(new Date(2026, 5, 15, 1, 0).getTime())).toBe("2026-06-15");
	});

	it("addWeeks", () => {
		expect(addWeeks("2026-06-08", 1)).toBe("2026-06-15");
		expect(addWeeks("2026-06-08", -1)).toBe("2026-06-01");
		expect(addWeeks("2026-06-08", 0)).toBe("2026-06-08");
	});

	it("weekRangeLabel", () => {
		expect(weekRangeLabel("2026-06-08")).toBe("6/8 – 6/14");
	});

	it("weekContains", () => {
		expect(weekContains("2026-06-08", wed)).toBe(true);
		expect(weekContains("2026-06-15", wed)).toBe(false);
	});
});
