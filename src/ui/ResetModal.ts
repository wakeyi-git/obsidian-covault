import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

const confirmWord = (): string => t("common.reset_2");

/**
 * 서버 데이터 초기화 확인 모달(파괴적). 삭제 범위를 선택하고, 확인 단어를 입력해야 실행된다.
 * Yjs 실시간 데이터는 플러그인이 직접 못 지우므로 수동 안내를 함께 표시한다.
 */
export class ResetModal extends Modal {
	private deleteAccounts = false;
	private confirmValue = "";

	constructor(app: App, private dbCount: number, private onConfirm: (deleteAccounts: boolean) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("reset.reset_server_data") });
		contentEl.createEl("p", {
			cls: "covault-reset-warn",
			text: t("reset.this_permanently_deletes_all_student_and", {
				count: this.dbCount,
			}),
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("reset.local_cache_and_provisioning_state_will",
			),
		});

		new Setting(contentEl)
			.setName(t("reset.also_delete_student_accounts_users_and"))
			.setDesc(
				t("reset.off_delete_dbs_only_accounts_and",
				),
			)
			.addToggle((tg) => tg.setValue(this.deleteAccounts).onChange((v) => (this.deleteAccounts = v)));

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("reset.reset_yjs_realtime_data_manually_restart",
			),
		});

		const word = confirmWord();
		let runBtn: { setDisabled(v: boolean): unknown } | null = null;
		new Setting(contentEl)
			.setName(t("reset.type_to_confirm", { word }))
			.addText((txt) => {
				txt.setPlaceholder(word).onChange((v) => {
					this.confirmValue = v.trim();
					runBtn?.setDisabled(this.confirmValue !== word);
				});
				window.setTimeout(() => txt.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				runBtn = b;
				b.setButtonText(t("reset.run_reset"))
					.setWarning()
					.setDisabled(true)
					.onClick(async () => {
						if (this.confirmValue !== word) {
							new Notice(t("reset.class_sync_type_to_confirm", { word }));
							return;
						}
						this.close();
						await this.onConfirm(this.deleteAccounts);
					});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
