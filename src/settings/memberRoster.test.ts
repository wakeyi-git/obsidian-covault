import { describe, it, expect } from "vitest";
import { parseMemberRoster, finalizeRoster } from "./memberRoster";

describe("parseMemberRoster", () => {
	it("쉼표/공백/이름만 형식을 파싱", () => {
		const r = parseMemberRoster("홍길동,hong\n김학생 kim_student\n이영희");
		expect(r).toEqual([
			{ name: "홍길동", id: "hong" },
			{ name: "김학생", id: "kim_student" },
			{ name: "이영희", id: "" },
		]);
	});

	it("빈 줄·# 주석은 건너뛴다", () => {
		expect(parseMemberRoster("# 명단\n\n홍길동,hong\n")).toEqual([{ name: "홍길동", id: "hong" }]);
	});

	it("공백 이름(비-ASCII 끝 토큰)은 ID로 보지 않는다", () => {
		// 마지막 토큰이 ASCII id 형태가 아니면 전체를 이름으로
		expect(parseMemberRoster("홍 길동")).toEqual([{ name: "홍 길동", id: "" }]);
	});
});

describe("finalizeRoster", () => {
	it("ID 없으면 이름 슬러그, 비-ASCII면 student 폴백", () => {
		const r = finalizeRoster([{ name: "John Doe", id: "" }, { name: "홍길동", id: "" }], []);
		expect(r[0].id).toBe("john_doe");
		expect(r[1].id).toBe("member");
		expect(r[0].remoteDb).toBe("mirror_john_doe");
	});

	it("기존/배치 중복은 접미사로 고유화하고 adjusted 표시", () => {
		const r = finalizeRoster([{ name: "A", id: "hong" }, { name: "B", id: "hong" }], ["hong"]);
		expect(r[0].id).toBe("hong_2");
		expect(r[1].id).toBe("hong_3");
		expect(r[0].adjusted).toBe(true);
	});

	it("명시 ID는 정규화(소문자/허용문자)", () => {
		const r = finalizeRoster([{ name: "A", id: "Kim Member!" }], []);
		expect(r[0].id).toBe("kim_member");
	});

	it("이름 없으면 emptyName 표시", () => {
		const r = finalizeRoster([{ name: "", id: "x" }], []);
		expect(r[0].emptyName).toBe(true);
	});
});
