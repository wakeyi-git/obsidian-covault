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
