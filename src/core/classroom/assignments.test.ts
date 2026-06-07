import { describe, it, expect } from "vitest";
import {
	assignmentWorkDir,
	assignmentFileName,
	substituteTemplate,
	displayStatus,
	buildMatrix,
	statusCounts,
	criterionMax,
	rubricMax,
	gradeTotal,
} from "./assignments";
import { AssignmentStateDoc, AssignmentDoc, RubricCriterion } from "../model/types";

describe("assignmentWorkDir / assignmentFileName / substituteTemplate", () => {
	it("폴더: 개인=교사측 <root>/_과제, 학생측(root='')은 _과제, 공유=학급/과제 (과제별 하위폴더 없음)", () => {
		expect(assignmentWorkDir("mirror", "학생A", "_학급")).toBe("학생A/_과제");
		expect(assignmentWorkDir("mirror", "", "_학급")).toBe("_과제");
		expect(assignmentWorkDir("shared", "학생A", "_학급")).toBe("_학급/과제");
	});
	it("파일명: <slug>+템플릿 확장자(.md, .excalidraw.md 유지)", () => {
		expect(assignmentFileName("독서감상문", "과제.md")).toBe("독서감상문.md");
		expect(assignmentFileName("그리기", "template.excalidraw.md")).toBe("그리기.excalidraw.md");
		expect(assignmentFileName("s1", "확장자없음")).toBe("s1.md");
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
