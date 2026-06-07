import { describe, it, expect } from "vitest";
import { slugify, noticeFilePath, sortNotices, summarizeResponses, sortLessonsBySchedule, staleNoticesForPath, LessonSlot } from "./notices";
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

describe("sortLessonsBySchedule", () => {
	const L = (uid: string, postedAtMs = 0) => ({ uid, postedAtMs });
	// 슬롯: 월(0)1교시=a, 월2교시=b, 화(1)1교시=c, 수(2)=d
	const slots = new Map<string, LessonSlot>([
		["a", { day: 0, period: 0 }],
		["b", { day: 0, period: 1 }],
		["c", { day: 1, period: 0 }],
		["d", { day: 2, period: 0 }],
	]);

	it("오늘(화=1) 우선, 같은 날은 교시 순, 이후 요일 회전", () => {
		const out = sortLessonsBySchedule([L("a"), L("b"), L("c"), L("d")], slots, 1, 5);
		// 화(c) → 수(d) → ... → 월(a,b) 맨 뒤(회전). 월은 a(1교시)→b(2교시).
		expect(out.map((x) => x.uid)).toEqual(["c", "d", "a", "b"]);
	});

	it("월(0)이 오늘이면 월부터 교시 순", () => {
		const out = sortLessonsBySchedule([L("d"), L("b"), L("a"), L("c")], slots, 0, 5);
		expect(out.map((x) => x.uid)).toEqual(["a", "b", "c", "d"]);
	});

	it("미연결 수업은 뒤로(최신순)", () => {
		const out = sortLessonsBySchedule([L("z1", 100), L("a"), L("z2", 200)], slots, 0, 5);
		expect(out.map((x) => x.uid)).toEqual(["a", "z2", "z1"]);
	});
});

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

describe("staleNoticesForPath", () => {
	it("같은 경로에서 keepUid가 아닌 비삭제 문서만 반환", () => {
		const docs = [
			notice({ uid: "new", filePath: "_학급/수업/a.md" }),
			notice({ uid: "old", filePath: "_학급/수업/a.md" }),
			notice({ uid: "old2", filePath: "_학급/수업/a.md", deleted: true }), // 이미 삭제 → 제외
			notice({ uid: "other", filePath: "_학급/수업/b.md" }), // 다른 경로 → 제외
		];
		const stale = staleNoticesForPath(docs, "_학급/수업/a.md", "new");
		expect(stale.map((n) => n.uid)).toEqual(["old"]);
	});

	it("중복이 없으면 빈 배열", () => {
		const docs = [notice({ uid: "new", filePath: "_학급/수업/a.md" })];
		expect(staleNoticesForPath(docs, "_학급/수업/a.md", "new")).toEqual([]);
	});
});
