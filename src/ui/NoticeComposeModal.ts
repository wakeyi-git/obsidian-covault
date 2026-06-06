import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

/** 알림장 작성 모달(교사). 제목 + 본문(마크다운). 게시 시 onSubmit(title, body). */
export class NoticeComposeModal extends Modal {
	private title = "";
	private body = "";

	constructor(app: App, private onSubmit: (title: string, body: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("dashboard.new_notice") });

		new Setting(contentEl).setName(t("dashboard.notice_title")).addText((txt) => {
			txt.setPlaceholder(t("dashboard.notice_title_placeholder")).onChange((v) => (this.title = v));
			window.setTimeout(() => txt.inputEl.focus(), 0);
		});

		contentEl.createEl("div", { cls: "covault-dash-label", text: t("dashboard.notice_body") });
		const ta = contentEl.createEl("textarea", { cls: "covault-feedback-input" });
		ta.rows = 8;
		ta.placeholder = t("dashboard.notice_body_placeholder");
		ta.oninput = () => (this.body = ta.value);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("dashboard.post"))
					.setCta()
					.onClick(async () => {
						const title = this.title.trim();
						if (!title) {
							new Notice(t("dashboard.enter_a_title"));
							return;
						}
						this.close();
						await this.onSubmit(title, this.body.trim());
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
