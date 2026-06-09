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
	messageId,
	messagePrefix,
	dmChannel,
	CLASS_CHANNEL,
	groupChannel,
	parseGroupChannel,
	chatGroupId,
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

describe("message id ↔ prefix 정합(DM 목록 조회)", () => {
	it("채널 prefix는 그 채널 메시지 id의 접두사여야 한다(class)", () => {
		const id = messageId(CLASS_CHANNEL, "u1");
		expect(id.startsWith(messagePrefix(CLASS_CHANNEL))).toBe(true);
	});

	it("DM 채널도 prefix가 정확히 매칭(이중 콜론 회귀 방지)", () => {
		const ch = dmChannel("member_a"); // "dm:member_a"
		const id = messageId(ch, "u1"); // "message:dm:member_a:u1"
		expect(messagePrefix(ch)).toBe("message:dm:member_a:");
		expect(id.startsWith(messagePrefix(ch))).toBe(true);
		// 과거 버그: messagePrefix("dm:")="message:dm::"는 어떤 DM id도 매칭하지 못했다.
		expect(id.startsWith("message:dm::")).toBe(false);
	});
});

describe("group 채널 ↔ prefix 정합", () => {
	it("groupChannel/parseGroupChannel 왕복(remoteDb·groupId 보존)", () => {
		const ch = groupChannel("share_home", "g1abc");
		expect(ch).toBe("group:share_home:g1abc");
		expect(parseGroupChannel(ch)).toEqual({ remoteDb: "share_home", groupId: "g1abc" });
	});
	it("group이 아니면 null", () => {
		expect(parseGroupChannel("class")).toBeNull();
		expect(parseGroupChannel(dmChannel("member_a"))).toBeNull();
	});
	it("메시지 id가 group 채널 prefix로 매칭", () => {
		const ch = groupChannel("share_home", "g1");
		expect(messageId(ch, "u1").startsWith(messagePrefix(ch))).toBe(true);
	});
	it("chatGroupId", () => {
		expect(chatGroupId("g1abc")).toBe("chatgroup:g1abc");
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
