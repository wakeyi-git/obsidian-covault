import { describe, it, expect } from "vitest";
import {
	noticeId,
	responseId,
	responsePrefix,
	assignmentId,
	assignmentStateId,
	routineId,
	routineStateId,
	isTextAnchor,
	isExcalidrawAnchor,
	FeedbackAnchor,
} from "./types";

describe("classroom id 헬퍼", () => {
	it("notice/assignment/routine id는 prefix를 붙인다", () => {
		expect(noticeId("n1")).toBe("notice:n1");
		expect(assignmentId("a1")).toBe("assignment:a1");
		expect(routineId("r1")).toBe("routine:r1");
	});

	it("response: read는 사용자당 1개(idempotent), comment/question은 uid로 분리", () => {
		expect(responseId("notice:n1", "member_a", "read")).toBe("response:notice:n1:read:member_a");
		// read는 uid를 줘도 무시(같은 키)
		expect(responseId("notice:n1", "member_a", "read", "x")).toBe("response:notice:n1:read:member_a");
		expect(responseId("notice:n1", "member_a", "comment", "u9")).toBe("response:notice:n1:comment:member_a:u9");
		expect(responsePrefix("notice:n1")).toBe("response:notice:n1:");
	});

	it("assignment-state/routine-state id는 (대상,학생[,날짜])로 키", () => {
		expect(assignmentStateId("a1", "member_a")).toBe("assignment-state:a1:member_a");
		expect(routineStateId("r1", "member_a", "2026-06-06")).toBe("routine-state:r1:member_a:2026-06-06");
	});

	it("서로 다른 학생/날짜는 키가 분리된다", () => {
		expect(assignmentStateId("a1", "member_a")).not.toBe(assignmentStateId("a1", "member_b"));
		expect(routineStateId("r1", "member_a", "2026-06-06")).not.toBe(routineStateId("r1", "member_a", "2026-06-07"));
	});
});

describe("FeedbackAnchor 판별 + 하위호환", () => {
	it("kind 없는 기존 앵커는 text로 간주", () => {
		const legacy = { textQuote: "안녕", start: 0, end: 2 } as FeedbackAnchor;
		expect(isTextAnchor(legacy)).toBe(true);
		expect(isExcalidrawAnchor(legacy)).toBe(false);
	});

	it("excalidraw 앵커 판별", () => {
		const a: FeedbackAnchor = { kind: "excalidraw", elementIds: ["e1", "e2"], point: { x: 10, y: 20 } };
		expect(isExcalidrawAnchor(a)).toBe(true);
		expect(isTextAnchor(a)).toBe(false);
	});

	it("kind:text 명시도 text로 간주", () => {
		const a: FeedbackAnchor = { kind: "text", textQuote: "x", start: 1, end: 2 };
		expect(isTextAnchor(a)).toBe(true);
	});
});
