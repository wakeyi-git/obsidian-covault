import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

/**
 * 구성원 그룹 신청 — 이름 + 그룹 공간 폴더 + 구성원 체크박스(roster 기반).
 * 본인은 항상 포함(체크 고정). 승인되면 폴더가 그룹 공유 공간이 된다.
 */
export class GroupRequestModal extends Modal {
	constructor(
		app: App,
		private roster: Array<{ memberId: string; name: string }>,
		private selfId: string,
		private onSubmit: (input: { name: string; folder: string; memberIds: string[] }) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.createEl("h3", { text: t("group.request_title") });
		let name = "";
		let folder = "";
		const selected = new Set<string>([this.selfId]);

		new Setting(c).setName(t("group.name")).addText((tx) => {
			tx.setValue(name).onChange((v) => (name = v));
			tx.inputEl.focus();
		});
		new Setting(c)
			.setName(t("group.request_folder"))
			.setDesc(t("group.request_folder_hint"))
			.addText((tx) => {
				tx.setPlaceholder(t("group.request_folder_placeholder")).onChange((v) => (folder = v));
			});

		c.createDiv({ cls: "covault-cr-muted", text: t("group.members") });
		const grid = c.createDiv({ cls: "covault-rt-parts" });
		for (const m of this.roster) {
			const self = m.memberId === this.selfId;
			const lab = grid.createEl("label", { cls: "covault-rt-part" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = self || selected.has(m.memberId);
			if (self) cb.disabled = true; // 본인은 항상 포함
			cb.onchange = () => {
				if (cb.checked) selected.add(m.memberId);
				else selected.delete(m.memberId);
				lab.toggleClass("is-on", cb.checked);
			};
			lab.toggleClass("is-on", cb.checked);
			lab.createSpan({ text: m.name || m.memberId });
		}

		new Setting(c).addButton((b) =>
			b
				.setButtonText(t("group.request_cta"))
				.setCta()
				.onClick(() => {
					if (!name.trim()) {
						new Notice(t("group.name_required"));
						return;
					}
					this.onSubmit({ name: name.trim(), folder: (folder || name).trim(), memberIds: [...selected] });
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
