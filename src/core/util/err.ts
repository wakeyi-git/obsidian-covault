/** 예외를 사람이 읽을 메시지로 변환(공통). `catch (e)` 후 메시지가 필요할 때 사용. */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * PouchDB/IndexedDB가 닫히는 중·닫힌 상태에서 난 에러인가 — 플러그인 비활성화/리로드 중 vault 이벤트가
 * 닫히는 로컬 DB에 도달하는 정상 종료 레이스. 실제 동작 실패가 아니라 다음 시작의 정합 복구로 치유되므로,
 * 호출부에서 이걸로 구분해 error 대신 info로 로깅한다.
 */
export function isDbClosingError(e: unknown): boolean {
	const m = errMessage(e).toLowerCase();
	return m.includes("connection is closing") || m.includes("database is closed");
}
