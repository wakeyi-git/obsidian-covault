import { App, Modal, Notice, Setting } from "obsidian";
import { VersionDoc, VersionKind } from "../core/model/types";
import { t, formatDate } from "../i18n";

/** 버전 히스토리가 의존하는 호스트 동작. CoVaultPlugin이 구현. */
export interface VersionHistoryHost {
	versionHistoryFor(localPath: string): Promise<VersionDoc[]>;
	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing">;
}

function kindLabel(kind: VersionKind): string {
	switch (kind) {
		case "modify":
			return t("version.edit");
		case "delete":
			return t("version.before_delete");
		case "conflict":
			return t("version.before_conflict_resolution");
		case "restore":
			return t("version.restore");
		case "submit":
			return t("version.submission");
	}
}

/** 활성 파일의 버전 목록 + 미리보기 + 복원. 보고서 §1 P2. */
export class VersionHistoryModal extends Modal {
	private expanded: string | null = null;

	constructor(
		app: App,
		private host: VersionHistoryHost,
		private localPath: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("version.version_history_2") });
		contentEl.createEl("p", { cls: "setting-item-description", text: this.localPath });

		let versions: VersionDoc[] = [];
		try {
			versions = await this.host.versionHistoryFor(this.localPath);
		} catch (e) {
			contentEl.createEl("p", { text: t("conflict.failed_to_load_list", { error: e instanceof Error ? e.message : String(e) }) });
			return;
		}

		if (versions.length === 0) {
			contentEl.createEl("p", { text: t("version.no_saved_versions_recorded_on_edit") });
			return;
		}

		const list = contentEl.createDiv({ cls: "covault-version-list" });
		for (const v of versions) {
			const card = list.createDiv({ cls: "covault-version-card" });
			const who = v.role === "manager" ? t("common.manager") : t("common.member");
			new Setting(card)
				.setName(formatDate(v.createdAtMs))
				.setDesc(t("version.msg", { kind: kindLabel(v.kind), who, by: v.createdBy, device: v.deviceId.slice(0, 6) }))
				.addButton((b) =>
					b.setButtonText(this.expanded === v._id ? t("version.close_preview") : t("deploy.preview")).onClick(() => {
						this.expanded = this.expanded === v._id ? null : v._id;
						void this.render();
					}),
				)
				.addButton((b) => b.setButtonText(t("version.restore_this_version")).setCta().onClick(() => this.restore(v, false)))
				.addButton((b) => b.setButtonText(t("version.back_up_current_then_restore")).onClick(() => this.restore(v, true)));

			if (this.expanded === v._id) {
				card.createEl("pre", { cls: "covault-version-preview", text: v.content });
			}
		}
	}

	private async restore(v: VersionDoc, backupCurrent: boolean): Promise<void> {
		const res = await this.host.restoreVersion(this.localPath, v._id, { backupCurrent });
		if (res === "restored") new Notice(t("version.version_restored_2", { when: formatDate(v.createdAtMs) }));
		else new Notice(t("version.cannot_restore"));
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
