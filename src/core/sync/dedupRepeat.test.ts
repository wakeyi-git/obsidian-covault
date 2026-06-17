import { describe, it, expect } from "vitest";
import { detectPeriodicRepeat, smallestPeriod, MIN_UNIT_CHARS } from "./dedupRepeat";

/** MIN_UNIT_CHARS를 넘기는 충분히 긴 정본(노트 전체 단위 모사). */
const NOTE = "# 회의록\n\n- 안건 하나\n- 안건 둘\n- 안건 셋\n\n끝.\n";

describe("smallestPeriod", () => {
	it("비반복 문자열은 전체 길이를 반환", () => {
		expect(smallestPeriod("abcdef")).toBe(6);
	});
	it("정확한 2회 반복의 주기는 절반", () => {
		expect(smallestPeriod("abcabc")).toBe(3);
	});
	it("3회 반복의 주기는 1/3", () => {
		expect(smallestPeriod("xyxyxy")).toBe(2);
	});
	it("빈 문자열은 0", () => {
		expect(smallestPeriod("")).toBe(0);
	});
});

describe("detectPeriodicRepeat", () => {
	it("노트 전체가 2회 반복되면 단위·횟수를 탐지(현장 ABCABC 시그니처)", () => {
		const hit = detectPeriodicRepeat(NOTE + NOTE);
		expect(hit).not.toBeNull();
		expect(hit?.unit).toBe(NOTE);
		expect(hit?.copies).toBe(2);
	});

	it("3회 반복도 단위 1개로 축소", () => {
		const hit = detectPeriodicRepeat(NOTE + NOTE + NOTE);
		expect(hit?.unit).toBe(NOTE);
		expect(hit?.copies).toBe(3);
	});

	it("정상(반복 없는) 노트는 null", () => {
		expect(detectPeriodicRepeat(NOTE)).toBeNull();
	});

	it("부분 사본(주기 안 맞음)은 보수적으로 null", () => {
		expect(detectPeriodicRepeat(NOTE + NOTE + "잘린 꼬리")).toBeNull();
	});

	it("짧은 단위의 정상 반복은 오염으로 오인하지 않음(거짓양성 방지)", () => {
		// "- [ ] \n"의 반복 — 정상 체크리스트. 단위가 MIN_UNIT_CHARS 미만이라 제외.
		const checklist = "- [ ] \n".repeat(10);
		expect(detectPeriodicRepeat(checklist)).toBeNull();
	});

	it("minUnit를 낮추면 짧은 단위 반복도 탐지(파라미터 동작 확인)", () => {
		const hit = detectPeriodicRepeat("abcabc", 3);
		expect(hit?.unit).toBe("abc");
		expect(hit?.copies).toBe(2);
	});

	it("빈 문자열은 null", () => {
		expect(detectPeriodicRepeat("")).toBeNull();
	});

	it("기본 최소 단위 상수는 양수", () => {
		expect(MIN_UNIT_CHARS).toBeGreaterThan(0);
	});
});
