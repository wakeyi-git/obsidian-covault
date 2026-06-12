import { NoticeDoc, ResponseDoc, AssignmentStateDoc, RoutineDoc, RoutineStateDoc } from "../model/types";
import { itemsOn, dayStr, computeStreak } from "./routines";

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
	/** 제출율 — 마감 책임 기준: 분모 = 마감이 지났거나 이미 제출한 과제. 마감 전 미제출은 제외. */
	submit: Rate;
	/** 진행률 — 배정 기준: 분모 = 기간 내 배정된 모든 과제. */
	progress: Rate;
	/** 정시 제출율 — 마감 있는 제출 중 마감 전 제출 비율. */
	onTime: Rate;
	/** 채점 진행률 — 제출되었거나 반환된 과제 중 반환 완료 비율(교사 표시용). */
	graded: Rate;
	routine: Rate;
	/** 과제 평균 점수(%) — 채점된 과제의 만점 가중 평균(Σ득점/Σ만점). 채점 없으면 null. */
	avgScorePct: number | null;
	/** 채점된 과제 득점 합·만점 합(학급 단위 풀링 평균용). */
	scoreSum: number;
	maxSum: number;
	/** 루틴 연속 달성 — 루틴별 streak의 최댓값. 기간과 무관한 "현재" 지표. */
	bestStreak: number;
	/** 기간 내 댓글·질문 건수. responses 미제공 시 null(측정 안 함). */
	participation: number | null;
}

export interface StatsInput {
	startMs: number; // 기간 시작(그날 00:00 포함)
	endMs: number; // 기간 끝(그날 23:59:59 포함)
	/** "현재" 기준 시각 — 미래 날짜 분모 제외·마감 경과 판정에 사용(순수성 유지를 위해 주입). */
	nowMs: number;
	members: Array<{ memberId: string; memberName: string }>;
	notices: NoticeDoc[]; // category notice+lesson
	reads: ResponseDoc[]; // kind === "read"
	states: AssignmentStateDoc[]; // 대상 구성원들의 과제 상태
	/** 과제 uid → 만점(points 또는 rubric 합). state.maxPoints 없을 때 폴백. */
	maxByUid: Map<string, number | undefined>;
	routines: RoutineDoc[];
	routineStates: RoutineStateDoc[];
	/** 참여도(댓글·질문)용 응답. 미제공 시 participation = null. */
	responses?: ResponseDoc[];
}

const DAY_MS = 86_400_000;

function inPeriod(ts: number | undefined, start: number, end: number): boolean {
	return ts != null && ts >= start && ts <= end;
}

function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** 채점값이 실제로 입력되었는지 — 코멘트만 있는 반환은 점수 풀링에서 제외. */
function hasScore(grade: AssignmentStateDoc["grade"]): grade is NonNullable<AssignmentStateDoc["grade"]> {
	return grade != null && (grade.score != null || (grade.rubricScores != null && Object.keys(grade.rubricScores).length > 0));
}

function gradeNum(grade: NonNullable<AssignmentStateDoc["grade"]>): number {
	if (grade.score != null) return grade.score;
	if (grade.rubricScores) return Object.values(grade.rubricScores).reduce((a, b) => a + b, 0);
	return 0;
}

