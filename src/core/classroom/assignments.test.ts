import { describe, it, expect } from "vitest";
import {
	assignmentWorkDir,
	substituteTemplate,
	displayStatus,
	buildMatrix,
	statusCounts,
} from "./assignments";
import { AssignmentStateDoc, AssignmentDoc } from "../model/types";

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
