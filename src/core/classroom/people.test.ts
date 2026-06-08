import { describe, it, expect } from "vitest";
import { resolveSenderName, resolveMemberNames } from "./people";

const members = [
	{ memberId: "student_1", memberName: "김바다" },
	{ memberId: "student_2", memberName: "" },
];
const base = { ownUserId: "teacher", ownName: "선생님T", members, teacherLabel: "선생님" };

describe("resolveSenderName", () => {
	it("본인은 본인 이름", () => {
		expect(resolveSenderName("teacher", "manager", base)).toBe("선생님T");
	});
	it("명단의 구성원은 이름(이름 없으면 id)", () => {
		expect(resolveSenderName("student_1", "member", base)).toBe("김바다");
		expect(resolveSenderName("student_2", "member", base)).toBe("student_2");
	});
	it("모르는 운영자 작성자는 교사 라벨", () => {
		expect(resolveSenderName("other_teacher", "manager", { ...base, ownUserId: "me" })).toBe("선생님");
	});
	it("모르는 구성원은 id 그대로", () => {
		expect(resolveSenderName("ghost", "member", { ...base, ownUserId: "me" })).toBe("ghost");
	});
});

describe("resolveMemberNames", () => {
	it("이름 매핑(없으면 id)", () => {
		expect(resolveMemberNames(["student_1", "student_2", "x"], members)).toEqual(["김바다", "student_2", "x"]);
	});
});
