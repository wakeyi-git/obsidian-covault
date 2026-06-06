import { describe, it, expect } from "vitest";
import {
	assignmentWorkDir,
	substituteTemplate,
	displayStatus,
	buildMatrix,
	statusCounts,
	criterionMax,
	rubricMax,
	gradeTotal,
	gradebookCsv,
} from "./assignments";
import { AssignmentStateDoc, AssignmentDoc, RubricCriterion } from "../model/types";

describe("assignmentWorkDir / substituteTemplate", () => {
	it("개인=교사측 <root>/_과제, 학생측(root='')은 _과제, 공유=학급/과제", () => {
		expect(assignmentWorkDir("mirror", "학생A", "_학급", "s1")).toBe("학생A/_과제/s1");
		expect(assignmentWorkDir("mirror", "", "_학급", "s1")).toBe("_과제/s1");
		expect(assignmentWorkDir("shared", "학생A", "_학급", "s1")).toBe("_학급/과제/s1");
	});
	it("템플릿 변수 치환", () => {
		const out = substituteTemplate("안녕 {{memberName}}({{memberId}}) {{date}}", {
			memberId: "a",
			memberName: "철수",
			workspaceId: "ws",
			date: "2026-06-06",
		});
		expect(out).toBe("안녕 철수(a) 2026-06-06");
	});
});

function state(over: Partial<AssignmentStateDoc>): AssignmentStateDoc {
	return {
		_id: "assignment-state:a1:" + (over.memberId ?? "m"),
		type: "assignment-state",
		schemaVersion: 1,
		workspaceId: "ws",
		assignmentUid: "a1",
		memberId: over.memberId ?? "m",
		title: "t",
		workPaths: [],
		state: over.state ?? "assigned",
		assignedAtMs: 0,
		...over,
	};
}

describe("displayStatus", () => {
	it("반환/제출(정시·지각)/마감초과/배정", () => {
		expect(displayStatus(state({ state: "returned" }), 100)).toBe("returned");
		expect(displayStatus(state({ state: "submitted", submittedAtMs: 50, dueAt: 100 }), 200)).toBe("submitted");
		expect(displayStatus(state({ state: "submitted", submittedAtMs: 150, dueAt: 100 }), 200)).toBe("submitted-late");
		expect(displayStatus(state({ state: "assigned", dueAt: 100 }), 200)).toBe("overdue");
		expect(displayStatus(state({ state: "assigned", dueAt: 100 }), 50)).toBe("assigned");
		expect(displayStatus(state({ state: "assigned" }), 999)).toBe("assigned");
	});
});

describe("buildMatrix / statusCounts", () => {
	const def: Pick<AssignmentDoc, "uid" | "targetMembers" | "dueAt"> = { uid: "a1", targetMembers: ["a", "b", "c"], dueAt: 100 };
	const members = [
		{ memberId: "a", memberName: "철수" },
		{ memberId: "b", memberName: "영희" },
		{ memberId: "c", memberName: "민수" },
	];

	it("상태 문서 없으면 마감 기준 assigned/overdue, 있으면 병합", () => {
		const rows = buildMatrix(def, members, [state({ memberId: "a", state: "submitted", submittedAtMs: 50, dueAt: 100 })], 200);
		expect(rows.find((r) => r.memberId === "a")?.status).toBe("submitted");
		expect(rows.find((r) => r.memberId === "b")?.status).toBe("overdue"); // 상태 없음 + 마감 지남
		expect(rows.find((r) => r.memberId === "a")?.memberName).toBe("철수");
		const c = statusCounts(rows);
		expect(c.submitted).toBe(1);
		expect(c.overdue).toBe(2);
	});
});

describe("rubric 채점", () => {
	const rubric: RubricCriterion[] = [
		{ id: "c1", title: "정확성", levels: [{ label: "만점", points: 10 }] },
		{ id: "c2", title: "표현", levels: [{ label: "상", points: 3 }, { label: "중", points: 2 }] },
	];
	it("criterionMax/rubricMax", () => {
		expect(criterionMax(rubric[0])).toBe(10);
		expect(criterionMax(rubric[1])).toBe(5);
		expect(rubricMax(rubric)).toBe(15);
		expect(rubricMax(undefined)).toBe(0);
	});
	it("gradeTotal: 루브릭 있으면 기준별 합, 없으면 score", () => {
		expect(gradeTotal({ rubricScores: { c1: 9, c2: 4 } }, rubric)).toBe(13);
		expect(gradeTotal({ score: 88 }, undefined)).toBe(88);
		expect(gradeTotal(undefined, rubric)).toBe(0);
	});
});

describe("gradebookCsv", () => {
	it("헤더 + 구성원별 점수, grade 없으면 빈칸, 특수문자 이스케이프", () => {
		const defs = [
			{ uid: "a1", title: "과제1", points: 100 },
			{ uid: "a2", title: "에세이, 1편", points: 50 }, // 쉼표 → 따옴표 이스케이프
		];
		const members = [
			{ memberId: "a", memberName: "철수" },
			{ memberId: "b", memberName: "영희" },
		];
		const map = new Map<string, Map<string, AssignmentStateDoc>>([
			["a1", new Map([["a", state({ memberId: "a", grade: { score: 90 } })]])],
			["a2", new Map([["b", state({ memberId: "b", grade: { score: 45 } })]])],
		]);
		const csv = gradebookCsv(defs, members, map);
		const lines = csv.split("\n");
		expect(lines[0]).toBe('member,과제1,"에세이, 1편"');
		expect(lines[1]).toBe("철수,90,"); // a1=90, a2 빈칸
		expect(lines[2]).toBe("영희,,45"); // a1 빈칸, a2=45
	});
});
