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
function state(
	uid: string,
	memberId: string,
	assignedAtMs: number,
	st: "assigned" | "submitted" | "returned",
	score?: number,
	submittedAtMs?: number,
	extra?: Partial<AssignmentStateDoc>,
): AssignmentStateDoc {
	return { _id: `assignment-state:${uid}:${memberId}`, type: "assignment-state", schemaVersion: 1, workspaceId: "ws", assignmentUid: uid, memberId, title: uid, workPaths: [], state: st, assignedAtMs, submittedAtMs, grade: score != null ? { score } : undefined, ...extra } as AssignmentStateDoc;
}
function routineDoc(uid: string, createdAtMs: number, itemIds: string[]): RoutineDoc {
	return { _id: `routine:${uid}`, type: "routine", schemaVersion: 1, workspaceId: "ws", uid, title: uid, items: itemIds.map((id) => ({ id, label: id, recurrence: "daily" as const })), createdBy: "t", createdAtMs } as RoutineDoc;
}
function routineState(uid: string, memberId: string, day: string, checked: string[]): RoutineStateDoc {
	return { _id: `routine-state:${uid}:${memberId}:${day}`, type: "routine-state", schemaVersion: 1, workspaceId: "ws", routineUid: uid, memberId, day, checked, updatedAtMs: T0 } as RoutineStateDoc;
}
function comment(targetId: string, byUser: string, createdAtMs: number, kind: "comment" | "question" = "comment", deleted?: boolean): ResponseDoc {
	return { _id: `response:${targetId}:${kind}:${byUser}:${createdAtMs}`, type: "response", schemaVersion: 1, workspaceId: "ws", targetId, kind, byUser, byRole: "member", createdAtMs, deleted } as ResponseDoc;
}

