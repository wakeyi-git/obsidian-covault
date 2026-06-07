import { describe, it, expect } from "vitest";
import {
	defaultTemplate,
	defaultTemplatePath,
	applyNoticeVars,
	noticeFieldsFromFrontmatter,
} from "./templates";

describe("templates", () => {
	it("내장 기본 템플릿은 유형별 covault 마커를 포함", () => {
		expect(defaultTemplate("notice")).toContain("covault: notice");
		expect(defaultTemplate("lesson")).toContain("covault: lesson");
		// 과제 템플릿은 프론트매터 마커 없이 본문 치환 변수만.
		expect(defaultTemplate("assignment")).toContain("{{memberName}}");
		expect(defaultTemplate("assignment")).not.toContain("covault:");
	});

	it("기본 템플릿 경로는 유형별 파일명", () => {
		expect(defaultTemplatePath("notice")).toBe("_템플릿/알림장.md");
		expect(defaultTemplatePath("lesson")).toBe("_템플릿/수업.md");
		expect(defaultTemplatePath("assignment")).toBe("_템플릿/과제.md");
	});

	it("applyNoticeVars는 title/week/date를 치환(미지정은 빈 문자열)", () => {
		const out = applyNoticeVars("{{title}} / {{week}} / {{date}}", { title: "현장학습", week: "2026-06-08", date: "2026-06-07" });
		expect(out).toBe("현장학습 / 2026-06-08 / 2026-06-07");
		expect(applyNoticeVars("[{{title}}]", {})).toBe("[]");
	});
});

describe("noticeFieldsFromFrontmatter", () => {
	it("covault 마커가 없으면 null", () => {
		expect(noticeFieldsFromFrontmatter({ title: "x" }, "fb")).toBeNull();
		expect(noticeFieldsFromFrontmatter(undefined, "fb")).toBeNull();
		expect(noticeFieldsFromFrontmatter({ covault: "other" }, "fb")).toBeNull();
	});

	it("알림장 필드 매핑(기본값: published=false, pinned=false, responses=true)", () => {
		const f = noticeFieldsFromFrontmatter({ covault: "notice", title: "안내" }, "fb");
		expect(f).toEqual({ category: "notice", title: "안내", published: false, pinned: false, allowResponses: true, weekKey: undefined });
	});

	it("빈 제목은 fallback로 보완", () => {
		expect(noticeFieldsFromFrontmatter({ covault: "notice", title: "  " }, "20260607-안내")?.title).toBe("20260607-안내");
	});

	it("published/pinned는 true일 때만 켜지고 responses는 false일 때만 꺼짐", () => {
		const f = noticeFieldsFromFrontmatter({ covault: "notice", title: "t", published: true, pinned: true, responses: false }, "fb");
		expect(f).toMatchObject({ published: true, pinned: true, allowResponses: false });
	});

	it("수업은 week를 weekKey로(알림장은 weekKey 없음)", () => {
		const lesson = noticeFieldsFromFrontmatter({ covault: "lesson", title: "수학", week: "2026-06-08" }, "fb");
		expect(lesson).toMatchObject({ category: "lesson", weekKey: "2026-06-08" });
		const notice = noticeFieldsFromFrontmatter({ covault: "notice", title: "x", week: "2026-06-08" }, "fb");
		expect(notice?.weekKey).toBeUndefined();
	});
});
