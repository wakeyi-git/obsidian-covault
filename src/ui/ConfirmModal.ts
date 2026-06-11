import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export interface ConfirmOptions {
	title: string;
	/** 본문(줄바꿈 \n으로 여러 단락). */
	message: string;
	confirmText?: string;
	warning?: boolean;
	/** 선택 체크박스(예: "서버 데이터도 삭제"). 값은 onConfirm 인자로 전달. */
	checkbox?: { label: string; desc?: string; default?: boolean };
	onConfirm: (checked: boolean) => void | Promise<void>;
	/** 확인 없이 닫힐 때(취소 버튼·ESC·바깥 클릭 포함) 한 번 호출. Promise<boolean> 래핑용. */
	onCancel?: () => void;
}

/** 간단한 확인 모달(파괴적 동작 실수 방지). 서버 초기화처럼 단어 입력까지는 필요 없는 경우에 쓴다. */
export class ConfirmModal extends Modal {
	private checked: boolean;
	private confirmed = false;

	constructor(app: App, private opts: ConfirmOptions) {
		super(app);
		this.checked = opts.checkbox?.default ?? false;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.opts.title });
		for (const line of this.opts.message.split("\n")) {
			if (line.trim()) contentEl.createEl("p", { cls: "setting-item-description", text: line });
		}
		if (this.opts.checkbox) {
			const set = new Setting(contentEl).setName(this.opts.checkbox.label).addToggle((tg) =>
				tg.setValue(this.checked).onChange((v) => (this.checked = v)),
			);
			if (this.opts.checkbox.desc) set.setDesc(this.opts.checkbox.desc);
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.opts.confirmText ?? t("common.delete"));
				if (this.opts.warning) b.setWarning();
				b.onClick(async () => {
					this.confirmed = true;
					this.close();
					await this.opts.onConfirm(this.checked);
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.opts.onCancel?.();
	}
}
