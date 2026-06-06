import { App, Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";
import { InvitePayload, buildInviteUri, encodeInvite } from "../core/invite/invite";
import { t } from "../i18n";

/**
 * 학생 초대 표시. 기술문서 §22.4.
 * QR(obsidian:// 딥링크) + 복사 코드. 학생이 폰 카메라로 스캔하거나 코드를 붙여넣어 자동 설정한다.
 */
export class InviteModal extends Modal {
	constructor(
		app: App,
		private payload: InvitePayload,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const uri = buildInviteUri(this.payload);
		const code = encodeInvite(this.payload);

		contentEl.createEl("h2", {
			text: t("invite.invite_student", { name: this.payload.memberName || this.payload.memberId }),
		});
		contentEl.createEl("p", {
			text: t("invite.when_the_student_scans_the_qr",
			),
		});

		// QR (obsidian:// 딥링크)
		const qrWrap = contentEl.createDiv({ cls: "covault-qr" });
		try {
			const qr = qrcode(0, "L");
			qr.addData(uri);
			qr.make();
			// innerHTML 대신 SVG 문자열을 파싱해 element로 삽입(심사 가이드라인: innerHTML 회피).
			const svg = new DOMParser().parseFromString(
				qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true }),
				"image/svg+xml",
			).documentElement;
			qrWrap.empty();
			qrWrap.appendChild(svg);
		} catch (e) {
			qrWrap.createEl("p", {
				text: t("invite.failed_to_generate_qr", { error: e instanceof Error ? e.message : String(e) }),
			});
		}

		// 복사 코드
		new Setting(contentEl)
			.setName(t("settings.invite_code"))
			.setDesc(t("invite.send_to_student_paste_into_student"))
			.addButton((b) =>
				b
					.setButtonText(t("invite.copy_code"))
					.setCta()
					.onClick(() => this.copy(code, t("invite.invite_code_copied"))),
			)
			.addButton((b) =>
				b.setButtonText(t("invite.copy_deep_link")).onClick(() => this.copy(uri, t("invite.invite_deep_link_copied"))),
			);

		const codeEl = contentEl.createEl("textarea", { cls: "covault-invite-code" });
		codeEl.value = code;
		codeEl.readOnly = true;
		codeEl.rows = 3;

		contentEl.createEl("p", {
			cls: "covault-invite-warn",
			text: t("invite.this_invite_contains_the_student_s"),
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("panel.already_set_up_students_must_re"),
		});
	}

	private async copy(text: string, ok: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(ok);
		} catch {
			new Notice(t("invite.copy_failed_select_and_copy_the"));
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
