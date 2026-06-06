import { TFile } from "obsidian";
import { PanelHost, panelButton } from "../PanelSection";
import {
	NoticeDoc,
	ResponseDoc,
	RESPONSE_ID_PREFIX,
	noticePrefix,
	responseId,
} from "../../../core/model/types";
import { sortNotices, summarizeResponses } from "../../../core/classroom/notices";
import { NoticeComposeModal } from "../../NoticeComposeModal";
import { t, formatDate } from "../../../i18n";

/** 알림장/수업안내 모듈 — 목록 + (교사)게시/집계 + (학생)읽음·댓글. category로 분리. */
export class NoticesView {
	private container: HTMLElement | null = null;

	constructor(private host: PanelHost, private onBack: () => void, private category: "notice" | "lesson" = "notice") {}

	private get isLesson(): boolean {
		return this.category === "lesson";
	}
	private label(notice: string, lesson: string): string {
		return this.isLesson ? lesson : notice;
	}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private memberIds(): string[] {
		return this.host.settings.members.filter((m) => m.memberId && m.provisioned).map((m) => m.memberId);
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		// 헤더(뒤로 + 제목 + 교사 게시)
		const head = c.createDiv({ cls: "covault-dash-modhead" });
		panelButton(head, t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-dash-modtitle", text: this.label(t("dashboard.notices"), t("dashboard.lessons")) });
		if (this.manager) {
			panelButton(
				head,
				this.label(t("dashboard.new_notice"), t("dashboard.new_lesson")),
				() =>
					new NoticeComposeModal(
						this.host.app,
						(title, body) => this.post(title, body),
						this.label(t("dashboard.new_notice"), t("dashboard.new_lesson")),
					).open(),
				{ cta: true },
			);
		}

		const store = this.host.classroomStore;
		if (!store.ready()) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.homeroom_not_ready") });
			return;
		}

		const all = sortNotices(await store.listByPrefix<NoticeDoc>(noticePrefix()));
		const notices = all.filter((n) => (n.category ?? "notice") === this.category);
		const allResponses = await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX);
		if (notices.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: this.label(t("dashboard.no_notices"), t("dashboard.no_lessons")) });
			return;
		}
		const byTarget = new Map<string, ResponseDoc[]>();
		for (const r of allResponses) (byTarget.get(r.targetId) ?? byTarget.set(r.targetId, []).get(r.targetId)!).push(r);

		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const n of notices) this.renderNotice(list, n, byTarget.get(n._id) ?? []);
	}

	private async post(title: string, body: string): Promise<void> {
		const ok = await this.host.postNotice(title, body, this.category);
		if (ok) await this.reload();
	}

	private renderNotice(parent: HTMLElement, n: NoticeDoc, responses: ResponseDoc[]): void {
		const card = parent.createDiv({ cls: "covault-dash-card" });
		const top = card.createDiv({ cls: "covault-dash-card-row" });
		top.createSpan({ cls: "covault-dash-card-title", text: (n.pinned ? "📌 " : "") + n.title });
		top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(n.postedAtMs)) });
		panelButton(card, t("dashboard.open"), () => this.openFile(n.filePath));

		const sum = summarizeResponses(responses, this.memberIds());
		const me = this.host.settings.userId;

		if (this.manager) {
			// 교사: 읽음 현황 + 미읽음 명단 + 댓글 스레드
			card.createDiv({
				cls: "covault-dash-card-desc",
				text: t("dashboard.read_count", { read: sum.readCount, total: this.memberIds().length }),
			});
			if (sum.unread.length > 0)
				card.createDiv({ cls: "covault-dash-card-desc", text: t("dashboard.unread_list", { names: sum.unread.join(", ") }) });
			this.renderComments(card, sum.comments);
		} else {
			// 학생: 읽음 확인 + 댓글/질문
			const acted = card.createDiv({ cls: "covault-dash-actions" });
			const haveRead = sum.readUsers.includes(me);
			if (haveRead) acted.createSpan({ cls: "covault-feedback-badge", text: t("dashboard.read_done") });
			else panelButton(acted, t("dashboard.mark_read"), () => this.respond(n, "read"));
			this.renderComments(card, sum.comments);
			this.renderReplyBox(card, n);
		}
	}

	private renderComments(parent: HTMLElement, comments: ResponseDoc[]): void {
		if (comments.length === 0) return;
		const wrap = parent.createDiv({ cls: "covault-dash-comments" });
		for (const cmt of comments) {
			const row = wrap.createDiv({ cls: "covault-dash-comment" });
			const tag = cmt.kind === "question" ? "❓ " : "";
			row.createSpan({ cls: "covault-feedback-author", text: cmt.byUser });
			row.createSpan({ text: ` ${tag}${cmt.body ?? ""}` });
		}
	}

	private renderReplyBox(parent: HTMLElement, n: NoticeDoc): void {
		const box = parent.createDiv({ cls: "covault-dash-reply" });
		const input = box.createEl("input", { cls: "covault-dash-reply-input", attr: { type: "text", placeholder: t("dashboard.write_comment") } });
		panelButton(box, t("dashboard.comment"), () => this.submitReply(n, input, "comment"));
		panelButton(box, t("dashboard.question"), () => this.submitReply(n, input, "question"));
	}

	private async submitReply(n: NoticeDoc, input: HTMLInputElement, kind: "comment" | "question"): Promise<void> {
		const body = input.value.trim();
		if (!body) return;
		await this.respond(n, kind, body);
	}

	private async respond(n: NoticeDoc, kind: "read" | "comment" | "question", body?: string): Promise<void> {
		const s = this.host.settings;
		const now = Date.now();
		const uid = kind === "read" ? undefined : `${now.toString(36)}`;
		const doc: ResponseDoc = {
			_id: responseId(n._id, s.userId, kind, uid),
			type: "response",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			targetId: n._id,
			kind,
			body,
			byUser: s.userId,
			byRole: s.role,
			createdAtMs: now,
		};
		await this.host.classroomStore.put(doc);
		await this.reload();
	}

	private async openFile(path: string): Promise<void> {
		const f = this.host.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.host.app.workspace.getLeaf(false).openFile(f, { active: true });
	}

	dispose(): void {
		this.container = null;
	}
}
