/** 달력 한 칸. ts=그 날 00:00 로컬, inMonth=해당 월 소속 여부(앞뒤 달 스필오버 구분). */
export interface CalCell {
	ts: number;
	inMonth: boolean;
}

/**
 * 월간 달력 행렬(일요일 시작). 첫 주의 앞쪽·마지막 주의 뒤쪽은 인접 달 날짜로 채우고 inMonth=false.
 * month0 은 0=1월.
 */
export function monthMatrix(year: number, month0: number): CalCell[][] {
	const startOffset = new Date(year, month0, 1).getDay(); // 일=0
	const lastDate = new Date(year, month0 + 1, 0).getDate();
	const numWeeks = Math.ceil((startOffset + lastDate) / 7);
	const weeks: CalCell[][] = [];
	for (let w = 0; w < numWeeks; w++) {
		const row: CalCell[] = [];
		for (let d = 0; d < 7; d++) {
			const dt = new Date(year, month0, 1 - startOffset + w * 7 + d);
			row.push({ ts: dt.getTime(), inMonth: dt.getMonth() === month0 });
		}
		weeks.push(row);
	}
	return weeks;
}

/** "YYYY-M" 형태 라벨용 분해 — UI에서 직접 포맷. */
export function shiftMonth(year: number, month0: number, delta: number): { year: number; month0: number } {
	const m = month0 + delta;
	return { year: year + Math.floor(m / 12), month0: ((m % 12) + 12) % 12 };
}
