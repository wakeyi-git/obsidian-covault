/**
 * 실시간 서버 거부(인증 실패·재인가 종료) 재시도 백오프(평가 P2-1 — RealtimeManager에서 추출, 순수·테스트 가능).
 * 서버가 지속 거부(예: CouchDB 미연동으로 시드 실패)할 때 즉시 재접속 루프 + 알림 폭주를 막는다.
 * 부수효과(타이머·세션 종료)는 RealtimeManager가 보유하고, 이 모듈은 지연·상태 계산만 담당한다.
 */

/** 한 문서의 거부 재시도 상태. failures=연속 실패 횟수, until=이 시각(epoch ms) 전엔 재접속 보류. */
export interface RetryState {
	failures: number;
	until: number;
}

/** 지수 백오프 지연(ms): 2s·2^(n-1), 최대 60s. n=1→2s, 2→4s, 3→8s … 6+→60s(상한). */
export function backoffDelay(failures: number): number {
	return Math.min(60_000, 2_000 * 2 ** (failures - 1));
}

/** 실패 1회를 누적한 다음 상태(failures+1, until=now+지연). now를 주입받아 순수. */
export function nextRetryState(cur: RetryState | undefined, now: number): RetryState {
	const failures = (cur?.failures ?? 0) + 1;
	return { failures, until: now + backoffDelay(failures) };
}

/** 아직 백오프 중인지(now가 until 전). 세션 시작 게이트에 사용. */
export function inBackoff(st: RetryState | undefined, now: number): boolean {
	return !!st && now < st.until;
}
