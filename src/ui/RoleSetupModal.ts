import { App, Modal, Setting } from "obsidian";
import { Role } from "../settings/types";
import { t } from "../i18n";

/**
 * 최초 실행 역할 선택 화면. 기술문서 §21.1.
 * 역할은 한 번 선택하면 잠긴다(이후 설정에서 '재설정'으로만 변경).
 * 학생은 교사 초대 코드로 바로 설정할 수도 있다.
 */
export class RoleSetupModal extends Modal {
	constructor(
		app: App,
		private onChoose: (role: Role) => void,
		private onInvite: (code: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: t("role.choose_covault_role") });
		contentEl.createEl("p", {
			text: t("role.choose_the_role_to_use_in",
			),
		});

		new Setting(contentEl)
			.setName(t("role.member_mode"))
			.setDesc(t("role.syncs_the_manager_s_member_folder"))
			.addButton((b) => b.setButtonText(t("role.choose_member")).setCta().onClick(() => this.choose("member")));

		new Setting(contentEl)
			.setName(t("role.manager_mode"))
			.setDesc(t("role.syncs_this_vault_s_member_folders"))
			.addButton((b) => b.setButtonText(t("role.choose_manager")).onClick(() => this.choose("manager")));

		contentEl.createEl("h3", { text: t("role.member_set_up_directly_with_an") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("role.scanning_the_qr_from_your_manager"),
		});
		let code = "";
		new Setting(contentEl)
			.setName(t("settings.invite_code"))
			.addText((txt) => {
				txt.setPlaceholder(t("role.paste_invite_code")).onChange((v) => (code = v));
				txt.inputEl.setAttribute("autocapitalize", "none");
				txt.inputEl.setAttribute("autocorrect", "off");
			})
			.addButton((b) =>
				b.setButtonText(t("role.set_up_from_invite")).onClick(() => {
					if (!code.trim()) return;
					this.onInvite(code);
					this.close();
				}),
			);
	}

	private choose(role: Role): void {
		this.onChoose(role);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
