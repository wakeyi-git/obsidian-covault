import { describe, it, expect } from "vitest";
import { resolveTimetableSlot, placeLessonSlot } from "./timetable";

const DAYS = ["월", "화", "수", "목", "금"];
const PERIODS = ["1", "2", "3", "4", "5", "6"];

describe("resolveTimetableSlot", () => {
	it("라벨로 해석(월 2교시 → 0:1)", () => {
		expect(resolveTimetableSlot("월", "2", DAYS, PERIODS)).toBe("0:1");
	});

	it("1-기반 정수로 해석(월=1, 2교시=2 → 0:1)", () => {
		expect(resolveTimetableSlot(1, 2, DAYS, PERIODS)).toBe("0:1");
	});

	it("라벨/숫자 혼용도 해석", () => {
		expect(resolveTimetableSlot("금", 6, DAYS, PERIODS)).toBe("4:5");
	});

	it("범위를 벗어난 정수는 null", () => {
		expect(resolveTimetableSlot(1, 9, DAYS, PERIODS)).toBeNull();
		expect(resolveTimetableSlot(6, 1, DAYS, PERIODS)).toBeNull();
	});

	it("빈 값/미지정은 null(미배치 유지)", () => {
		expect(resolveTimetableSlot("", "2", DAYS, PERIODS)).toBeNull();
		expect(resolveTimetableSlot("월", undefined, DAYS, PERIODS)).toBeNull();
		expect(resolveTimetableSlot(null, null, DAYS, PERIODS)).toBeNull();
	});

	it("맞지 않는 라벨은 null", () => {
		expect(resolveTimetableSlot("일", "2", DAYS, PERIODS)).toBeNull();
	});
});

describe("placeLessonSlot", () => {
	it("빈 칸에 새로 연결", () => {
		const r = placeLessonSlot({}, "u1", "0:2");
		expect(r).toEqual({ lessons: { "0:2": "u1" }, changed: true });
	});

	it("다른 수업이 있는 다른 칸은 보존하며 추가", () => {
		const r = placeLessonSlot({ "0:1": "도덕", "0:4": "음악" }, "사회", "0:2");
		expect(r.lessons).toEqual({ "0:1": "도덕", "0:4": "음악", "0:2": "사회" });
		expect(r.changed).toBe(true);
	});

	it("같은 수업이 다른 칸에 있으면 이동(이전 칸 제거)", () => {
		const r = placeLessonSlot({ "0:1": "u1", "0:4": "u2" }, "u1", "0:2");
		expect(r.lessons).toEqual({ "0:2": "u1", "0:4": "u2" });
		expect(r.changed).toBe(true);
	});

	it("이미 그 칸이면 변경 없음", () => {
		const r = placeLessonSlot({ "0:2": "u1" }, "u1", "0:2");
		expect(r.changed).toBe(false);
	});
});
