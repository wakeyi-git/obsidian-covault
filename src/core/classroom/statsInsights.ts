import { AssignmentStateDoc } from "../model/types";

/** 마감 관련 주의 항목(구성원×과제). */
export interface AssignmentAlert {
	memberId: string;
	memberName: string;
	assignmentUid: string;
	title: string;
	dueAt: number;
}

export interface StatsAlerts {
	/** 마감 경과 미제출. */
	overdue: AssignmentAlert[];
	/** 마감 임박(now < dueAt ≤ now+soonMs) 미제출. */
	dueSoon: AssignmentAlert[];
}

const SOON_MS = 48 * 3600_000;

/** 기간과 무관한 "현재" 기준 마감 알림(순수). 미제출·마감 있는 과제만, dueAt 오름차순. */
export function computeAlerts(
	states: AssignmentStateDoc[],
	members: Array<{ memberId: string; memberName: string }>,
	nowMs: number,
	soonMs = SOON_MS,
): StatsAlerts {
	const nameById = new Map(members.map((m) => [m.memberId, m.memberName]));
	const overdue: AssignmentAlert[] = [];
	const dueSoon: AssignmentAlert[] = [];
	for (const s of states) {
		if (s.deleted || s.archivedAtMs != null || s.submittedAtMs != null || s.dueAt == null) continue;
		const memberName = nameById.get(s.memberId);
		if (memberName == null) continue; // 명단 밖(탈퇴 등) 제외
		const alert: AssignmentAlert = { memberId: s.memberId, memberName, assignmentUid: s.assignmentUid, title: s.title, dueAt: s.dueAt };
		if (s.dueAt <= nowMs) overdue.push(alert);
		else if (s.dueAt <= nowMs + soonMs) dueSoon.push(alert);
	}
	overdue.sort((a, b) => a.dueAt - b.dueAt);
	dueSoon.sort((a, b) => a.dueAt - b.dueAt);
	return { overdue, dueSoon };
}
