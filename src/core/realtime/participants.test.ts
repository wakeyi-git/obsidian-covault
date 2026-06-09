import { describe, it, expect } from "vitest";
import { defaultParticipation, memberAllowed, visibleToUser, memberNameMap, nameBackfillNeeded } from "./participants";

// 이 테스트는 main.ts에 인라인이던 게이트 결정 로직의 '현재 거동'을 고정한다(추출 후에도 동일해야 함).

describe("defaultParticipation", () => {
	it("읽기 전용이면 기본 비참여(아무도), 해제면 기본 전원", () => {
		expect(defaultParticipation(true)).toBe(false);
		expect(defaultParticipation(false)).toBe(true);
	});
});

describe("memberAllowed", () => {
	const me = "member_a";
	it("지정 문서가 있으면 명단 포함 여부로 판단(읽기전용과 무관)", () => {
		expect(memberAllowed({ memberIds: ["member_a", "member_b"] }, me, true)).toBe(true);
		expect(memberAllowed({ memberIds: ["member_b"] }, me, true)).toBe(false);
		expect(memberAllowed({ memberIds: ["member_b"] }, me, false)).toBe(false);
	});
	it("삭제된 문서는 없는 것으로 보고 기본값 적용", () => {
		expect(memberAllowed({ memberIds: ["member_a"], deleted: true }, me, true)).toBe(false); // 읽기전용 → 아무도
		expect(memberAllowed({ memberIds: ["member_a"], deleted: true }, me, false)).toBe(true); // 해제 → 전원
	});
	it("문서 없음(null/undefined)이면 기본값(읽기전용=false, 해제=true)", () => {
		expect(memberAllowed(null, me, true)).toBe(false);
		expect(memberAllowed(undefined, me, false)).toBe(true);
	});
});

describe("visibleToUser", () => {
	it("교사는 전부, 구성원은 자신이 지정된 것만", () => {
		expect(visibleToUser(["member_b"], "member_a", "manager")).toBe(true);
		expect(visibleToUser(["member_b"], "member_a", "member")).toBe(false);
		expect(visibleToUser(["member_a", "member_b"], "member_a", "member")).toBe(true);
	});
});

describe("memberNameMap", () => {
	const roster = [
		{ memberId: "member_a", memberName: "김바다" },
		{ memberId: "member_b", memberName: "" },
		{ memberId: "member_c", memberName: "김유민" },
	];
	it("명단에 이름이 있는 id만 담는다(빈 이름·미등록 제외)", () => {
		expect(memberNameMap(["member_a", "member_b", "member_c", "member_x"], roster)).toEqual({
			member_a: "김바다",
			member_c: "김유민",
		});
	});
});

describe("nameBackfillNeeded", () => {
	it("계산 이름이 기존과 다르고 채울 게 있으면 true", () => {
		expect(nameBackfillNeeded(["member_a"], undefined, { member_a: "김바다" })).toBe(true);
		expect(nameBackfillNeeded(["member_a"], { member_a: "옛이름" }, { member_a: "김바다" })).toBe(true);
	});
	it("이미 같은 이름이면 false", () => {
		expect(nameBackfillNeeded(["member_a"], { member_a: "김바다" }, { member_a: "김바다" })).toBe(false);
	});
	it("채울 이름이 하나도 없으면 false(빈 계산)", () => {
		expect(nameBackfillNeeded(["member_a"], undefined, {})).toBe(false);
	});
});
