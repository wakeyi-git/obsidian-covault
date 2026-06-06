import { RoutineDoc, RoutineItem, RoutineStateDoc } from "../model/types";

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** 로컬 기준 YYYY-MM-DD. */
export function dayStr(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 한 항목이 해당 날짜에 적용되는지(daily=항상, weekly=요일 포함). */
export function itemAppliesOn(item: Pick<RoutineItem, "recurrence" | "weekdays">, ts: number): boolean {
	if (item.recurrence === "daily") return true;
	return (item.weekdays ?? []).includes(new Date(ts).getDay());
}

/** 해당 날짜에 적용되는 항목들. */
export function itemsOn(routine: Pick<RoutineDoc, "items">, ts: number): RoutineItem[] {
	return routine.items.filter((i) => itemAppliesOn(i, ts));
}

/** 그날 적용 항목이 하나라도 있으면 루틴이 그날 표시된다(학생 목록 필터용). */
export function routineAppliesOn(routine: Pick<RoutineDoc, "items">, ts: number): boolean {
	return itemsOn(routine, ts).length > 0;
}

export interface RoutineCompletion {
	done: number;
	total: number;
}

/** 해당 날짜의 완료 개수/적용 항목 수(없는 id 무시). */
export function completion(routine: Pick<RoutineDoc, "items">, state: RoutineStateDoc | null | undefined, ts: number): RoutineCompletion {
	const items = itemsOn(routine, ts);
	const total = items.length;
	if (!state) return { done: 0, total };
	const ids = new Set(items.map((i) => i.id));
	const done = state.checked.filter((c) => ids.has(c)).length;
	return { done, total };
}

export function completionPct(c: RoutineCompletion): number {
	return c.total === 0 ? 0 : Math.round((c.done / c.total) * 100);
}

const DAY_MS = 86_400_000;

/**
 * 연속 완료(streak) 계산(순수). today부터 거꾸로, 그날 적용 항목이 있는 날만 보며 "적용 항목 전부 완료"면 +1,
 * 아니면 중단. 적용 항목이 없는 날은 건너뛴다(연속 끊김 아님). 오늘이 아직 미완료면 어제까지로 인정한다.
 */
export function computeStreak(
	routine: Pick<RoutineDoc, "items">,
	statesByDay: Map<string, RoutineStateDoc>,
	today: number,
	maxLookback = 90,
): number {
	let streak = 0;
	for (let i = 0; i < maxLookback; i++) {
		const ts = today - i * DAY_MS;
		const items = itemsOn(routine, ts);
		if (items.length === 0) continue; // 적용 항목 없는 날 → 건너뜀
		const comp = completion(routine, statesByDay.get(dayStr(ts)), ts);
		const full = comp.total > 0 && comp.done === comp.total;
		if (full) streak++;
		else if (i === 0) continue; // 오늘 아직 미완료 → 끊지 말고 어제부터
		else break;
	}
	return streak;
}
