import { Notice, TFile } from "obsidian";
import { PanelHost, PanelSection, panelButton, DeleteModifyRow, PurgeRow } from "./PanelSection";
import { DeletedItem } from "../../core/sync/RestoreManager";
import { ConfirmModal } from "../ConfirmModal";
import { t, formatDate } from "../../i18n";

/**
 * 삭제 파일 복구 탭(보고서 §2 P1). 모든 링크의 tombstone을 모아 보여주고,
 * 원래 위치로 복구하거나 영구 삭제(purge)할 수 있게 한다. `_삭제됨/` 폴더를 직접 뒤지지 않아도 된다.
 */
export class DeletedRecoverySection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private renderSeq = 0;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("covault-panel-section");
		container.addClass("covault-recovery");

		const toolbar = container.createDiv({ cls: "covault-recovery-toolbar" });
		panelButton(toolbar, t("common.refresh"), () => void this.renderList());
		toolbar.createDiv({
			cls: "covault-panel-hint",
			text: t("recovery.restore_deleted_files_to_their_original"),
		});

		this.listEl = container.createDiv({ cls: "covault-recovery-list" });
		void this.renderList();
	}

	dispose(): void {
		this.listEl = null;
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
		const seq = ++this.renderSeq;
		const [items, conflicts, purges] = await Promise.all([
			this.host.listDeletedFiles(),
			this.host.listDeleteModify(),
			this.host.listRecentPurges(),
		]);
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();

		// 1) 삭제/수정 충돌(있을 때만, 가장 위 — 사용자 판단 필요).
		if (conflicts.length > 0) {
			this.listEl.createDiv({ cls: "covault-recovery-group is-conflict", text: t("recovery.delete_modify_conflicts") });
			for (const c of conflicts) this.renderConflictRow(c);
		}

		// 2) 삭제된 파일.
		this.listEl.createDiv({ cls: "covault-recovery-group", text: t("recovery.deleted_files") });
		if (items.length === 0) {
			this.listEl.createDiv({ cls: "covault-recovery-empty", text: t("recovery.no_deleted_files") });
		} else {
			for (const it of items) this.renderRow(it);
		}

		// 3) 최근 영구 삭제(되돌리기).
		if (purges.length > 0) {
			this.listEl.createDiv({ cls: "covault-recovery-group", text: t("recovery.recently_purged") });
			for (const p of purges) this.renderPurgeRow(p);
		}
	}

	private renderConflictRow(c: DeleteModifyRow): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "covault-recovery-card is-conflict" });
		card.createDiv({ cls: "covault-recovery-path", text: c.dbPath });
		card.createDiv({
			cls: "covault-recovery-meta",
			text: t("recovery.you_deleted_this_but_another_device"),
		});
		const actions = card.createDiv({ cls: "covault-recovery-actions" });
		panelButton(actions, t("recovery.keep_remote_edit"), () => this.resolveConflict(c, "keep-remote"), { cta: true });
		panelButton(actions, t("recovery.keep_edit_as_copy_then_delete"), () => this.resolveConflict(c, "keep-both"));
		panelButton(actions, t("recovery.apply_my_delete"), () => this.resolveConflict(c, "delete"), { warning: true });
	}

	private async resolveConflict(c: DeleteModifyRow, choice: "delete" | "keep-remote" | "keep-both"): Promise<void> {
		await this.host.resolveDeleteModify(c.remoteDb, c.dbPath, choice);
		void this.renderList();
	}

	private renderPurgeRow(p: PurgeRow): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "covault-recovery-card" });
		card.createDiv({ cls: "covault-recovery-path", text: p.dbPath });
		card.createDiv({
			cls: "covault-recovery-meta",
			text: t("recovery.permanently_deleted_2", { when: formatDate(p.purgedAt) }),
		});
		const actions = card.createDiv({ cls: "covault-recovery-actions" });
		if (p.recoverable) {
			panelButton(actions, t("panel.reopen"), () => this.undoPurge(p), { cta: true });
		} else {
			card.createDiv({ cls: "covault-recovery-note", text: t("recovery.nothing_to_undo_attachment_binary_not") });
		}
		panelButton(actions, t("recovery.remove_from_list"), async () => {
			await this.host.clearPurge(p.remoteDb, p.id);
			void this.renderList();
		});
	}

	private async undoPurge(p: PurgeRow): Promise<void> {
		const res = await this.host.undoPurge(p.remoteDb, p.id);
		if (res === "restored") new Notice(t("recovery.undone", { path: p.dbPath }));
		else new Notice(t("recovery.cannot_undo", { path: p.dbPath }));
		void this.renderList();
	}

	private renderRow(it: DeletedItem): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "covault-recovery-card" });

		const head = card.createDiv({ cls: "covault-recovery-head" });
		head.createSpan({ cls: "covault-recovery-path", text: it.dbPath });
		head.createSpan({
			cls: `covault-recovery-badge${it.recoverable ? " is-ok" : " is-warn"}`,
			text: it.kind === "asset" ? t("recovery.attachment") : t("recovery.note"),
		});

		const who = it.deletedByRole === "manager" ? t("common.manager") : t("common.member");
		const when = it.deletedAt ? formatDate(new Date(it.deletedAt)) : t("recovery.time_unknown");
		card.createDiv({
			cls: "covault-recovery-meta",
			text: t("recovery.deleted_by", { who, by: it.deletedBy ?? "", when }),
		});

		const actions = card.createDiv({ cls: "covault-recovery-actions" });
		if (it.recoverable) {
			panelButton(actions, t("recovery.restore_to_original_location"), () => this.restore(it), { cta: true });
		} else {
			card.createDiv({
				cls: "covault-recovery-note",
				text:
					it.kind === "asset"
						? t("recovery.cannot_recover_attachment_binary_is_gone")
						: t("recovery.no_content_to_recover"),
			});
		}
		panelButton(actions, t("recovery.delete_permanently"), () => this.confirmPurge(it), { warning: true });
		if (it.recoverable && it.kind === "note") {
			panelButton(actions, t("recovery.open_content"), () => this.preview(it));
		}
	}

	private async restore(it: DeletedItem): Promise<void> {
		const res = await this.host.restoreDeleted(it.remoteDb, it.dbPath, { collision: "keep-both" });
		if (res === "restored") new Notice(t("recovery.recovered_2", { path: it.dbPath }));
		else if (res === "unrecoverable") new Notice(t("recovery.cannot_recover", { path: it.dbPath }));
		else if (res === "skipped-exists") new Notice(t("recovery.skipped_a_same_file_already_exists", { path: it.dbPath }));
		void this.renderList();
	}

	private confirmPurge(it: DeletedItem): void {
		new ConfirmModal(this.host.app, {
			title: t("recovery.delete_permanently_2", { path: it.dbPath }),
			message: t("recovery.permanently_removes_this_document_from_the"),
			confirmText: t("recovery.delete_permanently"),
			warning: true,
			onConfirm: async () => {
				await this.host.purgeDeleted(it.remoteDb, it.dbPath);
				new Notice(t("recovery.permanently_deleted", { path: it.dbPath }));
				void this.renderList();
			},
		}).open();
	}

	/** 복구 전 내용 미리보기: 복구하면 생길 위치에 임시로 보지 않고, 이미 vault에 사본이 있으면 연다. */
	private async preview(it: DeletedItem): Promise<void> {
		const file = this.host.app.vault.getAbstractFileByPath(it.localPath);
		if (file instanceof TFile) {
			await this.host.app.workspace.getLeaf(false).openFile(file);
		} else {
			new Notice(t("recovery.no_copy_to_preview_restore_to"));
		}
	}
}
