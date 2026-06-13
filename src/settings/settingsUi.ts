/** 설정 탭·매니저 섹션이 공유하는 UI 유틸(평가 P2-2 — SettingsTab 모듈 분할 시 순환 import 회피용 분리). */

/** 모바일에서 자격증명/ID가 자동 대문자화·자동완성으로 망가지는 것을 방지. */
export function noAutoCorrect(el: HTMLInputElement): void {
	el.setAttribute("autocapitalize", "none");
	el.setAttribute("autocorrect", "off");
	el.setAttribute("autocomplete", "off");
	el.spellcheck = false;
}
