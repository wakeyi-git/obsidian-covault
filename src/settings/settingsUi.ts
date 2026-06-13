/** 설정 탭·매니저 섹션이 공유하는 UI 유틸(평가 P2-2 — SettingsTab 모듈 분할 시 순환 import 회피용 분리). */

/** 모바일에서 자격증명/ID가 자동 대문자화·자동완성으로 망가지는 것을 방지. */
export function noAutoCorrect(el: HTMLInputElement): void {
	el.setAttribute("autocapitalize", "none");
	el.setAttribute("autocorrect", "off");
	el.setAttribute("autocomplete", "off");
	el.spellcheck = false;
}

/**
 * 임의 부모 요소 안에 접이(details) 하위 영역을 만들어 본문 컨테이너를 반환(기본 접힘). 카드의 세부 항목을
 * 접어 첫 화면을 가볍게 한다(평가 P2-2). 본문에 `new Setting(body)`로 항목을 추가한다.
 */
export function cardCollapsible(parent: HTMLElement, summary: string): HTMLElement {
	const det = parent.createEl("details", { cls: "covault-advanced" });
	det.createEl("summary", { text: summary });
	return det.createDiv({ cls: "covault-advanced-body" });
}
