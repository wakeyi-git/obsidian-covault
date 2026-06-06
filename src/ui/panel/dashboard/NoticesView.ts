import { TFile } from "obsidian";
import { PanelHost, panelButton } from "../PanelSection";
import {
	NoticeDoc,
	ResponseDoc,
	TimetableDoc,
	RESPONSE_ID_PREFIX,
	noticePrefix,
	responseId,
	timetableId,
} from "../../../core/model/types";
import { sortNotices, summarizeResponses, sortLessonsBySchedule, LessonSlot } from "../../../core/classroom/notices";
import { weekStart, addWeeks, weekRangeLabel } from "../../../core/classroom/week";
import { NoticeComposeModal } from "../../NoticeComposeModal";
import { TimetableView } from "./TimetableView";
import { t, formatDate } from "../../../i18n";

/** 알림장/수업안내 모듈 — 목록 + (교사)게시/집계 + (학생)읽음·댓글. category로 분리. 수업안내는 주간 시간표 임베드 + 주간 필터. */
export class NoticesView {
	private container: HTMLElement | null = null;
	private timetable: TimetableView | null = null;
	private weekKey = weekStart(Date.now());

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
		this.timetable?.dispose();
		this.timetable = null;
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

		// 수업 안내: 주간 네비게이션 + 상단 주간 시간표 임베드(시간표 패널 통합).
		if (this.isLesson) {
			const nav = c.createDiv({ cls: "covault-dash-weeknav" });
			panelButton(nav, "‹", () => this.shiftWeek(-1));
			nav.createSpan({ cls: "covault-dash-weeklabel", text: weekRangeLabel(this.weekKey) });
			panelButton(nav, "›", () => this.shiftWeek(1));
			panelButton(nav, t("dashboard.this_week"), () => {
				this.weekKey = weekStart(Date.now());
				void this.reload();
			});
			const ttBox = c.createDiv({ cls: "covault-dash-timetable-embed" });
			this.timetable = new TimetableView(this.host, this.weekKey);
			this.timetable.render(ttBox);
		}

		const raw = (await store.listByPrefix<NoticeDoc>(noticePrefix())).filter(
			(n) => !n.deleted && (n.category ?? "notice") === this.category && (!this.isLesson || n.weekKey === this.weekKey),
		);
		// 수업 안내: 오늘 요일 우선 + 교시 순(시간표 슬롯 기준). 알림장: 고정/최신순.
		let notices: NoticeDoc[];
		if (this.isLesson) {
			const tt = await store.get<TimetableDoc>(timetableId(this.weekKey));
			const slotByUid = new Map<string, LessonSlot>();
			for (const [cellKey, uid] of Object.entries(tt?.lessons ?? {})) {
				const [day, period] = cellKey.split(":").map(Number);
				slotByUid.set(uid, { day, period });
			}
			const todayIdx = (new Date().getDay() + 6) % 7; // 월=0
			notices = sortLessonsBySchedule(raw, slotByUid, todayIdx, tt?.days.length ?? 5);
		} else {
			notices = sortNotices(raw);
		}
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

	private shiftWeek(n: number): void {
		this.weekKey = addWeeks(this.weekKey, n);
		void this.reload();
	}

	private async post(title: string, body: string): Promise<void> {
		const ok = await this.host.postNotice(title, body, this.category, this.isLesson ? this.weekKey : undefined);
		if (ok) await this.reload();
	}

	private renderNotice(parent: HTMLElement, n: NoticeDoc, responses: ResponseDoc[]): void {
		const card = parent.createDiv({ cls: "covault-dash-card" });
		const top = card.createDiv({ cls: "covault-dash-card-row" });
		top.createSpan({ cls: "covault-dash-card-title", text: (n.pinned ? "📌 " : "") + n.title });
		top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(n.postedAtMs)) });
		const acts = card.createDiv({ cls: "covault-dash-rowactions" });
		panelButton(acts, t("dashboard.open"), () => this.openFile(n.filePath));
		if (this.manager) {
			panelButton(acts, t("common.delete"), async () => {
				await this.host.deleteNotice(n);
				await this.reload();
			}, { warning: true });
		}

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
		this.timetable?.dispose();
		this.timetable = null;
		this.container = null;
	}
}
