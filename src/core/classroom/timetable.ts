/** 시간표 기본값 + 프론트매터 day/period → 칸(cellKey) 해석(순수 함수, 테스트 가능). */
import { t } from "../../i18n";

/** 신규 시간표 기본 교시. */
export const DEFAULT_PERIODS = ["1", "2", "3", "4", "5", "6"];

/** 신규 시간표 기본 요일(로케일). 생성 시점에 t()로 평가 → en/ko 모두 자연스러운 라벨. */
export function defaultTimetableDays(): string[] {
	return [t("dashboard.wd_mon"), t("dashboard.wd_tue"), t("dashboard.wd_wed"), t("dashboard.wd_thu"), t("dashboard.wd_fri")];
}

/** 라벨 배열에서 값을 인덱스로 해석: 라벨 일치 우선, 없으면 1-기반 정수(1..N)로. 못 맞추면 null. */
function resolveIndex(raw: unknown, labels: string[]): number | null {
	if (raw == null || raw === "") return null;
	const s = String(raw).trim();
	if (!s) return null;
	const byLabel = labels.indexOf(s);
	if (byLabel >= 0) return byLabel;
	const n = Number(s);
	if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
	return null;
}

/**
 * 프론트매터 day/period를 시간표 칸 키("<dayIdx>:<periodIdx>")로 해석한다.
 * day/period는 라벨(월/화…, "2") 또는 1-기반 정수(월=1, 2교시=2)로 줄 수 있다. 못 맞추면 null(미배치 유지).
 */
export function resolveTimetableSlot(dayRaw: unknown, periodRaw: unknown, days: string[], periods: string[]): string | null {
	const dayIdx = resolveIndex(dayRaw, days);
	const perIdx = resolveIndex(periodRaw, periods);
	if (dayIdx == null || perIdx == null) return null;
	return `${dayIdx}:${perIdx}`;
}

/**
 * 수업(uid)을 시간표 lessons 맵의 cellKey에 연결한다(순수). 같은 uid가 다른 칸에 있으면 옮긴다(이전 칸 제거).
 * 변경이 없으면 changed=false. 호출자는 changed일 때만 저장한다.
 */
export function placeLessonSlot(lessons: Record<string, string>, uid: string, cellKey: string): { lessons: Record<string, string>; changed: boolean } {
	const next = { ...lessons };
	let changed = false;
	for (const [k, v] of Object.entries(next)) {
		if (v === uid && k !== cellKey) {
			delete next[k];
			changed = true;
		}
	}
	if (next[cellKey] !== uid) {
		next[cellKey] = uid;
		changed = true;
	}
	return { lessons: next, changed };
}

/**
 * 수업(uid)의 연결을 시간표 lessons 맵에서 제거한다(순수). 프론트매터에서 day/period를 비우거나
 * week를 다른 주로 옮겼을 때, 더 이상 가리키지 않는 칸을 비우는 데 쓴다. 변경이 없으면 changed=false.
 */
export function removeLessonSlot(lessons: Record<string, string>, uid: string): { lessons: Record<string, string>; changed: boolean } {
	const next = { ...lessons };
	let changed = false;
	for (const [k, v] of Object.entries(next)) {
		if (v === uid) {
			delete next[k];
			changed = true;
		}
	}
	return { lessons: next, changed };
}
