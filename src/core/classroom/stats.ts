import { NoticeDoc, ResponseDoc, AssignmentStateDoc, RoutineDoc, RoutineStateDoc } from "../model/types";
import { itemsOn, dayStr } from "./routines";

/** 비율(분자/분모). 분모 0이면 측정 불가(null 취급). */
export interface Rate {
	num: number;
	den: number;
}
export function ratePct(r: Rate | null | undefined): number | null {
	return r && r.den > 0 ? Math.round((r.num / r.den) * 100) : null;
}

export interface MemberStats {
	memberId: string;
	memberName: string;
	noticeRead: Rate;
	lessonRead: Rate;
	submit: Rate;
	routine: Rate;
	/** 과제 평균 점수(%) — 채점된 과제의 만점 가중 평균(Σ득점/Σ만점). 채점 없으면 null. */
	avgScorePct: number | null;
	/** 채점된 과제 득점 합·만점 합(학급 단위 풀링 평균용). */
	scoreSum: number;
	maxSum: number;
}

export interface StatsInput {
	startMs: number; // 기간 시작(그날 00:00 포함)
	endMs: number; // 기간 끝(그날 23:59:59 포함)
	members: Array<{ memberId: string; memberName: string }>;
	notices: NoticeDoc[]; // category notice+lesson
	reads: ResponseDoc[]; // kind === "read"
	states: AssignmentStateDoc[]; // 대상 구성원들의 과제 상태
	/** 과제 uid → 만점(points 또는 rubric 합). 점수 정규화에 사용. */
	maxByUid: Map<string, number | undefined>;
	routines: RoutineDoc[];
	routineStates: RoutineStateDoc[];
}

const DAY_MS = 86_400_000;

function inPeriod(ts: number | undefined, start: number, end: number): boolean {
	return ts != null && ts >= start && ts <= end;
}

function gradeNum(grade: NonNullable<AssignmentStateDoc["grade"]>): number {
	if (grade.score != null) return grade.score;
	if (grade.rubricScores) return Object.values(grade.rubricScores).reduce((a, b) => a + b, 0);
	return 0;
}

/** 기간별 구성원 종합 통계(순수). 알림장/수업 확인율·과제 제출율·평균 점수·체크리스트 완료율. */
export function computeStats(input: StatsInput): MemberStats[] {
	const { startMs, endMs, members, notices, reads, states, maxByUid, routines, routineStates } = input;

	const noticesIn = notices.filter((n) => !n.deleted && inPeriod(n.postedAtMs, startMs, endMs));
	const noticeList = noticesIn.filter((n) => (n.category ?? "notice") === "notice");
	const lessonList = noticesIn.filter((n) => n.category === "lesson");

	// targetId → 읽은 사용자 집합
	const readBy = new Map<string, Set<string>>();
	for (const r of reads) {
		if (r.deleted || r.kind !== "read") continue;
		(readBy.get(r.targetId) ?? readBy.set(r.targetId, new Set()).get(r.targetId)!).add(r.byUser);
	}

	// routineState index: `${uid}:${memberId}:${day}` → checked set
	const rsIndex = new Map<string, Set<string>>();
	for (const s of routineStates) rsIndex.set(`${s.routineUid}:${s.memberId}:${s.day}`, new Set(s.checked));

	// 기간 내 날짜 목록(루틴 계산용)
	const days: number[] = [];
	const startDay = new Date(startMs);
	startDay.setHours(0, 0, 0, 0);
	for (let ts = startDay.getTime(); ts <= endMs; ts += DAY_MS) days.push(ts);

	return members.map((m) => {
		// 알림장/수업 확인율 (ResponseDoc.targetId === NoticeDoc._id)
		const countRead = (list: NoticeDoc[]): Rate => ({
			num: list.filter((n) => readBy.get(n._id)?.has(m.memberId)).length,
			den: list.length,
		});
		const noticeRead = countRead(noticeList);
		const lessonRead = countRead(lessonList);

		// 과제 제출율 + 평균 점수
		const myStates = states.filter((s) => s.memberId === m.memberId && !s.deleted && inPeriod(s.assignedAtMs, startMs, endMs));
		// 실제 제출(submittedAtMs)만 제출로 집계 — 교사가 미제출 과제를 바로 반환해도 제출로 잡히지 않게.
		const submit: Rate = {
			num: myStates.filter((s) => s.submittedAtMs != null).length,
			den: myStates.length,
		};
		// 평균 점수: 만점 가중 풀링(Σ득점/Σ만점). 만점이 다른 과제를 균등 평균하지 않는다.
		let scoreSum = 0;
		let maxSum = 0;
		for (const s of myStates) {
			if (s.state === "returned" && s.grade) {
				const max = maxByUid.get(s.assignmentUid);
				if (max != null && max > 0) {
					scoreSum += gradeNum(s.grade);
					maxSum += max;
				}
			}
		}
		const avgScorePct = maxSum > 0 ? Math.round((scoreSum / maxSum) * 100) : null;

		// 체크리스트 완료율(기간 내 적용 항목 합산)
		let rNum = 0;
		let rDen = 0;
		for (const ts of days) {
			const key = dayStr(ts);
			for (const r of routines) {
				if (r.deleted) continue;
				const items = itemsOn(r, ts);
				if (items.length === 0) continue;
				rDen += items.length;
				const checked = rsIndex.get(`${r.uid}:${m.memberId}:${key}`);
				if (checked) rNum += items.filter((it) => checked.has(it.id)).length;
			}
		}

		return { memberId: m.memberId, memberName: m.memberName, noticeRead, lessonRead, submit, routine: { num: rNum, den: rDen }, avgScorePct, scoreSum, maxSum };
	});
}
