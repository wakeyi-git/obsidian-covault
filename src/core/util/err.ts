/** 예외를 사람이 읽을 메시지로 변환(공통). `catch (e)` 후 메시지가 필요할 때 사용. */
export function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
