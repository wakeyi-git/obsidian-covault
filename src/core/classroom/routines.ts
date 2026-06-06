import { RoutineDoc, RoutineStateDoc } from "../model/types";

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** 로컬 기준 YYYY-MM-DD. */
export function dayStr(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 해당 날짜에 이 루틴이 적용되는지(daily=항상, weekly=요일 포함). */
export function routineAppliesOn(routine: Pick<RoutineDoc, "recurrence" | "weekdays">, ts: number): boolean {
	if (routine.recurrence === "daily") return true;
	return (routine.weekdays ?? []).includes(new Date(ts).getDay());
}

export interface RoutineCompletion {
	done: number;
	total: number;
}

/** 완료 개수/전체(삭제된 item id는 무시). */
export function completion(routine: Pick<RoutineDoc, "items">, state: RoutineStateDoc | null | undefined): RoutineCompletion {
	const total = routine.items.length;
	if (!state) return { done: 0, total };
	const ids = new Set(routine.items.map((i) => i.id));
	const done = state.checked.filter((c) => ids.has(c)).length;
	return { done, total };
}

export function completionPct(c: RoutineCompletion): number {
	return c.total === 0 ? 0 : Math.round((c.done / c.total) * 100);
}
