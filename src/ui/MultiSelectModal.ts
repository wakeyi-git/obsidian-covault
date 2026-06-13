import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/** 다중 선택 항목. id=저장 식별자, label=표시명. */
export interface MultiSelectItem {
	id: string;
	label: string;
}

/**
 * 범용 다중 선택 모달(평가 P2-2 — 설정 탭 정보구조 재편). 카드마다 버튼 하나로 열고, 스크롤 가능한
 * 체크박스 목록 + 전체/해제로 고른다. 공유 공간 구성원 선택·학급 운영 기능 선택 등에 공용.
 * GroupEditModal의 체크박스 그리드(covault-rt-parts) 패턴 재사용. 결과는 items 순서로 정렬(결정적).
 */
export class MultiSelectModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private items: MultiSelectItem[],
		private initial: string[],
		private onSave: (ids: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.createEl("h3", { text: this.title });
		const selected = new Set(this.initial);

		const head = new Setting(c);
		const grid = c.createDiv({ cls: "covault-rt-parts" });
		const cbs = new Map<string, HTMLInputElement>();
		const labels = new Map<string, HTMLElement>();
		const setOne = (id: string, on: boolean): void => {
			if (on) selected.add(id);
			else selected.delete(id);
			const cb = cbs.get(id);
			if (cb) cb.checked = on;
			labels.get(id)?.toggleClass("is-on", on);
		};
		for (const it of this.items) {
			const lab = grid.createEl("label", { cls: "covault-rt-part" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = selected.has(it.id);
			cb.onchange = () => setOne(it.id, cb.checked);
			lab.toggleClass("is-on", cb.checked);
			lab.createSpan({ text: it.label });
			cbs.set(it.id, cb);
			labels.set(it.id, lab);
		}
		head.addButton((b) => b.setButtonText(t("deploy.select_all")).onClick(() => this.items.forEach((it) => setOne(it.id, true))));
		head.addButton((b) => b.setButtonText(t("deploy.none")).onClick(() => this.items.forEach((it) => setOne(it.id, false))));

		new Setting(c).addButton((b) =>
			b
				.setButtonText(t("common.save"))
				.setCta()
				.onClick(() => {
					// 입력 순서가 아닌 items 순서로 정렬해 결정적 결과(배포 지문·비교 안정).
					this.onSave(this.items.map((it) => it.id).filter((id) => selected.has(id)));
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
