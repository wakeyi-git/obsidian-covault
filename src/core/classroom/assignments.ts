import { AssignmentDoc, AssignmentStateDoc, AssignmentGrade, RubricCriterion } from "../model/types";
import { slugify } from "./notices";

export { slugify };

/** 한 기준의 최대 배점(레벨 점수 합 — 단일 레벨이면 그 값). */
export function criterionMax(c: RubricCriterion): number {
	return c.levels.reduce((a, l) => a + (l.points || 0), 0);
}

/** 루브릭 총 만점. */
export function rubricMax(rubric: RubricCriterion[] | undefined): number {
	return (rubric ?? []).reduce((a, c) => a + criterionMax(c), 0);
}

/** 채점 총점: 루브릭이 있으면 기준별 점수 합, 없으면 grade.score. */
export function gradeTotal(grade: AssignmentGrade | undefined, rubric: RubricCriterion[] | undefined): number {
	if (!grade) return 0;
	if (rubric && rubric.length > 0) {
		return rubric.reduce((a, c) => a + (grade.rubricScores?.[c.id] ?? 0), 0);
	}
	return grade.score ?? 0;
}

/**
 * 과제 작업 폴더. 공유=<학급>/<label>, 개인=<root>/_<label>(root="" 학생 측이면 _<label>).
 * label은 현지화된 폴더명(ko "과제" / en "Assignments") — 호출측이 t("dashboard.subfolder_assignment")로 넘긴다
 * (평가 P1-1 — 한국어 폴더 하드코딩 제거). 개인 폴더는 `_` 접두사(숨김/사적 관례)를 붙인다.
 * 과제 파일은 이 폴더 바로 아래 `<slug>.<ext>`로 생성한다(과제별 하위 폴더를 만들지 않음).
 * 개인 과제의 파일은 dbPath(localRoot 상대)로 저장하므로 학생 측은 root="", 교사 측은 member.localRoot로 해석한다.
 * 기존 과제는 상태 문서(AssignmentStateDoc.workPaths)에 경로가 저장·보존되므로 label 변경에 영향받지 않는다.
 */
export function assignmentWorkDir(privacy: "mirror" | "shared", root: string, homeroomFolder: string, label: string): string {
	if (privacy === "shared") return `${homeroomFolder}/${label}`;
	return root ? `${root}/_${label}` : `_${label}`;
}

/** 과제 파일명: <slug><ext>. ext는 템플릿 파일명의 첫 점 이후(.md, .excalidraw.md 등)를 유지. */
export function assignmentFileName(slug: string, templateName: string): string {
	const dot = templateName.indexOf(".");
	const ext = dot >= 0 ? templateName.slice(dot) : ".md";
	return `${slug}${ext}`;
}

/** 템플릿 치환({{memberName}}/{{memberId}}/{{workspaceId}}/{{date}}). BulkCopy와 동일 규칙. */
export function substituteTemplate(
	content: string,
	vars: { memberId: string; memberName: string; workspaceId: string; date: string },
): string {
	return content
		.replace(/\{\{\s*memberName\s*\}\}/g, vars.memberName)
		.replace(/\{\{\s*memberId\s*\}\}/g, vars.memberId)
		.replace(/\{\{\s*workspaceId\s*\}\}/g, vars.workspaceId)
		.replace(/\{\{\s*date\s*\}\}/g, vars.date);
}

export type AssignmentDisplayStatus =
	| "assigned"
	| "overdue"
	| "submitted"
	| "submitted-late"
	| "returned";

/** 상태 문서 + 마감으로 표시 상태를 계산(순수). */
export function displayStatus(state: AssignmentStateDoc, now: number): AssignmentDisplayStatus {
	if (state.state === "returned") return "returned";
	if (state.state === "submitted") {
		return state.dueAt && state.submittedAtMs && state.submittedAtMs > state.dueAt ? "submitted-late" : "submitted";
	}
	return state.dueAt && now > state.dueAt ? "overdue" : "assigned";
}

export type AssignmentTab = "active" | "done";

/** 교사 뷰 탭 분류(순수): 보관됨 → done. */
export function defTab(def: Pick<AssignmentDoc, "archivedAtMs">): AssignmentTab {
	return def.archivedAtMs != null ? "done" : "active";
}

/** 학생 뷰 탭 분류(순수): 보관됨 또는 반환됨 → done, 나머지(미제출·채점 대기 포함) → active. */
export function stateTab(state: Pick<AssignmentStateDoc, "archivedAtMs" | "state">): AssignmentTab {
	return state.archivedAtMs != null || state.state === "returned" ? "done" : "active";
}

export interface MatrixRow {
	memberId: string;
	memberName: string;
	state?: AssignmentStateDoc;
	status: AssignmentDisplayStatus;
}

/**
 * 교사 제출 현황 매트릭스(순수). 정의의 대상 멤버 × 수집된 상태 문서를 병합한다.
 * 상태 문서가 아직 없으면(배포 직후 미동기화) "assigned"로 본다.
 */
export function buildMatrix(
	def: Pick<AssignmentDoc, "uid" | "targetMembers" | "dueAt">,
	members: Array<{ memberId: string; memberName: string }>,
	states: AssignmentStateDoc[],
	now: number,
): MatrixRow[] {
	const byMember = new Map(states.filter((s) => !s.deleted).map((s) => [s.memberId, s]));
	return def.targetMembers
		.map((id) => members.find((m) => m.memberId === id) ?? { memberId: id, memberName: id })
		.map((m) => {
			const state = byMember.get(m.memberId);
			const status: AssignmentDisplayStatus = state
				? displayStatus(state, now)
				: def.dueAt && now > def.dueAt
					? "overdue"
					: "assigned";
			return { memberId: m.memberId, memberName: m.memberName, state, status };
		});
}

/** 상태별 카운트 요약(교사 카드 헤더용). */
export function statusCounts(rows: MatrixRow[]): Record<AssignmentDisplayStatus, number> {
	const c: Record<AssignmentDisplayStatus, number> = {
		assigned: 0,
		overdue: 0,
		submitted: 0,
		"submitted-late": 0,
		returned: 0,
	};
	for (const r of rows) c[r.status]++;
	return c;
}