describe("computeStats", () => {
	const members = [{ memberId: "a", memberName: "A" }, { memberId: "b", memberName: "B" }];
	const base: StatsInput = {
		startMs: new Date("2026-06-01T00:00").getTime(),
		endMs: new Date("2026-06-07T23:59:59").getTime(),
		nowMs: new Date("2026-06-07T23:59:59").getTime(),
		members,
		notices: [notice("n1", T0, "notice"), notice("n2", T0 + DAY, "notice"), notice("l1", T0, "lesson")],
		reads: [read("notice:n1", "a"), read("notice:l1", "a")],
		states: [state("x", "a", T0, "returned", 80, T0), state("x", "b", T0, "submitted", undefined, T0)],
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

	it("진행률: 실제 제출(submittedAtMs)만 집계 — A·B 모두 100%", () => {
		const r = computeStats(base);
		expect(ratePct(r[0].progress)).toBe(100);
		expect(ratePct(r[1].progress)).toBe(100);
	});

	it("미제출인데 교사가 바로 반환한 과제는 제출로 집계되지 않는다", () => {
		// 제출 없이 반환(submittedAtMs 없음) → 진행률 0/1, 채점률 1/1
		const r = computeStats({ ...base, states: [state("z", "a", T0, "returned", 50)] });
		expect(r[0].progress).toEqual({ num: 0, den: 1 });
		expect(r[0].graded).toEqual({ num: 1, den: 1 });
	});

	it("제출율(마감 책임 기준): 마감 전 미제출은 분모 제외", () => {
		const due = base.nowMs + DAY; // 아직 안 지난 마감
		const r = computeStats({ ...base, states: [state("p", "a", T0, "assigned", undefined, undefined, { dueAt: due })] });
		expect(r[0].submit).toEqual({ num: 0, den: 0 });
		expect(ratePct(r[0].submit)).toBeNull();
		// 진행률에는 잡힌다
		expect(r[0].progress).toEqual({ num: 0, den: 1 });
	});

	it("제출율: 마감 경과 미제출은 분모 포함, 마감 없는 미제출은 제외, 제출분은 항상 포함", () => {
		const past = base.nowMs - DAY;
		const r = computeStats({
			...base,
			states: [
				state("p1", "a", T0, "assigned", undefined, undefined, { dueAt: past }), // 마감 경과 미제출 → den
				state("p2", "a", T0, "assigned"), // 마감 없음 미제출 → 제외
				state("p3", "a", T0, "submitted", undefined, T0), // 마감 없음 제출 → num·den
			],
		});
		expect(r[0].submit).toEqual({ num: 1, den: 2 });
	});

	it("정시 제출율: 마감 내 제출만 정시, 마감 없는 제출은 판별 제외", () => {
		const due = T0 + DAY;
		const r = computeStats({
			...base,
			states: [
				state("o1", "a", T0, "submitted", undefined, due - 1, { dueAt: due }), // 정시
				state("o2", "a", T0, "submitted", undefined, due + 1, { dueAt: due }), // 지각
				state("o3", "a", T0, "submitted", undefined, T0), // 마감 없음 → 제외
			],
		});
		expect(r[0].onTime).toEqual({ num: 1, den: 2 });
		expect(ratePct(r[1].onTime)).toBeNull();
	});

	it("채점 진행률: 제출 2건 중 반환 1건 → 50%", () => {
		const r = computeStats({
			...base,
			states: [state("g1", "a", T0, "returned", 90, T0), state("g2", "a", T0, "submitted", undefined, T0)],
		});
		expect(r[0].graded).toEqual({ num: 1, den: 2 });
	});

	it("평균 점수: 만점 가중 풀링 — A=Σ득점/Σ만점, B=채점없음 null", () => {
		// A: 100점만점 50점 + 10점만점 10점 → (50+10)/(100+10)=54.5% → 반올림 55
		const r = computeStats({
			...base,
			states: [state("x", "a", T0, "returned", 50, T0), state("y", "a", T0, "returned", 10, T0)],
			maxByUid: new Map([["x", 100], ["y", 10]]),
		});
		expect(r[0].avgScorePct).toBe(55);
		expect(r[0].scoreSum).toBe(60);
		expect(r[0].maxSum).toBe(110);
		expect(r[1].avgScorePct).toBeNull();
		expect(r[1].maxSum).toBe(0);
	});

	it("평균 점수: 코멘트만 있는 반환은 0점으로 풀링하지 않는다", () => {
		const commentOnly = state("c", "a", T0, "returned", undefined, T0, { grade: { comment: "잘했어요" } });
		const r = computeStats({ ...base, states: [commentOnly], maxByUid: new Map([["c", 100]]) });
		expect(r[0].avgScorePct).toBeNull();
		expect(r[0].maxSum).toBe(0);
	});

	it("평균 점수: 루브릭 점수 합산", () => {
		const rubric = state("r", "a", T0, "returned", undefined, T0, { grade: { rubricScores: { c1: 3, c2: 4 } } });
		const r = computeStats({ ...base, states: [rubric], maxByUid: new Map([["r", 10]]) });
		expect(r[0].avgScorePct).toBe(70);
	});

	it("평균 점수: 배포 스냅샷(maxPoints)이 정의(maxByUid)보다 우선", () => {
		const s = state("m", "a", T0, "returned", 10, T0, { maxPoints: 20 });
		const r = computeStats({ ...base, states: [s], maxByUid: new Map([["m", 100]]) });
		expect(r[0].avgScorePct).toBe(50); // 10/20, 10/100 아님
	});

	it("기간 밖 과제는 제외", () => {
		const r = computeStats({ ...base, states: [state("y", "a", T0 - 30 * DAY, "submitted", undefined, T0 - 30 * DAY)] });
		expect(r[0].progress.den).toBe(0);
		expect(ratePct(r[0].progress)).toBeNull();
	});

	it("체크리스트 완료율: 매일 항목 2개, 7일 중 A가 하루 1개 체크", () => {
		const routines = [routineDoc("r", T0, ["i1", "i2"])];
		const rs = [routineState("r", "a", "2026-06-01", ["i1"])];
		const r = computeStats({ ...base, routines, routineStates: rs });
		// 7일 × 2항목 = 14 분모, A는 1 체크
		expect(r[0].routine).toEqual({ num: 1, den: 14 });
		expect(r[1].routine).toEqual({ num: 0, den: 14 });
	});

	it("체크리스트: 아직 오지 않은 날은 분모에서 제외", () => {
		const routines = [routineDoc("r", T0, ["i1", "i2"])];
		// 기간은 6/1~6/7이지만 현재가 6/3 → 6/1·6/2·6/3만 분모
		const nowMs = new Date("2026-06-03T12:00").getTime();
		const r = computeStats({ ...base, nowMs, routines });
		expect(r[0].routine.den).toBe(6); // 3일 × 2항목
	});

	it("체크리스트: 루틴 생성일 이전 날짜는 분모에서 제외", () => {
		const routines = [routineDoc("r", new Date("2026-06-05T10:00").getTime(), ["i1"])];
		const r = computeStats({ ...base, routines });
		expect(r[0].routine.den).toBe(3); // 6/5·6/6·6/7
	});

	it("연속 달성: 루틴별 streak의 최댓값", () => {
		const routines = [routineDoc("r1", T0, ["i1"]), routineDoc("r2", T0, ["j1"])];
		// r1: 6/6~6/7 이틀 완료, r2: 6/7 하루 완료 → bestStreak 2
		const rs = [
			routineState("r1", "a", "2026-06-06", ["i1"]),
			routineState("r1", "a", "2026-06-07", ["i1"]),
			routineState("r2", "a", "2026-06-07", ["j1"]),
		];
		const r = computeStats({ ...base, routines, routineStates: rs });
		expect(r[0].bestStreak).toBe(2);
		expect(r[1].bestStreak).toBe(0);
	});

	it("참여도: 기간 내 본인 댓글·질문만 집계, 미제공 시 null", () => {
		const responses = [
			comment("notice:n1", "a", T0), // 포함
			comment("notice:n1", "a", T0 + DAY, "question"), // 포함
			comment("notice:n1", "a", T0 - 30 * DAY), // 기간 밖
			comment("notice:n1", "b", T0, "comment", true), // 삭제됨
			read("notice:n2", "a"), // read는 제외
		];
		const r = computeStats({ ...base, responses });
		expect(r[0].participation).toBe(2);
		expect(r[1].participation).toBe(0);
		const r2 = computeStats(base);
		expect(r2[0].participation).toBeNull();
	});
});
