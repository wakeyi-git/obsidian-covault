/**
 * 중복 누적(노트 전체 내용이 끝에 반복적으로 덧붙는 실시간 버그의 흔적) 탐지 — 순수 모듈, 테스트 대상.
 *
 * 실시간 절전-재접속/재시드 레이스로 Yjs가 같은 내용을 서로 독립적인 삽입으로 병합하면
 * `ABC` → `ABCABC`(→ `ABCABCABC` …)처럼 **전체 내용이 정확히 k회 반복**된다. 이 시그니처는
 * 내용으로만 식별 가능하다(시각·버전·rev로는 stale 재전송과 구분 불가 — 재전송이 늘 '최신 쓰기').
 *
 * 보수적으로 **정확한 주기 반복만** 탐지한다(n이 단위 길이로 나누어떨어지고 k≥2). 편집이 끼어
 * 주기가 깨진 경우(부분 사본)는 거짓수정을 피하려 일부러 놓친다 — 사람이 확인 후 적용하는 전제.
 * 반대로 작은 단위의 정상 반복(예: 체크리스트 템플릿)을 오염으로 오인하지 않도록 최소 단위 길이를 둔다.
 */

/** 오염으로 간주할 최소 반복 단위 길이(글자). 현장 버그의 단위는 '노트 전체'라 충분히 크다 —
 *  이보다 짧은 주기는 정상 반복 패턴(템플릿 등)일 수 있어 탐지에서 제외(거짓양성 방지). */
export const MIN_UNIT_CHARS = 24;

/** KMP 실패 함수로 문자열의 최소 주기를 구한다. 반환값 p가 n을 나누어떨어지게 하면 s는 s[0..p)의 반복. */
export function smallestPeriod(s: string): number {
	const n = s.length;
	if (n === 0) return 0;
	const fail = new Array<number>(n).fill(0);
	for (let i = 1; i < n; i++) {
		let j = fail[i - 1];
		while (j > 0 && s[i] !== s[j]) j = fail[j - 1];
		if (s[i] === s[j]) j++;
		fail[i] = j;
	}
	return n - fail[n - 1];
}

export interface RepeatHit {
	/** 축소된 정본(반복 단위 1개). */
	unit: string;
	/** 반복 횟수(k≥2). */
	copies: number;
}

/**
 * content가 단위의 정확한 k회(k≥2) 반복이면 단위와 횟수를 돌려준다. 아니면 null.
 * 단위 길이가 MIN_UNIT_CHARS 미만이면(정상 반복 패턴일 수 있음) null.
 */
export function detectPeriodicRepeat(content: string, minUnit: number = MIN_UNIT_CHARS): RepeatHit | null {
	const n = content.length;
	if (n < minUnit * 2) return null; // 단위 2개 이상이 되려면 최소 길이 필요
	const p = smallestPeriod(content);
	if (p === n) return null; // 주기 없음(자기 자신)
	if (n % p !== 0) return null; // 정확한 반복 아님(부분 사본) — 보수적으로 제외
	const copies = n / p;
	if (copies < 2) return null;
	if (p < minUnit) return null; // 단위가 너무 짧음 — 정상 반복일 수 있어 제외
	return { unit: content.slice(0, p), copies };
}
