import { describe, it, expect } from "vitest";
import { parseMemberRoster, finalizeRoster } from "./memberRoster";

describe("parseMemberRoster", () => {
	it("쉼표/공백/이름만 형식을 파싱", () => {
		const r = parseMemberRoster("홍길동,hong\n김학생 kim_member\n이영희");
		expect(r).toEqual([
			{ name: "홍길동", id: "hong", folder: "" },
			{ name: "김학생", id: "kim_member", folder: "" },
			{ name: "이영희", id: "", folder: "" },
		]);
	});

	it("쉼표 세 번째 칸은 폴더로 파싱", () => {
		const r = parseMemberRoster("김학생,kim,학생/3반\n이영희,,모둠1");
		expect(r).toEqual([
			{ name: "김학생", id: "kim", folder: "학생/3반" },
			{ name: "이영희", id: "", folder: "모둠1" },
		]);
	});

	it("빈 줄·# 주석은 건너뛴다", () => {
		expect(parseMemberRoster("# 명단\n\n홍길동,hong\n")).toEqual([{ name: "홍길동", id: "hong", folder: "" }]);
	});

	it("공백 이름(비-ASCII 끝 토큰)은 ID로 보지 않는다", () => {
		// 마지막 토큰이 ASCII id 형태가 아니면 전체를 이름으로
		expect(parseMemberRoster("홍 길동")).toEqual([{ name: "홍 길동", id: "", folder: "" }]);
	});
});

describe("finalizeRoster", () => {
	it("ID 없으면 이름 슬러그, 비-ASCII면 member 폴백", () => {
		const r = finalizeRoster([{ name: "John Doe", id: "", folder: "" }, { name: "홍길동", id: "", folder: "" }], []);
		expect(r[0].id).toBe("john_doe");
		expect(r[1].id).toBe("member");
		expect(r[0].remoteDb).toBe("mirror_john_doe");
	});

	it("기존/배치 중복은 접미사로 고유화하고 adjusted 표시", () => {
		const r = finalizeRoster([{ name: "A", id: "hong", folder: "" }, { name: "B", id: "hong", folder: "" }], ["hong"]);
		expect(r[0].id).toBe("hong_2");
		expect(r[1].id).toBe("hong_3");
		expect(r[0].adjusted).toBe(true);
	});

	it("명시 ID는 정규화(소문자/허용문자)", () => {
		const r = finalizeRoster([{ name: "A", id: "Kim Member!", folder: "" }], []);
		expect(r[0].id).toBe("kim_member");
	});

	it("이름 없으면 emptyName 표시", () => {
		const r = finalizeRoster([{ name: "", id: "x", folder: "" }], []);
		expect(r[0].emptyName).toBe(true);
	});

	it("폴더: 줄에 명시한 값을 슬래시 정규화해 그대로 사용", () => {
		const r = finalizeRoster([{ name: "A", id: "a", folder: "/학생/3반/" }], [], "무시됨");
		expect(r[0].folder).toBe("학생/3반");
	});

	it("폴더: 미명시 + 기본 폴더 → 기본/이름", () => {
		const r = finalizeRoster([{ name: "홍길동", id: "hong", folder: "" }], [], "학생/");
		expect(r[0].folder).toBe("학생/홍길동");
	});

	it("폴더: 미명시 + 기본 폴더 없음 → 빈 값(초대 시 자동)", () => {
		const r = finalizeRoster([{ name: "홍길동", id: "hong", folder: "" }], []);
		expect(r[0].folder).toBe("");
	});
});