/** 기간별 구성원 종합 통계(순수). 확인율·제출율/진행률·정시율·채점률·평균 점수·체크리스트·streak·참여도. */
export function computeStats(input: StatsInput): MemberStats[] {
	const { startMs, endMs, nowMs, members, notices, reads, states, maxByUid, routines, routineStates, responses } = input;

	const noticesIn = notices.filter((n) => !n.deleted && inPeriod(n.postedAtMs, startMs, endMs));
	const noticeList = noticesIn.filter((n) => (n.category ?? "notice") === "notice");
	const lessonList = noticesIn.filter((n) => n.category === "lesson");

	// targetId → 읽은 사용자 집합
	const readBy = new Map<string, Set<string>>();
	for (const r of reads) {
		if (r.deleted || r.kind !== "read") continue;
		(readBy.get(r.targetId) ?? readBy.set(r.targetId, new Set()).get(r.targetId)!).add(r.byUser);
	}

	// routineState 인덱스: `${uid}:${memberId}` → day → state (체크 집합·streak 공용)
	const rsIndex = new Map<string, Map<string, RoutineStateDoc>>();
	for (const s of routineStates) {
		const key = `${s.routineUid}:${s.memberId}`;
		(rsIndex.get(key) ?? rsIndex.set(key, new Map()).get(key)!).set(s.day, s);
	}

	// 기간 내 날짜 목록(루틴 계산용) — 아직 오지 않은 날은 분모에 넣지 않는다.
	const days: number[] = [];
	const lastDayEnd = Math.min(endMs, startOfDay(nowMs) + DAY_MS - 1);
	for (let ts = startOfDay(startMs); ts <= lastDayEnd; ts += DAY_MS) days.push(ts);
	const liveRoutines = routines.filter((r) => !r.deleted);
	// 루틴 생성일 이전 날짜는 분모 제외(소급 패널티 방지)
	const createdDayByUid = new Map(liveRoutines.map((r) => [r.uid, startOfDay(r.createdAtMs)]));

	return members.map((m) => {
		// 알림장/수업 확인율 (ResponseDoc.targetId === NoticeDoc._id)
		const countRead = (list: NoticeDoc[]): Rate => ({
			num: list.filter((n) => readBy.get(n._id)?.has(m.memberId)).length,
			den: list.length,
		});
		const noticeRead = countRead(noticeList);
		const lessonRead = countRead(lessonList);

		// 과제 — 기간 내 배정분
		const myStates = states.filter((s) => s.memberId === m.memberId && !s.deleted && inPeriod(s.assignedAtMs, startMs, endMs));
		// 실제 제출(submittedAtMs)만 제출로 집계 — 교사가 미제출 과제를 바로 반환해도 제출로 잡히지 않게.
		const submitted = myStates.filter((s) => s.submittedAtMs != null);
		// 진행률: 배정된 전체 대비 제출
		const progress: Rate = { num: submitted.length, den: myStates.length };
		// 제출율: 마감 책임 기준 — 마감이 지났거나 이미 제출한 과제만 분모. 마감 없는 미제출은 책임 불성립으로 제외(진행률이 담당).
		const submit: Rate = {
			num: submitted.length,
			den: myStates.filter((s) => (s.dueAt != null && s.dueAt <= nowMs) || s.submittedAtMs != null).length,
		};
		// 정시 제출율: 마감 있는 제출 중 마감 내 제출
		const withDue = submitted.filter((s) => s.dueAt != null);
		const onTime: Rate = { num: withDue.filter((s) => s.submittedAtMs! <= s.dueAt!).length, den: withDue.length };
		// 채점 진행률: 제출되었거나 반환된 과제 중 반환 완료
		const graded: Rate = {
			num: myStates.filter((s) => s.state === "returned").length,
			den: myStates.filter((s) => s.submittedAtMs != null || s.state === "returned").length,
		};

		// 평균 점수: 만점 가중 풀링(Σ득점/Σ만점). 만점이 다른 과제를 균등 평균하지 않는다.
		let scoreSum = 0;
		let maxSum = 0;
		for (const s of myStates) {
			// 점수가 실제 입력된 반환만 — 코멘트만 있는 반환을 0점으로 풀링하지 않게.
			if (s.state === "returned" && hasScore(s.grade)) {
				// 배포 시점 스냅샷(state.maxPoints) 우선 — 교사/학생 만점 경로 일치. 정의는 폴백.
				const max = s.maxPoints ?? maxByUid.get(s.assignmentUid);
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
		for (const r of liveRoutines) {
			const createdDay = createdDayByUid.get(r.uid)!;
			const byDay = rsIndex.get(`${r.uid}:${m.memberId}`);
			for (const ts of days) {
				if (ts < createdDay) continue;
				const items = itemsOn(r, ts);
				if (items.length === 0) continue;
				rDen += items.length;
				const checked = byDay?.get(dayStr(ts));
				if (checked) {
					const ids = new Set(checked.checked);
					rNum += items.filter((it) => ids.has(it.id)).length;
				}
			}
		}

		// 연속 달성: 루틴별 streak 최댓값(오늘 기준, 기간 무관)
		let bestStreak = 0;
		for (const r of liveRoutines) {
			const byDay = rsIndex.get(`${r.uid}:${m.memberId}`) ?? new Map<string, RoutineStateDoc>();
			bestStreak = Math.max(bestStreak, computeStreak(r, byDay, startOfDay(nowMs)));
		}

		// 참여도: 기간 내 본인이 쓴 댓글·질문 건수
		const participation = responses
			? responses.filter(
					(r) => !r.deleted && (r.kind === "comment" || r.kind === "question") && r.byUser === m.memberId && inPeriod(r.createdAtMs, startMs, endMs),
				).length
			: null;

		return {
			memberId: m.memberId,
			memberName: m.memberName,
			noticeRead,
			lessonRead,
			submit,
			progress,
			onTime,
			graded,
			routine: { num: rNum, den: rDen },
			avgScorePct,
			scoreSum,
			maxSum,
			bestStreak,
			participation,
		};
	});
}
