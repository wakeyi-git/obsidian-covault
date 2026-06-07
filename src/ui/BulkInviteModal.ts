import { App, Modal, Notice, Setting } from "obsidian";
import { InvitePayload, encodeInvite } from "../core/invite/invite";
import { InviteModal } from "./InviteModal";
import { t } from "../i18n";

/**
 * 일괄 초대 결과 — 방금 프로비저닝한 구성원들의 초대 코드 목록.
 * 구성원별 모달을 N개 띄우지 않고 한 곳에서 코드를 복사하거나 QR을 열 수 있게 한다.
 */
export class BulkInviteModal extends Modal {
	constructor(
		app: App,
		private payloads: InvitePayload[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("invite.bulk_invite_result", { n: this.payloads.length }) });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("invite.copy_each_code_or_open_qr"),
		});

		for (const p of this.payloads) {
			new Setting(contentEl)
				.setName(p.memberName || p.memberId)
				.setDesc(p.memberId)
				.addButton((b) =>
					b
						.setButtonText(t("invite.copy_code"))
						.setCta()
						.onClick(() => this.copy(encodeInvite(p))),
				)
				.addButton((b) =>
					b.setButtonText(t("invite.show_qr")).onClick(() => new InviteModal(this.app, p).open()),
				);
		}

		contentEl.createEl("p", {
			cls: "covault-invite-warn",
			text: t("invite.this_invite_contains_the_member_s"),
		});

		new Setting(contentEl).addButton((b) => b.setButtonText(t("common.close")).onClick(() => this.close()));
	}

	private async copy(code: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(code);
			new Notice(t("invite.invite_code_copied"));
		} catch {
			new Notice(t("invite.copy_failed_select_and_copy_the"));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
