import { TFile, setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import {
	NoticeDoc,
	ResponseDoc,
	TimetableDoc,
	RESPONSE_ID_PREFIX,
	noticePrefix,
	responseId,
	timetableId,
} from "../../../core/model/types";
import { sortNotices, summarizeResponses, LessonSlot } from "../../../core/classroom/notices";
import { weekStart } from "../../../core/classroom/week";
import { NoticeComposeModal } from "../../NoticeComposeModal";
import { TimetableView } from "./TimetableView";
import { t, formatDate } from "../../../i18n";

/** 로컬 YYYY-MM-DD. */
function localDateStr(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}
function parseDateMs(s: string): number {
	return new Date(`${s}T00:00`).getTime();
}

/** 알림장/수업안내 모듈 — 목록 + (교사)게시/집계 + (학생)읽음·댓글. category로 분리. 수업안내는 주간 시간표 임베드 + 주간 필터. */
export class NoticesView {
	private container: HTMLElement | null = null;
	private timetable: TimetableView | null = null;
	private weekKey = weekStart(Date.now());
	private limit = 0;
	private selectedDate = ""; // 수업 안내: 선택한 날짜(YYYY-MM-DD, 기본 오늘)

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

		// 헤더(뒤로 아이콘 + 제목 + 교사 게시 CTA)
		const head = c.createDiv({ cls: "covault-cr-modhead" });
		iconButton(head, "arrow-left", t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-cr-modtitle", text: this.label(t("dashboard.notices"), t("dashboard.lessons")) });
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
			this.empty(c, t("dashboard.homeroom_not_ready"));
			return;
		}

		// 수업 안내: 상단 = 선택 날짜가 속한 주의 시간표, 하단 = 그날의 수업.
		if (this.isLesson) {
			if (!this.selectedDate) this.selectedDate = localDateStr(new Date());
			this.weekKey = weekStart(parseDateMs(this.selectedDate));

			const ttBox = c.createDiv({ cls: "covault-dash-timetable-embed" });
			this.timetable = new TimetableView(this.host, this.weekKey);
			this.timetable.render(ttBox);

			const nav = c.createDiv({ cls: "covault-dash-weeknav" });
			iconButton(nav, "chevron-left", t("dashboard.prev_day"), () => this.shiftDay(-1));
			const di = nav.createEl("input", { cls: "covault-dash-dateinput", attr: { type: "date" } });
			di.value = this.selectedDate;
			di.onchange = () => {
				if (di.value) {
					this.selectedDate = di.value;
					void this.reload();
				}
			};
			iconButton(nav, "chevron-right", t("dashboard.next_day"), () => this.shiftDay(1));
			panelButton(nav, t("dashboard.today"), () => {
				this.selectedDate = localDateStr(new Date());
				void this.reload();
			});
		}

		const raw = (await store.listByPrefix<NoticeDoc>(noticePrefix())).filter(
			(n) => !n.deleted && (n.category ?? "notice") === this.category && (!this.isLesson || n.weekKey === this.weekKey),
		);
		const allResponses = await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX);
		const byTarget = new Map<string, ResponseDoc[]>();
		for (const r of allResponses) (byTarget.get(r.targetId) ?? byTarget.set(r.targetId, []).get(r.targetId)!).push(r);

		if (this.isLesson) {
			// 선택 날짜의 요일(월=0)에 해당하는 시간표 칸의 수업을 교시순으로.
			const tt = await store.get<TimetableDoc>(timetableId(this.weekKey));
			const slotByUid = new Map<string, LessonSlot>();
			for (const [cellKey, uid] of Object.entries(tt?.lessons ?? {})) {
				const [day, period] = cellKey.split(":").map(Number);
				slotByUid.set(uid, { day, period });
			}
			const weekday = (new Date(parseDateMs(this.selectedDate)).getDay() + 6) % 7;
			const dayLessons = raw
				.filter((n) => slotByUid.get(n.uid)?.day === weekday)
				.sort((a, b) => (slotByUid.get(a.uid)!.period - slotByUid.get(b.uid)!.period));
			const unplaced = raw.filter((n) => !slotByUid.has(n.uid));

			if (dayLessons.length === 0 && unplaced.length === 0) {
				this.empty(c, t("dashboard.no_lessons_day"), "calendar-days");
				return;
			}
			if (dayLessons.length > 0) {
				const list = c.createDiv({ cls: "covault-dash-list" });
				for (const n of dayLessons) this.renderNotice(list, n, byTarget.get(n._id) ?? []);
			} else {
				this.empty(c, t("dashboard.no_lessons_day"), "calendar-days");
			}
			if (unplaced.length > 0) {
				c.createDiv({ cls: "covault-cr-muted", text: t("dashboard.unplaced_lessons", { n: unplaced.length }) });
				const ul = c.createDiv({ cls: "covault-dash-list" });
				for (const n of unplaced) this.renderNotice(ul, n, byTarget.get(n._id) ?? []);
			}
			return;
		}

		// 알림장: 고정/최신순 + 페이지네이션("더 보기").
		const notices = sortNotices(raw);
		if (notices.length === 0) {
			this.empty(c, t("dashboard.no_notices"), "megaphone");
			return;
		}
		const pageSize = this.host.settings.dashboardPageSize ?? 10;
		if (!this.limit) this.limit = pageSize;
		const shown = notices.slice(0, this.limit);
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const n of shown) this.renderNotice(list, n, byTarget.get(n._id) ?? []);
		if (notices.length > shown.length) {
			const remaining = notices.length - shown.length;
			panelButton(c, t("dashboard.show_more", { n: Math.min(pageSize, remaining) }), () => {
				this.limit += pageSize;
				void this.reload();
			});
		}
	}

	private shiftDay(n: number): void {
		const d = new Date(parseDateMs(this.selectedDate || localDateStr(new Date())));
		d.setDate(d.getDate() + n);
		this.selectedDate = localDateStr(d);
		void this.reload();
	}

	private async post(title: string, body: string): Promise<void> {
		const ok = await this.host.postNotice(title, body, this.category, this.isLesson ? this.weekKey : undefined);
		if (ok) await this.reload();
	}

	private empty(parent: HTMLElement, text: string, icon = "inbox"): void {
		const box = parent.createDiv({ cls: "covault-cr-empty" });
		setIcon(box.createSpan(), icon);
		box.createDiv({ text });
	}

	private renderNotice(parent: HTMLElement, n: NoticeDoc, responses: ResponseDoc[]): void {
		const card = parent.createDiv({ cls: "covault-cr-card" });
		const top = card.createDiv({ cls: "covault-cr-card-head" });
		if (n.pinned) setIcon(top.createSpan({ cls: "covault-cr-card-icon" }), "pin");
		top.createSpan({ cls: "covault-cr-card-title", text: n.title });
		top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(n.postedAtMs)) });

		const sum = summarizeResponses(responses, this.memberIds());
		const me = this.host.settings.userId;

		if (this.manager) {
			// 교사: 읽음 진행률(막대) + 미읽음 명단 + 댓글
			const total = this.memberIds().length;
			const row = card.createDiv({ cls: "covault-cr-cardrow" });
			row.createSpan({ cls: "covault-cr-muted", text: t("dashboard.read_count", { read: sum.readCount, total }) });
			const prog = row.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = total > 0 ? `${Math.round((sum.readCount / total) * 100)}%` : "0%";
			if (sum.unread.length > 0)
				card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.unread_list", { names: sum.unread.join(", ") }) });
			this.renderComments(card, sum.comments);
		} else {
			// 학생: 읽음 배지/확인 + 댓글/질문
			const acted = card.createDiv({ cls: "covault-dash-actions" });
			if (sum.readUsers.includes(me)) acted.createSpan({ cls: "covault-cr-badge is-ok", text: t("dashboard.read_done") });
			else panelButton(acted, t("dashboard.mark_read"), () => this.respond(n, "read"), { cta: true });
			this.renderComments(card, sum.comments);
			this.renderReplyBox(card, n);
		}

		const acts = card.createDiv({ cls: "covault-dash-rowactions" });
		panelButton(acts, t("dashboard.open"), () => this.openFile(n.filePath));
		if (this.manager) {
			panelButton(acts, t("common.delete"), async () => {
				await this.host.deleteNotice(n);
				await this.reload();
			}, { warning: true });
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
