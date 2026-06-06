function pad(n: number): string {
	return String(n).padStart(2, "0");
}

const DAY_MS = 86_400_000;

/** 로컬 기준 YYYY-MM-DD. */
function ymd(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 해당 시각이 속한 주의 월요일(주 시작) 날짜키(YYYY-MM-DD, 로컬). */
export function weekStart(ts: number): string {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	const dow = d.getDay(); // 0=일..6=토
	const diff = (dow + 6) % 7; // 월요일까지 거슬러 올라갈 일수
	d.setDate(d.getDate() - diff);
	return ymd(d);
}

/** 주 시작 키에 n주를 더한 키(음수면 이전 주). */
export function addWeeks(weekKey: string, n: number): string {
	const [y, m, d] = weekKey.split("-").map(Number);
	const base = new Date(y, m - 1, d);
	return weekStart(base.getTime() + n * 7 * DAY_MS);
}

/** 주 시작 키의 주 범위 라벨(예: "6/8 – 6/14"). */
export function weekRangeLabel(weekKey: string): string {
	const [y, m, d] = weekKey.split("-").map(Number);
	const start = new Date(y, m - 1, d);
	const end = new Date(start.getTime() + 6 * DAY_MS);
	return `${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`;
}

/** ts가 weekKey 주(월~일)에 속하는지. */
export function weekContains(weekKey: string, ts: number): boolean {
	return weekStart(ts) === weekKey;
}
