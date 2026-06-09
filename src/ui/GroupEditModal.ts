import { App, Modal, Notice, Setting } from "obsidian";
import { GroupConfig } from "../settings/types";
import { t } from "../i18n";

/** 명명 그룹 생성/수정 — 이름 + 구성원 체크박스. 설정 탭·그룹 패널 공용. */
export class GroupEditModal extends Modal {
	constructor(
		app: App,
		private members: Array<{ memberId: string; memberName: string }>,
		private initial: GroupConfig | null,
		private onSave: (g: GroupConfig) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.createEl("h3", { text: this.initial ? this.initial.name : t("group.new") });
		let name = this.initial?.name ?? "";
		const selected = new Set(this.initial?.memberIds ?? []);

		new Setting(c).setName(t("group.name")).addText((tx) => {
			tx.setValue(name).onChange((v) => (name = v));
			tx.inputEl.focus();
		});

		c.createDiv({ cls: "covault-cr-muted", text: t("group.members") });
		const grid = c.createDiv({ cls: "covault-rt-parts" });
		for (const m of this.members) {
			const lab = grid.createEl("label", { cls: "covault-rt-part" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = selected.has(m.memberId);
			cb.onchange = () => {
				if (cb.checked) selected.add(m.memberId);
				else selected.delete(m.memberId);
				lab.toggleClass("is-on", cb.checked);
			};
			lab.toggleClass("is-on", cb.checked);
			lab.createSpan({ text: m.memberName || m.memberId });
		}

		new Setting(c).addButton((b) =>
			b
				.setButtonText(t("common.save"))
				.setCta()
				.onClick(() => {
					if (!name.trim()) {
						new Notice(t("group.name_required"));
						return;
					}
					const id = this.initial?.id ?? `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
					this.onSave({ id, name: name.trim(), memberIds: [...selected] });
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
