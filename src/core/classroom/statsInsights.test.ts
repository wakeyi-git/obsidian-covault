import { describe, it, expect } from "vitest";
import { computeAlerts } from "./statsInsights";
import { AssignmentStateDoc } from "../model/types";

const HOUR = 3600_000;
const now = new Date("2026-06-10T12:00").getTime();
const members = [{ memberId: "a", memberName: "A" }, { memberId: "b", memberName: "B" }];

function st(uid: string, memberId: string, extra?: Partial<AssignmentStateDoc>): AssignmentStateDoc {
	return { _id: `assignment-state:${uid}:${memberId}`, type: "assignment-state", schemaVersion: 1, workspaceId: "ws", assignmentUid: uid, memberId, title: uid, state: "assigned", assignedAtMs: now - 72 * HOUR, ...extra } as AssignmentStateDoc;
}

describe("computeAlerts", () => {
	it("마감 경과/임박 분류 — 경계 포함(정확히 now는 경과, now+48h는 임박)", () => {
		const r = computeAlerts(
			[
				st("o1", "a", { dueAt: now }), // 경과(경계)
				st("o2", "a", { dueAt: now - HOUR }), // 경과
				st("s1", "b", { dueAt: now + 48 * HOUR }), // 임박(경계)
				st("f1", "b", { dueAt: now + 49 * HOUR }), // 둘 다 아님
			],
			members,
			now,
		);
		expect(r.overdue.map((a) => a.assignmentUid)).toEqual(["o2", "o1"]); // dueAt 오름차순
		expect(r.dueSoon.map((a) => a.assignmentUid)).toEqual(["s1"]);
	});

	it("제출됨·보관됨·삭제됨·마감 없음·명단 밖은 제외", () => {
		const r = computeAlerts(
			[
				st("x1", "a", { dueAt: now - HOUR, submittedAtMs: now - 2 * HOUR }),
				st("x2", "a", { dueAt: now - HOUR, archivedAtMs: now }),
				st("x3", "a", { dueAt: now - HOUR, deleted: true }),
				st("x4", "a", {}),
				st("x5", "ghost", { dueAt: now - HOUR }),
			],
			members,
			now,
		);
		expect(r.overdue).toEqual([]);
		expect(r.dueSoon).toEqual([]);
	});

	it("구성원 이름이 알림에 들어간다", () => {
		const r = computeAlerts([st("o1", "b", { dueAt: now - HOUR })], members, now);
		expect(r.overdue[0]).toMatchObject({ memberName: "B", title: "o1" });
	});
});
