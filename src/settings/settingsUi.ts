/** 설정 탭·매니저 섹션이 공유하는 UI 유틸(평가 P2-2 — SettingsTab 모듈 분할 시 순환 import 회피용 분리). */
import { Platform, SettingGroup } from "obsidian";
import { CoVaultSettings } from "./types";
import { HARD_ATTACHMENT_CAP_MB, attachmentMemoryAdvisory } from "../core/sync/attachment";
import { t } from "../i18n";

/** 시스템 총 메모리(MB) 추정. 데스크톱은 Node os.totalmem(정확), 그 외엔 navigator.deviceMemory(대략 GB). 미상이면 null. */
export function detectSystemMemoryMB(): number | null {
	if (!Platform.isMobile) {
		try {
			// window.require는 런타임 글로벌(Electron) — 정적 require("os")가 아니라 번들러가 "os"를 묶지 않는다.
			const req = (window as unknown as { require?: (m: string) => { totalmem?: () => number } }).require;
			const total = typeof req === "function" ? req("os")?.totalmem?.() : null;
			if (typeof total === "number" && total > 0) return Math.round(total / (1024 * 1024));
		} catch {
			/* require 불가 환경 → deviceMemory 폴백 */
		}
	}
	const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
	return typeof dm === "number" && dm > 0 ? Math.round(dm * 1024) : null;
}

/**
 * 첨부 최대 크기 설정 + 한도/메모리 경고 렌더. "무제한"을 정직하게 최대 1GB로 클램프하고(초과 입력 즉시 보정),
 * 시스템 메모리 대비 피크 사용량이 안전 범위를 넘으면 경고를 항목 아래에 표시한다.
 */
export function renderMaxAttachmentSetting(g: SettingGroup, s: CoVaultSettings, onSave: () => Promise<void>): void {
	if (s.maxAttachmentMB > HARD_ATTACHMENT_CAP_MB) {
		s.maxAttachmentMB = HARD_ATTACHMENT_CAP_MB; // 저장돼 있던 1GB 초과 값을 정직하게 보정
		void onSave();
	}
	const warnBox = g.listEl.createDiv({ cls: "covault-issues" });
	const warnEl = warnBox.createDiv({ cls: "covault-issue is-warn" });
	const refreshWarning = (): void => {
		const eff = s.maxAttachmentMB > 0 ? s.maxAttachmentMB : HARD_ATTACHMENT_CAP_MB;
		const adv = attachmentMemoryAdvisory(eff, detectSystemMemoryMB());
		const warn = adv?.level === "warn";
		warnBox.style.display = warn ? "" : "none";
		if (warn && adv) {
			warnEl.setText(
				t("settings.attachment_memory_warning", {
					mb: eff,
					peak: Math.round((adv.peakMB / 1024) * 10) / 10,
					total: Math.round((adv.systemMemoryMB / 1024) * 10) / 10,
				}),
			);
		}
	};
	g.addSetting((set) =>
		set
			.setName(t("settings.max_attachment_size_mb"))
			.setDesc(t("settings.attachments_larger_than_this_are_not", { cap: HARD_ATTACHMENT_CAP_MB }))
			.addText((txt) =>
				commitOnBlur(txt.setValue(String(s.maxAttachmentMB)), async (v) => {
					const n = parseInt(v, 10);
					const clamped = Number.isFinite(n) && n >= 0 ? Math.min(n, HARD_ATTACHMENT_CAP_MB) : 20;
					s.maxAttachmentMB = clamped;
					if (clamped !== n) txt.setValue(String(clamped)); // 한도 초과/잘못된 입력은 정직하게 보정
					await onSave();
					refreshWarning();
				}),
			),
	);
	g.listEl.appendChild(warnBox); // addSetting이 항목을 끝에 추가하므로 경고를 그 아래로 이동
	refreshWarning();
}

/**
 * 텍스트/숫자 인풋의 변경을 **포커스가 빠질 때(blur) 또는 Enter** 에만 커밋한다(Obsidian onChange 대체).
 * Obsidian의 onChange는 매 입력(키 한 글자)마다 발화해, 한 글자마다 저장·검증·모드 재시작을 유발한다 —
 * 입력을 마치고 칸을 벗어날 때만 cb를 실행해 타이핑 도중의 비싼 적용·검증 깜빡임을 없앤다.
 * 체이닝을 위해 같은 컴포넌트를 반환한다(예: commitOnBlur(txt.setValue(x), cb)).
 */
export function commitOnBlur<T extends { inputEl: HTMLInputElement }>(txt: T, cb: (value: string) => unknown): T {
	const el = txt.inputEl;
	let last = el.value;
	const run = (): void => {
		if (el.value === last) return; // 변화 없으면 무시(빈 blur마다 저장 방지)
		// cb가 값을 보정(clamp)할 수 있으니, 실행 후의 실제 값으로 last를 갱신해 다음 blur의 중복 실행을 막는다.
		void Promise.resolve(cb(el.value)).finally(() => {
			last = el.value;
		});
	};
	el.addEventListener("blur", run);
	el.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			run();
			el.blur();
		}
	});
	return txt;
}

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
