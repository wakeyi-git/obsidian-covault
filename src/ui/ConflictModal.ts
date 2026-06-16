import { App, Modal, Notice, Setting } from "obsidian";
import { errMessage } from "../core/util/err";
import { ConflictInfo, ResolveChoice } from "../core/sync/ConflictManager";
import { MirrorSync } from "../core/sync/MirrorSync";
import { lineDiff, diffStats } from "../core/diff/lineDiff";
import { confirm } from "./ConfirmModal";
import { t } from "../i18n";

export interface ConflictRow {
	sync: MirrorSync;
	info: ConflictInfo;
}

export interface ConflictHost {
	listConflicts(): Promise<ConflictRow[]>;
	resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void>;
	resolveAllConflicts(rows: ConflictRow[], choice: ResolveChoice): Promise<{ resolved: number; failed: number }>;
	openConflictFiles(row: ConflictRow): Promise<void>;
}

/** 충돌 목록 + 해소 UI. 기술문서 §21.5. */
export class ConflictModal extends Modal {
	private ignoreWhitespace = false;

	constructor(
		app: App,
		private host: ConflictHost,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("covault-conflict-modal");
		await this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("panel.conflicts") });

		let rows: ConflictRow[] = [];
		try {
			rows = await this.host.listConflicts();
		} catch (e) {
			contentEl.createEl("p", {
				text: t("conflict.failed_to_load_list", { error: errMessage(e) }),
			});
			return;
		}

		if (rows.length === 0) {
			contentEl.createEl("p", { text: t("conflict.no_conflicts_right_now") });
			return;
		}

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("conflict.both_sides_edited_the_same_file"),
		});

		if (rows.length > 1) this.renderBulkBar(contentEl, rows);

		for (const row of rows) {
			const card = contentEl.createDiv({ cls: "covault-conflict-card" });
			const isAsset = row.info.kind === "asset";
			new Setting(card)
				.setName(`${isAsset ? "📎 " : ""}${row.info.dbPath}`)
				.setDesc(
					t("conflict.member_remote_edit", {
						memberId: row.info.memberId,
						by: row.info.remoteMeta.by,
						role: row.info.remoteMeta.role,
						at: row.info.remoteMeta.at,
					}),
				)
				.setHeading();

			if (isAsset) this.renderAssetInfo(card, row.info);
			else this.renderDiff(card, row.info);

			const actions = new Setting(card)
				.setClass("covault-conflict-actions")
				.addButton((b) =>
					b.setButtonText(isAsset ? t("mode.open_remote_copy") : t("conflict.compare_open")).onClick(() => this.host.openConflictFiles(row)),
				)
				.addButton((b) => b.setButtonText(t("conflict.keep_local")).setCta().onClick(() => this.act(row, "local")))
				.addButton((b) => b.setButtonText(t("conflict.apply_remote")).onClick(() => this.act(row, "remote")));
			if (isAsset) {
				actions.addButton((b) => b.setButtonText(t("conflict.keep_both_versions")).onClick(() => this.act(row, "both")));
			} else {
				actions
					.addButton((b) => b.setButtonText(t("mode.keep_both_local_as_final")).onClick(() => this.act(row, "both")))
					.addButton((b) => b.setButtonText(t("mode.keep_both_remote_as_final")).onClick(() => this.act(row, "both-remote")));
			}
		}
	}

	/** 충돌이 여럿일 때 같은 선택지로 한 번에 해소하는 일괄 처리 줄(노트·첨부 공통으로 안전한 3개만 노출). */
	private renderBulkBar(container: HTMLElement, rows: ConflictRow[]): void {
		new Setting(container)
			.setName(t("conflict.resolve_all", { count: rows.length }))
			.setClass("covault-conflict-bulk")
			.addButton((b) => b.setButtonText(t("conflict.keep_local")).onClick(() => this.actAll(rows, "local")))
			.addButton((b) => b.setButtonText(t("conflict.apply_remote")).onClick(() => this.actAll(rows, "remote")))
			.addButton((b) => b.setButtonText(t("conflict.keep_both_versions")).onClick(() => this.actAll(rows, "both")));
	}

	/** 첨부 충돌: 미리보기가 어려우므로 종류·크기만 요약. */
	private renderAssetInfo(card: HTMLElement, info: ConflictInfo): void {
		const kb = info.size != null ? `${(info.size / 1024).toFixed(1)} KB` : t("mode.size_unknown");
		card.createDiv({
			cls: "covault-conflict-assetmeta",
			text: t("mode.attachment_keep_local_apply_remote_keep", {
				mime: info.mime || t("mode.format_unknown"),
				size: kb,
			}),
		});
	}

	/** 마크다운 충돌: 로컬↔원격 라인 diff(변경 줄 하이라이트). */
	private renderDiff(card: HTMLElement, info: ConflictInfo): void {
		const local = info.localContent ?? "";
		const remote = info.remoteContent ?? "";
		const lines = lineDiff(local, remote, { ignoreWhitespace: this.ignoreWhitespace });
		const stats = diffStats(lines);

		const bar = card.createDiv({ cls: "covault-diff-bar" });
		bar.createSpan({ cls: "covault-diff-stat", text: t("mode.local_only_remote_only", stats) });
		const ws = bar.createEl("label", { cls: "covault-diff-ws" });
		const cb = ws.createEl("input", { type: "checkbox" });
		cb.checked = this.ignoreWhitespace;
		ws.createSpan({ text: t("mode.ignore_whitespace") });
		cb.onchange = () => {
			this.ignoreWhitespace = cb.checked;
			void this.render();
		};

		const pre = card.createEl("pre", { cls: "covault-diff" });
		for (const l of lines) {
			const sign = l.type === "add" ? "＋" : l.type === "remove" ? "−" : " ";
			pre.createDiv({ cls: `covault-diff-line is-${l.type}`, text: `${sign} ${l.text}` });
		}
	}

	private async act(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		try {
			await this.host.resolveConflict(row, choice);
		} catch (e) {
			this.contentEl.createEl("p", {
				text: t("conflict.resolution_failed", { error: errMessage(e) }),
			});
		}
		await this.render();
	}

	/** 일괄 해소: 되돌리기 어려우므로 확인을 거친 뒤 진행하고, 결과를 알림으로 요약한다. */
	private async actAll(rows: ConflictRow[], choice: ResolveChoice): Promise<void> {
		const action =
			choice === "local" ? t("conflict.keep_local") : choice === "remote" ? t("conflict.apply_remote") : t("conflict.keep_both_versions");
		const ok = await confirm(this.app, {
			title: t("conflict.resolve_all_confirm_title"),
			message: t("conflict.resolve_all_confirm_body", { count: rows.length, action }),
			confirmText: action,
			warning: choice === "remote",
		});
		if (!ok) return;

		const { resolved, failed } = await this.host.resolveAllConflicts(rows, choice);
		new Notice(failed > 0 ? t("conflict.resolve_all_done_failed", { resolved, failed }) : t("conflict.resolve_all_done", { resolved }));
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
