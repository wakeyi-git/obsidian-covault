import { EventRef } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { VersionDoc, VersionKind } from "../../core/model/types";
import { t, formatDate } from "../../i18n";

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
	}
}

/**
 * 버전 기록 탭. 활성 마크다운 노트의 버전 스냅샷을 보여주고 복원한다(보고서 §1 P2).
 * 활성 파일이 바뀌면 다시 렌더한다(피드백 탭과 동일 패턴).
 */
export class VersionHistorySection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private refs: EventRef[] = [];
	private expanded: string | null = null;
	private currentPath: string | null = null;
	private renderSeq = 0;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("covault-panel-section");
		container.addClass("covault-version");
		this.listEl = container.createDiv({ cls: "covault-version-list" });

		this.refs.push(this.host.app.workspace.on("active-leaf-change", () => void this.renderList()));
		this.refs.push(this.host.app.workspace.on("file-open", () => void this.renderList()));
		void this.renderList();
	}

	dispose(): void {
		for (const r of this.refs) this.host.app.workspace.offref(r);
		this.refs = [];
		this.listEl = null;
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
		const seq = ++this.renderSeq;
		const file = this.host.app.workspace.getActiveFile();
		this.currentPath = file?.path ?? null;

		const writeEmpty = (text: string): void => {
			if (seq !== this.renderSeq || !this.listEl) return;
			this.listEl.empty();
			this.listEl.createDiv({ cls: "covault-version-empty", text });
		};

		if (!file || file.extension !== "md") {
			writeEmpty(t("version.open_a_note_to_see_its"));
			return;
		}

		let versions: VersionDoc[] = [];
		try {
			versions = await this.host.versionHistoryFor(file.path);
		} catch {
			writeEmpty(t("version.failed_to_load_version_history"));
			return;
		}
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();

		this.listEl.createDiv({ cls: "covault-version-target", text: file.path });
		if (versions.length === 0) {
			this.listEl.createDiv({
				cls: "covault-version-empty",
				text: t("version.no_saved_versions_recorded_on_edit"),
			});
			return;
		}
		for (const v of versions) this.renderRow(file.path, v);
	}

	private renderRow(localPath: string, v: VersionDoc): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "covault-version-card" });

		const head = card.createDiv({ cls: "covault-version-head" });
		head.createSpan({ cls: "covault-version-time", text: formatDate(v.createdAtMs) });
		head.createSpan({ cls: "covault-version-badge", text: kindLabel(v.kind) });

		const who = v.role === "manager" ? t("common.manager") : t("common.member");
		card.createDiv({
			cls: "covault-version-meta",
			text: t("version.msg_2", { who, by: v.createdBy, device: v.deviceId.slice(0, 6) }),
		});

		const actions = card.createDiv({ cls: "covault-version-actions" });
		panelButton(actions, this.expanded === v._id ? t("version.close_preview") : t("deploy.preview"), () => {
			this.expanded = this.expanded === v._id ? null : v._id;
			void this.renderList();
		});
		panelButton(actions, t("version.restore_this_version"), () => this.restore(localPath, v, false), { cta: true });
		panelButton(actions, t("version.back_up_current_then_restore"), () => this.restore(localPath, v, true));

		if (this.expanded === v._id) {
			card.createEl("pre", { cls: "covault-version-preview", text: v.content });
		}
	}

	private async restore(localPath: string, v: VersionDoc, backupCurrent: boolean): Promise<void> {
		const res = await this.host.restoreVersion(localPath, v._id, { backupCurrent });
		if (res === "restored") {
			this.host.logger.ok(t("version.version_restored_2", { when: formatDate(v.createdAtMs) }), true);
		}
		void this.renderList();
	}
}
