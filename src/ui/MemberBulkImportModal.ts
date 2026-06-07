import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { MemberConfig } from "../settings/types";
import { parseMemberRoster, finalizeRoster, RosterEntry } from "../settings/memberRoster";
import { t } from "../i18n";

/** 학생 명단 붙여넣기 → 미리보기(중복/조정 표시) → 일괄 추가. */
export class MemberBulkImportModal extends Modal {
	private text = "";
	private baseFolder = "";
	private previewEl: HTMLElement | null = null;

	constructor(
		app: App,
		private existingIds: string[],
		private onConfirm: (members: MemberConfig[]) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("settings.bulk_add_members") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("settings.one_per_line_name_id_or"),
		});

		const ta = contentEl.createEl("textarea", { cls: "covault-backup-input" });
		ta.rows = 8;
		ta.placeholder = "홍길동,hong\n김학생,kim,학생/3반\n이영희";
		ta.addEventListener("input", () => {
			this.text = ta.value;
			this.renderPreview();
		});
		if (!Platform.isMobile) window.setTimeout(() => ta.focus(), 0);

		new Setting(contentEl)
			.setName(t("settings.base_folder_optional"))
			.setDesc(t("settings.base_folder_desc"))
			.addText((txt) => {
				txt.setPlaceholder("학생").onChange((v) => {
					this.baseFolder = v;
					this.renderPreview();
				});
			});

		this.previewEl = contentEl.createDiv({ cls: "covault-bulk-preview" });
		this.renderPreview();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("common.add")).setCta().onClick(() => void this.confirm()));
	}

	private entries(): RosterEntry[] {
		return finalizeRoster(parseMemberRoster(this.text), this.existingIds, this.baseFolder);
	}

	private renderPreview(): void {
		const el = this.previewEl;
		if (!el) return;
		el.empty();
		const list = this.entries();
		const valid = list.filter((e) => !e.emptyName);
		el.createDiv({ cls: "covault-panel-hint", text: t("settings.preview_members_to_add", { n: valid.length }) });
		if (list.length === 0) return;

		const table = el.createEl("table", { cls: "covault-dash-table" });
		const tr = table.createEl("thead").createEl("tr");
		for (const h of [t("settings.name"), t("settings.member_id"), t("panel.mirror_db"), t("settings.folder"), t("settings.note")]) tr.createEl("th", { text: h });
		const tb = table.createEl("tbody");
		for (const e of list) {
			const row = tb.createEl("tr");
			row.createEl("td", { text: e.name || "—" });
			row.createEl("td", { text: e.id });
			row.createEl("td", { text: e.remoteDb });
			row.createEl("td", { text: e.folder || t("settings.auto") });
			const note = e.emptyName ? t("settings.no_name_excluded") : e.adjusted ? t("settings.id_adjusted") : "";
			const n = row.createEl("td", { text: note });
			if (e.emptyName) n.addClass("covault-dash-conflict");
		}
	}

	private async confirm(): Promise<void> {
		const members: MemberConfig[] = this.entries()
			.filter((e) => !e.emptyName)
			.map((e) => ({ memberId: e.id, memberName: e.name, remoteDb: e.remoteDb, localRoot: e.folder, username: "" }));
		if (members.length === 0) {
			new Notice(t("settings.covault_no_members_to_add"));
			return;
		}
		this.close();
		await this.onConfirm(members);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
