import { Notice } from "obsidian";

/**
 * 클립보드 복사 + 결과 Notice. 같은 패턴이 모달마다 미세하게 다르게 복제되어 있던 것을 통합.
 * 실패 시(권한/포커스 등) onFail(예: 텍스트영역 선택)을 먼저 호출해 수동 복사를 돕는다.
 */
export async function copyWithNotice(text: string, okMsg: string, failMsg: string, onFail?: () => void): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(okMsg);
		return true;
	} catch {
		onFail?.();
		new Notice(failMsg);
		return false;
	}
}
