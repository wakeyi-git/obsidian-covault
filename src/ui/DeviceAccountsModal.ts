import { App, Modal, Setting } from "obsidian";
import { MemberConfig } from "../settings/types";
import { ConfirmModal } from "./ConfirmModal";
import { t } from "../i18n";

/**
 * 구성원 기기 계정 관리 모달(평가 S-2 — 기기별 계정).
 * 두 번째 기기부터는 전용 계정으로 초대를 발급한다 — 초대가 일회성(적용 즉시 회전)이 되고,
 * 분실 기기만 골라 회수할 수 있다. 기본 계정(첫 기기)은 구성원 카드의 초대/재발급이 담당.
 */
export interface DeviceAccountsHost {
	app: App;
	inviteDevice(member: MemberConfig): Promise<boolean>;
	revokeDevice(member: MemberConfig, username: string): Promise<boolean>;
}

export class DeviceAccountsModal extends Modal {
	constructor(
		private host: DeviceAccountsHost,
		private member: MemberConfig,
	) {
		super(host.app);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("device.modal_title", { name: this.member.memberName || this.member.memberId }) });
		contentEl.createEl("p", { cls: "setting-item-description", text: t("device.modal_hint") });

		new Setting(contentEl)
			.setName(t("device.primary_account"))
			.setDesc(this.member.username || this.member.memberId);

		const accounts = this.member.deviceAccounts ?? [];
		if (accounts.length === 0) {
			contentEl.createEl("p", { cls: "setting-item-description", text: t("device.none") });
		}
		for (const acc of accounts) {
			new Setting(contentEl)
				.setName(acc.username)
				.setDesc(t("device.created_at", { date: new Date(acc.createdAt).toLocaleDateString() }))
				.addButton((b) =>
					b
						.setButtonText(t("device.revoke"))
						.setWarning()
						.onClick(() =>
							new ConfirmModal(this.host.app, {
								title: t("device.revoke_confirm_title"),
								message: t("device.revoke_confirm_body", { username: acc.username }),
								warning: true,
								onConfirm: async () => {
									await this.host.revokeDevice(this.member, acc.username);
									this.render();
								},
							}).open(),
						),
				);
		}

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t("device.new_invite"))
				.setCta()
				.onClick(async () => {
					b.setDisabled(true);
					try {
						await this.host.inviteDevice(this.member);
					} finally {
						this.render();
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
