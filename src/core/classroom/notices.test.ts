import { describe, it, expect } from "vitest";
import { slugify, noticeFilePath, sortNotices, summarizeResponses } from "./notices";
import { NoticeDoc, ResponseDoc } from "../model/types";

describe("slugify / noticeFilePath", () => {
	it("경로 불법문자 제거, 공백→대시, 한글 유지", () => {
		expect(slugify("1차시: 수학/과제 *주의*")).toBe("1차시-수학-과제-주의");
		expect(slugify("   ")).toBe("notice");
	});

	it("파일 경로는 폴더 아래 알림장/<stamp>-<slug>.md", () => {
		const p = noticeFilePath("_학급", 1_700_000_000_000, "오늘의 안내");
		expect(p.startsWith("_학급/알림장/")).toBe(true);
		expect(p.endsWith("-오늘의-안내.md")).toBe(true);
	});
});

function notice(over: Partial<NoticeDoc>): NoticeDoc {
	return {
		_id: "notice:" + (over.uid ?? "x"),
		type: "notice",
		schemaVersion: 1,
		workspaceId: "ws",
		uid: over.uid ?? "x",
		title: over.title ?? "t",
		filePath: "_학급/알림장/x.md",
		postedAtMs: over.postedAtMs ?? 0,
		createdBy: "u",
		createdByRole: "manager",
		...over,
	};
}

describe("sortNotices", () => {
	it("삭제 제외, 고정 먼저, 최신순", () => {
		const out = sortNotices([
			notice({ uid: "a", postedAtMs: 100 }),
			notice({ uid: "b", postedAtMs: 300, pinned: true }),
			notice({ uid: "c", postedAtMs: 200 }),
			notice({ uid: "d", postedAtMs: 999, deleted: true }),
			notice({ uid: "e", postedAtMs: 50, pinned: true }),
		]);
		expect(out.map((n) => n.uid)).toEqual(["b", "e", "c", "a"]);
	});
});

function resp(over: Partial<ResponseDoc>): ResponseDoc {
	return {
		_id: "response:notice:n1:" + (over.kind ?? "read") + ":" + (over.byUser ?? "u"),
		type: "response",
		schemaVersion: 1,
		workspaceId: "ws",
		targetId: "notice:n1",
		kind: over.kind ?? "read",
		byUser: over.byUser ?? "u",
		byRole: "member",
		createdAtMs: over.createdAtMs ?? 0,
		...over,
	};
}

describe("summarizeResponses", () => {
	it("읽음 명단/미읽음/댓글 스레드 집계", () => {
		const r = summarizeResponses(
			[
				resp({ kind: "read", byUser: "a" }),
				resp({ kind: "read", byUser: "a" }), // 중복 → 1명
				resp({ kind: "comment", byUser: "b", body: "질문있어요", createdAtMs: 20 }),
				resp({ kind: "question", byUser: "c", body: "이거 뭐죠", createdAtMs: 10 }),
				resp({ kind: "read", byUser: "d", deleted: true }), // 삭제 제외
			],
			["a", "b", "c", "d"],
		);
		expect(r.readUsers.sort()).toEqual(["a"]);
		expect(r.readCount).toBe(1);
		expect(r.unread.sort()).toEqual(["b", "c", "d"]);
		expect(r.comments.map((c) => c.byUser)).toEqual(["c", "b"]); // createdAtMs asc
	});
});
