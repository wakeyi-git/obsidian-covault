import { describe, it, expect } from "vitest";
import { isSeeder } from "./seedElection";

describe("isSeeder (M-10 — Excalidraw 결정적 시더 선출)", () => {
	it("보이는 피어 중 최소 clientID만 시더 — 전원이 같은 결론", () => {
		const peers = [7, 3, 12];
		expect(isSeeder(3, peers)).toBe(true);
		expect(isSeeder(7, peers)).toBe(false);
		expect(isSeeder(12, peers)).toBe(false);
	});

	it("혼자(피어 없음/자기만)면 시더", () => {
		expect(isSeeder(5, [])).toBe(true);
		expect(isSeeder(5, [5])).toBe(true);
	});

	it("awareness states에 자신이 포함돼도 동작(getStates().keys() 그대로 사용)", () => {
		expect(isSeeder(2, [2, 9, 4])).toBe(true);
		expect(isSeeder(9, [2, 9, 4])).toBe(false);
	});
});
