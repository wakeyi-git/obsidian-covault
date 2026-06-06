import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

/** 설정 내보내기 모달 — 자격증명 제외된 JSON을 보여주고 복사. 기술문서 §22.4. */
export class ExportModal extends Modal {
	constructor(app: App, private json: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("backup.export_settings") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("backup.copy_the_content_below_to_keep",
			),
		});

		const ta = contentEl.createEl("textarea", { cls: "covault-backup-input" });
		ta.rows = 12;
		ta.value = this.json;
		ta.readOnly = true;

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t("backup.copy_to_clipboard"))
					.setCta()
					.onClick(async () => {
						await navigator.clipboard.writeText(this.json).catch(() => {
							ta.select();
						});
						new Notice(t("backup.covault_settings_copied"));
					}),
			)
			.addButton((b) => b.setButtonText(t("common.close")).onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 설정 가져오기 모달 — JSON 붙여넣기 후 적용. */
export class ImportModal extends Modal {
	private value = "";
	constructor(app: App, private onImport: (json: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("backup.import_settings") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("backup.paste_the_exported_json_members_shared",
			),
		});

		const ta = contentEl.createEl("textarea", { cls: "covault-backup-input" });
		ta.rows = 12;
		ta.placeholder = t("backup.paste_settings_json_here");
		ta.oninput = () => (this.value = ta.value);
		window.setTimeout(() => ta.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("common.import"))
					.setCta()
					.onClick(async () => {
						const v = this.value.trim();
						if (!v) {
							new Notice(t("backup.covault_paste_the_content"));
							return;
						}
						this.close();
						await this.onImport(v);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
