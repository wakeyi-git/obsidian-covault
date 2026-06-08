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
import { weekStart, weekRangeLabel } from "../../../core/classroom/week";
import { resolveSenderName, resolveMemberNames } from "../../../core/classroom/people";
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
				() => this.create(),
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

			// 시간표(주 단위 이동)
			const ttNav = c.createDiv({ cls: "covault-dash-weeknav" });
			iconButton(ttNav, "chevron-left", t("dashboard.prev_week"), () => this.shiftWeek(-1));
			ttNav.createSpan({ cls: "covault-dash-weeklabel", text: weekRangeLabel(this.weekKey) });
			iconButton(ttNav, "chevron-right", t("dashboard.next_week"), () => this.shiftWeek(1));
			panelButton(ttNav, t("dashboard.this_week"), () => this.gotoThisWeek());

			const ttBox = c.createDiv({ cls: "covault-dash-timetable-embed" });
			this.timetable = new TimetableView(this.host, this.weekKey);
			this.timetable.render(ttBox);

			// 수업 안내(일 단위 이동)
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
			(n) =>
				!n.deleted &&
				(n.category ?? "notice") === this.category &&
				(!this.isLesson || n.weekKey === this.weekKey) &&
				(this.manager || n.published !== false), // 학생에겐 게시된 글만(초안 숨김)
		);
		const allResponses = await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX);
		// 질문·교사 답글은 학급 공유가 아닌 개인 mirror에 있다(동료 비공개) → 교사=전원/학생=본인 것을 합친다.
		const privateResp = await this.host.listPrivateResponses();
		const byTarget = new Map<string, ResponseDoc[]>();
		for (const r of [...allResponses, ...privateResp])
			(byTarget.get(r.targetId) ?? byTarget.set(r.targetId, []).get(r.targetId)!).push(r);

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

	/** 시간표 주 단위 이동(선택 날짜를 ±7일, 같은 요일 유지). */
	private shiftWeek(n: number): void {
		this.shiftDay(n * 7);
	}

	/** 이번 주로 이동(현재 주의 같은 요일). */
	private gotoThisWeek(): void {
		const idx = (new Date(parseDateMs(this.selectedDate || localDateStr(new Date()))).getDay() + 6) % 7; // 월=0
		const monday = new Date(parseDateMs(weekStart(Date.now())));
		monday.setDate(monday.getDate() + idx);
		this.selectedDate = localDateStr(monday);
		void this.reload();
	}

	/** 새 글: 초안 본문 파일을 만들어 편집창에서 연다(알림장/수업). 생성 후 목록 갱신. */
	private async create(): Promise<void> {
		const ok = this.isLesson
			? (await this.host.createLesson("", this.weekKey)) != null
			: await this.host.newNotice();
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
		if (this.manager && n.published === false) top.createSpan({ cls: "covault-cr-badge is-warn", text: t("dashboard.draft") });
		// 수업 안내는 시간표/주 기준으로 배치되므로 작성일자는 표시하지 않는다(알림장만 시간순 게시 → 날짜 표시).
		if (!this.isLesson) top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(n.postedAtMs)) });

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
				card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.unread_list", { names: resolveMemberNames(sum.unread, this.host.settings.members).join(", ") }) });
			this.renderComments(card, n, sum.comments);
			// 교사도 학급 전체 댓글을 달 수 있다(질문 답글은 각 질문 아래 인라인).
			this.renderCommentBox(card, n);
		} else {
			// 학생: 읽음 배지/확인 + 댓글/질문
			const acted = card.createDiv({ cls: "covault-dash-actions" });
			if (sum.readUsers.includes(me)) acted.createSpan({ cls: "covault-cr-badge is-ok", text: t("dashboard.read_done") });
			else panelButton(acted, t("dashboard.mark_read"), () => this.respond(n, "read"), { cta: true });
			this.renderComments(card, n, sum.comments);
			this.renderReplyBox(card, n);
		}

		const acts = card.createDiv({ cls: "covault-dash-rowactions" });
		if (this.manager) {
			// 게시/게시 취소 토글 → 학생 노출 제어.
			const published = n.published !== false;
			panelButton(acts, published ? t("dashboard.unpublish") : t("dashboard.publish"), async () => {
				await this.host.setNoticePublished(n, !published);
				await this.reload();
			}, { cta: !published });
			panelButton(acts, t("common.edit"), () => this.openFile(n.filePath));
			panelButton(acts, t("common.delete"), async () => {
				await this.host.deleteNotice(n);
				await this.reload();
			}, { warning: true });
		} else {
			panelButton(acts, t("dashboard.open"), () => this.openFile(n.filePath));
		}
	}

	private senderName(byUser: string, byRole: "member" | "manager"): string {
		const s = this.host.settings;
		return resolveSenderName(byUser, byRole, { ownUserId: s.userId, ownName: s.displayName, members: s.members, teacherLabel: t("chat.teacher") });
	}

	private renderComments(parent: HTMLElement, n: NoticeDoc, comments: ResponseDoc[]): void {
		if (comments.length === 0) return;
		// 최상위(댓글·질문) + 답글(parentId)로 분리해 답글을 부모 아래 들여쓴다.
		const repliesByParent = new Map<string, ResponseDoc[]>();
		const tops: ResponseDoc[] = [];
		for (const c of comments) {
			if (c.parentId) (repliesByParent.get(c.parentId) ?? repliesByParent.set(c.parentId, []).get(c.parentId)!).push(c);
			else tops.push(c);
		}
		const wrap = parent.createDiv({ cls: "covault-dash-comments" });
		for (const cmt of tops) {
			const row = wrap.createDiv({ cls: "covault-dash-comment" });
			if (cmt.kind === "question") setIcon(row.createSpan({ cls: "covault-dash-qicon" }), "help-circle");
			row.createSpan({ cls: "covault-feedback-author", text: this.senderName(cmt.byUser, cmt.byRole) });
			row.createSpan({ text: ` ${cmt.body ?? ""}` });
			for (const rep of (repliesByParent.get(cmt._id) ?? []).sort((a, b) => a.createdAtMs - b.createdAtMs)) {
				const rr = wrap.createDiv({ cls: "covault-dash-comment covault-dash-reply-row" });
				rr.createSpan({ cls: "covault-feedback-author", text: this.senderName(rep.byUser, rep.byRole) });
				rr.createSpan({ text: ` ${rep.body ?? ""}` });
			}
			// 교사: 학생 질문에 답글(해당 학생 mirror에 비공개로 기록).
			if (this.manager && cmt.kind === "question") {
				const member = this.host.settings.members.find((m) => m.memberId === cmt.byUser);
				if (member?.remoteDb) {
					const rbox = wrap.createDiv({ cls: "covault-dash-reply covault-dash-reply-row" });
					const ri = rbox.createEl("input", { cls: "covault-dash-reply-input", attr: { type: "text", placeholder: t("dashboard.write_reply") } });
					panelButton(rbox, t("dashboard.reply"), async () => {
						const body = ri.value.trim();
						if (!body) return;
						await this.respond(n, "comment", body, { parentId: cmt._id, toRemoteDb: member.remoteDb });
					});
				}
			}
		}
	}

	/** 교사 학급 전체 댓글 입력(공유 DB). */
	private renderCommentBox(parent: HTMLElement, n: NoticeDoc): void {
		const box = parent.createDiv({ cls: "covault-dash-reply" });
		const input = box.createEl("input", { cls: "covault-dash-reply-input", attr: { type: "text", placeholder: t("dashboard.write_comment_only") } });
		panelButton(box, t("dashboard.comment"), () => this.submitReply(n, input, "comment"));
	}

	private renderReplyBox(parent: HTMLElement, n: NoticeDoc): void {
		const box = parent.createDiv({ cls: "covault-dash-reply" });
		const input = box.createEl("input", { cls: "covault-dash-reply-input", attr: { type: "text", placeholder: t("dashboard.write_comment") } });
		panelButton(box, t("dashboard.comment"), () => this.submitReply(n, input, "comment"));
		panelButton(box, t("dashboard.question"), () => this.submitReply(n, input, "question"));
		// 가시성 안내: 댓글=학급 전체, 질문=교사만.
		parent.createDiv({ cls: "covault-cr-muted", text: t("dashboard.reply_visibility_hint") });
	}

	private async submitReply(n: NoticeDoc, input: HTMLInputElement, kind: "comment" | "question"): Promise<void> {
		const body = input.value.trim();
		if (!body) return;
		await this.respond(n, kind, body);
	}

	private async respond(
		n: NoticeDoc,
		kind: "read" | "comment" | "question",
		body?: string,
		opts?: { parentId?: string; toRemoteDb?: string },
	): Promise<void> {
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
			parentId: opts?.parentId,
			createdAtMs: now,
		};
		// 교사 답글은 해당 학생 mirror(비공개), 학생 질문은 본인 mirror(비공개), 읽음/댓글은 학급 공유.
		if (opts?.toRemoteDb) await this.host.postPrivateResponseTo(opts.toRemoteDb, doc);
		else if (kind === "question") await this.host.postPrivateResponse(doc);
		else await this.host.classroomStore.put(doc);
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
