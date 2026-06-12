import { computeStats, MemberStats, Rate, StatsInput } from "./stats";
import { weekStart } from "./week";

const DAY_MS = 86_400_000;

/** 시계열 버킷(시작·끝 모두 포함). */
export interface SeriesBucket {
	startMs: number;
	endMs: number;
	/** 짧은 라벨 — 일 단위 "6/1", 주 단위 "6/1~"(주 시작일). */
	label: string;
}

function startOfDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function shortDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 기간을 시계열 버킷으로 분할(순수). 일수가 maxBuckets 이하면 일 단위, 초과면 주 단위(weekStart 경계).
 * 아직 오지 않은 날(nowMs 이후)은 버킷을 만들지 않는다.
 */
export function splitBuckets(startMs: number, endMs: number, nowMs: number, maxBuckets = 14): SeriesBucket[] {
	const cap = Math.min(endMs, startOfDay(nowMs) + DAY_MS - 1);
	const first = startOfDay(startMs);
	if (first > cap) return [];
	const dayCount = Math.floor((startOfDay(cap) - first) / DAY_MS) + 1;
	const buckets: SeriesBucket[] = [];
	if (dayCount <= maxBuckets) {
		for (let ts = first; ts <= cap; ts += DAY_MS) {
			buckets.push({ startMs: ts, endMs: Math.min(ts + DAY_MS - 1, cap), label: shortDate(ts) });
		}
		return buckets;
	}
	// 주 단위(월요일 경계). 첫 버킷은 기간 시작, 마지막 버킷은 cap에서 잘린다.
	let ts = first;
	while (ts <= cap) {
		const wk = weekStart(ts);
		const [y, m, d] = wk.split("-").map(Number);
		const wkStartMs = new Date(y, m - 1, d).getTime();
		const wkEndMs = wkStartMs + 7 * DAY_MS - 1;
		buckets.push({ startMs: ts, endMs: Math.min(wkEndMs, cap), label: `${shortDate(ts)}~` });
		ts = wkEndMs + 1;
	}
	return buckets;
}

/** 버킷별 구성원 통계 — 데이터 재조회 없이 computeStats를 버킷 기간으로 반복 호출(지표별 풀링은 poolPct로). */
export function computeBucketStats(input: StatsInput, buckets: SeriesBucket[]): MemberStats[][] {
	return buckets.map((b) => computeStats({ ...input, startMs: b.startMs, endMs: b.endMs }));
}

/** 전 구성원 풀링 %(Σ분자/Σ분모×100). 분모 0이면 null. */
export function poolPct(stats: MemberStats[], pick: (s: MemberStats) => Rate): number | null {
	let num = 0;
	let den = 0;
	for (const s of stats) {
		const r = pick(s);
		num += r.num;
		den += r.den;
	}
	return den > 0 ? Math.round((num / den) * 100) : null;
}

/** 버킷별 풀링 % 시계열. 분모 0인 버킷은 null. */
export function computeSeries(input: StatsInput, buckets: SeriesBucket[], pick: (s: MemberStats) => Rate): Array<number | null> {
	return computeBucketStats(input, buckets).map((stats) => poolPct(stats, pick));
}
