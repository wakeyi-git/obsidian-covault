import { App, EventRef, MarkdownView, Notice, TFile } from "obsidian";
import { FeedbackStore } from "../../core/feedback/FeedbackStore";
import { FeedbackDoc } from "../../core/model/types";
import { PanelSection } from "./PanelSection";
import { promptAddFeedback } from "../FeedbackView";
import { t, formatDate } from "../../i18n";

/** 피드백 탭 — 활성 노트의 앵커 댓글(§19.5) + 전체 미해결 피드백함 토글. */
export class FeedbackSection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private currentPath: string | null = null;
	private renderedPath: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private refs: EventRef[] = [];
	private renderSeq = 0;
	private viewMode: "current" | "all" = "current";

	constructor(private app: App, private store: FeedbackStore) {}

	render(container: HTMLElement): void {
		container.addClass("covault-feedback");

		const toolbar = container.createDiv({ cls: "covault-feedback-toolbar" });
		const addBtn = toolbar.createEl("button", { text: t("panel.add_feedback") });
		addBtn.onclick = () => promptAddFeedback(this.app, this.store, this.currentPath);
		const toggle = toolbar.createEl("button", {
			text: this.viewMode === "current" ? t("panel.show_all_unresolved") : t("panel.show_current_note"),
		});
		toggle.onclick = () => {
			this.viewMode = this.viewMode === "current" ? "all" : "current";
			toggle.setText(this.viewMode === "current" ? t("panel.show_all_unresolved") : t("panel.show_current_note"));
			this.renderedPath = null;
			void this.renderList();
		};

		this.listEl = container.createDiv({ cls: "covault-feedback-list" });

		this.refs.push(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
		this.refs.push(this.app.workspace.on("file-open", () => this.onLeafChange()));
		this.unsubscribe = this.store.onChange(() => void this.renderList());

		void this.renderList();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		for (const r of this.refs) this.app.workspace.offref(r);
		this.refs = [];
		this.listEl = null;
		this.renderedPath = null;
	}

	/** 활성 파일이 실제로 바뀐 경우에만 재렌더. 전체 보기 모드에서는 활성 파일 변화를 무시. */
	private onLeafChange(): void {
		if (this.viewMode === "all") return;
		const path = this.app.workspace.getActiveFile()?.path ?? null;
		if (path === this.renderedPath) return;
		void this.renderList();
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
		const seq = ++this.renderSeq;
		if (this.viewMode === "all") return this.renderAllList(seq);

		const file = this.app.workspace.getActiveFile();
		this.currentPath = file?.path ?? null;

		const writeEmpty = (text: string): void => {
			if (seq !== this.renderSeq || !this.listEl) return;
			this.listEl.empty();
			this.listEl.createDiv({ cls: "covault-feedback-empty", text });
			this.renderedPath = this.currentPath;
		};

		if (!this.currentPath || !file || file.extension !== "md") {
			writeEmpty(t("panel.open_a_note_to_see_its"));
			return;
		}
		if (!this.store.canAnnotate(this.currentPath)) {
			writeEmpty(t("panel.this_note_is_not_a_sync"));
			return;
		}

		const items = await this.store.listFor(this.currentPath);
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();
		this.renderedPath = this.currentPath;
		if (items.length === 0) {
			this.listEl.createDiv({
				cls: "covault-feedback-empty",
				text: t("panel.no_feedback_yet_select_text_in"),
			});
			return;
		}
		for (const doc of items) this.renderCard(doc, this.currentPath);
	}

	/** 전체 미해결 피드백함(모든 링크). 각 항목에 학생·노트 라벨을 붙이고 위치로 시 해당 노트를 연다. */
	private async renderAllList(seq: number): Promise<void> {
		const items = await this.store.listAllUnresolved();
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();
		this.renderedPath = "*all*";
		if (items.length === 0) {
			this.listEl.createDiv({ cls: "covault-feedback-empty", text: t("panel.no_unresolved_feedback") });
			return;
		}
		for (const it of items) {
			const note = it.localPath.split("/").pop() || it.localPath;
			this.renderCard(it.doc, it.localPath, t("panel.msg", { student: it.memberName, note }));
		}
	}

	private renderCard(doc: FeedbackDoc, localPath: string, label?: string): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: `covault-feedback-card${doc.resolved ? " is-resolved" : ""}` });

		const head = card.createDiv({ cls: "covault-feedback-head" });
		const who = doc.createdByRole === "manager" ? t("common.teacher") : t("common.student");
		head.createSpan({ cls: "covault-feedback-author", text: t("panel.msg_2", { who, by: doc.createdBy }) });
		head.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(doc.createdAt)) });
		if (doc.resolved) head.createSpan({ cls: "covault-feedback-badge", text: t("panel.resolved") });

		if (label) card.createDiv({ cls: "covault-feedback-target", text: label });

		if (doc.anchor.textQuote) {
			const quote = card.createDiv({ cls: "covault-feedback-quote", text: `“${doc.anchor.textQuote}”` });
			quote.onclick = () => void this.jumpTo(doc, localPath);
		}
		card.createDiv({ cls: "covault-feedback-content", text: doc.content });

		const actions = card.createDiv({ cls: "covault-feedback-actions" });
		actions.createEl("button", { text: t("panel.go_to_location") }).onclick = () => void this.jumpTo(doc, localPath);
		actions.createEl("button", { text: doc.resolved ? t("panel.reopen") : t("panel.resolve") }).onclick = async () => {
			await this.store.setResolved(localPath, doc, !doc.resolved);
		};
		const del = actions.createEl("button", { cls: "mod-warning", text: t("common.delete") });
		del.onclick = async () => {
			await this.store.remove(localPath, doc);
		};
	}

	/** 해당 노트를 열고 앵커 위치로 스크롤/선택. textQuote 재탐색 후 없으면 오프셋 폴백. */
	private async jumpTo(doc: FeedbackDoc, localPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(localPath);
		if (!(file instanceof TFile)) {
			new Notice(t("panel.class_sync_note_not_found", { path: localPath }));
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { active: true });
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.editor) return;
		const editor = view.editor;
		const content = editor.getValue();
		let idx = doc.anchor.textQuote ? content.indexOf(doc.anchor.textQuote) : -1;
		if (idx < 0) idx = Math.min(doc.anchor.start, content.length);
		const len = doc.anchor.textQuote ? doc.anchor.textQuote.length : 0;
		const from = editor.offsetToPos(idx);
		const to = editor.offsetToPos(Math.min(idx + len, content.length));
		editor.focus();
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}
}
