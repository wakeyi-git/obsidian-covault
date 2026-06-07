import { describe, it, expect } from "vitest";
import { computeStats, ratePct, StatsInput } from "./stats";
import { NoticeDoc, ResponseDoc, AssignmentStateDoc, RoutineDoc, RoutineStateDoc } from "../model/types";

const DAY = 86_400_000;
const T0 = new Date("2026-06-01T09:00").getTime();

function notice(uid: string, postedAtMs: number, category: "notice" | "lesson"): NoticeDoc {
	return { _id: `notice:${uid}`, type: "notice", schemaVersion: 1, workspaceId: "ws", uid, title: uid, filePath: "", postedAtMs, category, createdBy: "t", createdByRole: "manager" } as NoticeDoc;
}
function read(targetId: string, byUser: string): ResponseDoc {
	return { _id: `response:${targetId}:read:${byUser}`, type: "response", schemaVersion: 1, workspaceId: "ws", targetId, kind: "read", byUser, byRole: "member", createdAtMs: T0 } as ResponseDoc;
}
function state(uid: string, memberId: string, assignedAtMs: number, st: "assigned" | "submitted" | "returned", score?: number): AssignmentStateDoc {
	return { _id: `assignment-state:${uid}:${memberId}`, type: "assignment-state", schemaVersion: 1, workspaceId: "ws", assignmentUid: uid, memberId, title: uid, workPaths: [], state: st, assignedAtMs, grade: score != null ? { score } : undefined } as AssignmentStateDoc;
}

describe("computeStats", () => {
	const members = [{ memberId: "a", memberName: "A" }, { memberId: "b", memberName: "B" }];
	const base: StatsInput = {
		startMs: new Date("2026-06-01T00:00").getTime(),
		endMs: new Date("2026-06-07T23:59:59").getTime(),
		members,
		notices: [notice("n1", T0, "notice"), notice("n2", T0 + DAY, "notice"), notice("l1", T0, "lesson")],
		reads: [read("notice:n1", "a"), read("notice:l1", "a")],
		states: [state("x", "a", T0, "returned", 80), state("x", "b", T0, "submitted")],
		maxByUid: new Map([["x", 100]]),
		routines: [],
		routineStates: [],
	};

	it("알림장 확인율: A는 2개 중 1개, B는 0개", () => {
		const r = computeStats(base);
		expect(ratePct(r[0].noticeRead)).toBe(50);
		expect(ratePct(r[1].noticeRead)).toBe(0);
	});

	it("수업 확인율: A 100%, B 0%", () => {
		const r = computeStats(base);
		expect(ratePct(r[0].lessonRead)).toBe(100);
		expect(ratePct(r[1].lessonRead)).toBe(0);
	});

	it("과제 제출율: A 반환=제출로 집계 100%, B 제출 100%", () => {
		const r = computeStats(base);
		expect(ratePct(r[0].submit)).toBe(100);
		expect(ratePct(r[1].submit)).toBe(100);
	});

	it("평균 점수: A=80%, B=채점없음 null", () => {
		const r = computeStats(base);
		expect(r[0].avgScorePct).toBe(80);
		expect(r[1].avgScorePct).toBeNull();
	});

	it("기간 밖 과제는 제외", () => {
		const r = computeStats({ ...base, states: [state("y", "a", T0 - 30 * DAY, "submitted")] });
		expect(r[0].submit.den).toBe(0);
		expect(ratePct(r[0].submit)).toBeNull();
	});

	it("체크리스트 완료율: 매일 항목 2개, 7일 중 A가 하루 1개 체크", () => {
		const routines: RoutineDoc[] = [{ _id: "routine:r", type: "routine", schemaVersion: 1, workspaceId: "ws", uid: "r", title: "r", items: [{ id: "i1", label: "x", recurrence: "daily" }, { id: "i2", label: "y", recurrence: "daily" }], createdBy: "t", createdAtMs: T0 } as RoutineDoc];
		const rs: RoutineStateDoc[] = [{ _id: "x", type: "routine-state", schemaVersion: 1, workspaceId: "ws", routineUid: "r", memberId: "a", day: "2026-06-01", checked: ["i1"], updatedAtMs: T0 } as RoutineStateDoc];
		const r = computeStats({ ...base, routines, routineStates: rs });
		// 7일 × 2항목 = 14 분모, A는 1 체크
		expect(r[0].routine).toEqual({ num: 1, den: 14 });
		expect(r[1].routine).toEqual({ num: 0, den: 14 });
	});
});
