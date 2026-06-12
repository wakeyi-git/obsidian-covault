import { Menu, Notice, setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { ConfirmModal } from "../ConfirmModal";
import { ChatSuggest, FilePickModal, FeedbackPickModal } from "./chatSuggest";
import { MessageDoc, CLASS_CHANNEL, dmChannel } from "../../core/model/types";
import { parseMessageBody } from "../../core/classroom/messages";
import { resolveSenderName } from "../../core/classroom/people";
import { errMessage } from "../../core/util/err";
import { t, formatDate } from "../../i18n";

interface Channel {
	id: string;
	label: string;
	temp?: boolean; // 임시 그룹 대화방(세션 카드에서 즉석 생성) — 교사가 목록에서 삭제 가능
	groupId?: string; // 그룹 채널의 그룹 uid(삭제용)
}

/**
 * 대화(메신저) 탭 — 학급 전체 채널(학급 공유 DB) + 1:1 DM(개인 mirror DB).
 * 텍스트 + 현재 노트 위키링크 + URL을 보낼 수 있고, 위키링크/URL은 클릭 가능하게 렌더.
 */
export class ChatSection implements PanelSection {
	private root: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private channel = CLASS_CHANNEL;
	private input: HTMLInputElement | null = null;
	private timer: number | null = null;
	private unsub: (() => void) | null = null;
	private lastSig = "";
	private groups: Channel[] = []; // 그룹 대화방(라이브 세션) 채널
	private groupSig = "";
	private groupMembers = new Map<string, Record<string, string>>(); // 채널 → memberId:이름(멘션 후보)
	private msgs: MessageDoc[] = []; // 현재 채널 메시지(답글 부모 조회용)
	private replyTo: MessageDoc | null = null; // 작성 중 답글 대상
	private replyBanner: HTMLElement | null = null;
	private loggedGroupError = false; // 그룹 목록 로드 실패 로그는 1회만(폴링 반복 방지)
	// 최근 N건 창(평가 P-2) — 채널이 수천 건으로 자라도 조회·렌더가 창 크기로 유계.
	private static readonly PAGE = 100;
	private limit = ChatSection.PAGE;
	private loadedChannel: string | null = null;
	private renderedIds: string[] = []; // 증분(append-only) 렌더 판정용

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	/** 채널 종류별 루시드 아이콘. */
	private channelIcon(id: string): string {
		if (id === CLASS_CHANNEL) return "megaphone";
		if (id.startsWith("group:")) return "users-round";
		return "user"; // dm
	}

	private channels(): Channel[] {
		const cls: Channel = { id: CLASS_CHANNEL, label: t("chat.class_channel") };
		const base = this.manager
			? this.host.settings.members
					.filter((m) => m.memberId && m.provisioned)
					.map((m) => ({ id: dmChannel(m.memberId), label: m.memberName || m.memberId }))
			: [{ id: dmChannel(this.host.settings.userId), label: t("chat.teacher") }];
		return [cls, ...base, ...this.groups];
	}

	render(container: HTMLElement): void {
		this.root = container;
		// 그룹 대화 카드에서 넘어온 초기 채널.
		const pending = this.host.consumePendingChatChannel();
		if (pending) this.channel = pending;
		// 학급 채널 변경(원격 수신)은 classroomStore가 알림 → 현재 학급 채널이면 갱신.
		this.unsub = this.host.classroomStore.onChange(() => {
			if (this.channel === CLASS_CHANNEL) void this.reload();
		});
		// DM/그룹은 별도 알림이 없어 가볍게 폴링(탭이 열린 동안만). 그룹 목록도 함께 갱신.
		this.timer = window.setInterval(() => {
			void this.refreshGroups();
			void this.reload();
		}, 4000);
		void this.refreshGroups();
		this.draw();
	}

	/** 그룹 대화방 목록을 갱신하고, 변경 시 드롭다운을 다시 그린다(입력 텍스트 보존). */
	private async refreshGroups(): Promise<void> {
		try {
			const g = await this.host.listChatGroups();
			const sig = g.map((x) => x.channel).join("|");
			this.groupMembers = new Map(g.map((x) => [x.channel, x.memberNames ?? {}]));
			if (sig === this.groupSig) return;
			this.groupSig = sig;
			this.groups = g.map((x) => ({
				id: x.channel,
				label: x.temp ? `${x.name} ${t("group.temp_suffix")}` : x.name,
				temp: x.temp,
				groupId: x.groupId,
			}));
			if (this.root) this.draw();
		} catch (e) {
			// 폴링 주기마다 반복되므로 1회만 기록 — 무음이면 그룹 목록이 비는 이유를 진단할 수 없다.
			if (!this.loggedGroupError) {
				this.loggedGroupError = true;
				this.host.logger.warn(t("group.failed_to_load_groups", { err: errMessage(e) }));
			}
		}
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		const keepInput = this.input?.value ?? ""; // 그룹 목록 갱신 등으로 다시 그릴 때 작성 중 텍스트 보존
		c.empty();
		c.addClass("covault-chat");

		// 채널 선택(루시드 아이콘 메뉴) — 학급/그룹/DM을 아이콘으로 구분.
		const head = c.createDiv({ cls: "covault-chat-head" });
		const chans = this.channels();
		const cur = chans.find((ch) => ch.id === this.channel) ?? chans[0];
		const picker = head.createEl("button", { cls: "covault-chat-channel" });
		setIcon(picker.createSpan({ cls: "covault-chat-channel-icon" }), this.channelIcon(this.channel));
		picker.createSpan({ cls: "covault-chat-channel-label", text: cur?.label ?? "" });
		setIcon(picker.createSpan({ cls: "covault-chat-channel-caret" }), "chevron-down");
		picker.onclick = (e) => {
			const menu = new Menu();
			for (const ch of this.channels()) {
				menu.addItem((it) =>
					it
						.setIcon(this.channelIcon(ch.id))
						.setTitle(ch.label)
						.setChecked(ch.id === this.channel)
						.onClick(() => {
							this.channel = ch.id;
							this.lastSig = "";
							this.draw();
						}),
				);
			}
			menu.showAtMouseEvent(e);
		};
		// 임시 그룹 대화방은 목록(현재 채널)에서 삭제 가능(교사). 채널 선택 버튼 옆 휴지통.
		if (this.manager && cur?.temp && cur.groupId) {
			const gid = cur.groupId;
			const name = cur.label;
			const del = head.createEl("button", { cls: "clickable-icon covault-chat-roomdel" });
			setIcon(del, "trash-2");
			del.setAttr("aria-label", t("chat.delete_temp_room"));
			del.title = t("chat.delete_temp_room");
			del.onclick = () => this.confirmDeleteRoom(gid, name);
		}

		this.listEl = c.createDiv({ cls: "covault-chat-list" });

		// 답글 배너(작성 중 답글 대상)
		this.replyBanner = c.createDiv({ cls: "covault-chat-reply-banner" });

		// 입력줄
		const compose = c.createDiv({ cls: "covault-chat-compose" });
		const note = compose.createEl("button", { cls: "clickable-icon covault-chat-attach" });
		setIcon(note, "file-text");
		note.setAttr("aria-label", t("chat.attach_note"));
		note.title = t("chat.attach_note");
		note.onclick = () => this.insertActiveNoteLink();
		const file = compose.createEl("button", { cls: "clickable-icon covault-chat-attach" });
		setIcon(file, "paperclip");
		file.setAttr("aria-label", t("chat.attach_file"));
		file.title = t("chat.attach_file");
		file.onclick = () => this.pickFile();
		const fb = compose.createEl("button", { cls: "clickable-icon covault-chat-attach" });
		setIcon(fb, "message-square-quote");
		fb.setAttr("aria-label", t("chat.attach_feedback"));
		fb.title = t("chat.attach_feedback");
		fb.onclick = () => this.pickFeedback();
		const input = compose.createEl("input", { cls: "covault-chat-input", attr: { type: "text", placeholder: t("chat.placeholder") } });
		input.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		};
		input.value = keepInput; // 재드로우 전 작성 텍스트 복원
		this.input = input;
		new ChatSuggest(this.host.app, input, () => this.mentionNames()); // [[ 파일 + @ 멘션 자동완성
		panelButton(compose, t("chat.send"), () => this.send(), { cta: true });

		c.createDiv({ cls: "covault-cr-muted covault-chat-hint", text: t("chat.shared_folder_hint") });

		this.renderReplyBanner(); // 재드로우 후 답글 상태 복원
		this.lastSig = "";
		void this.reload();
	}

	/** 임시 그룹 대화방 삭제(교사) — 그룹·대화방 soft-delete 후 학급 채널로 복귀. */
	private confirmDeleteRoom(groupId: string, name: string): void {
		new ConfirmModal(this.host.app, {
			title: t("chat.delete_temp_room"),
			message: t("chat.delete_temp_confirm", { name }),
			confirmText: t("common.delete"),
			warning: true,
			onConfirm: async () => {
				await this.host.deleteGroup(groupId);
				this.channel = CLASS_CHANNEL;
				await this.refreshGroups();
				this.draw();
			},
		}).open();
	}

	private insertActiveNoteLink(): void {
		const f = this.host.app.workspace.getActiveFile();
		if (!f) return;
		this.insertSnippet(`[[${f.basename}]]`);
	}

	private pickFile(): void {
		new FilePickModal(this.host.app, async (f) => {
			const md = await this.host.attachFileToChannel(this.channel, f.path);
			if (md) this.insertSnippet(md);
		}).open();
	}

	/** 현재 노트(실시간 공동 편집 중인 노트)의 피드백을 골라 참조 토큰으로 삽입. */
	private async pickFeedback(): Promise<void> {
		const f = this.host.app.workspace.getActiveFile();
		if (!f) {
			new Notice(t("chat.no_feedback_here"));
			return;
		}
		const items = await this.host.listFeedback(f.path);
		if (!items.length) {
			new Notice(t("chat.no_feedback_here"));
			return;
		}
		new FeedbackPickModal(this.host.app, items, (it) => {
			const label = it.label.replace(/[|()]/g, " ").trim() || (it.path.split("/").pop() ?? it.path); // 토큰 깨짐 방지
			this.insertSnippet(`((fb|${it.path}|${it.uid}|${label}))`);
		}).open();
	}

	/** 입력칸에 링크/임베드 스니펫을 공백 구분으로 덧붙이고 포커스. */
	private insertSnippet(snippet: string): void {
		if (!this.input) return;
		const cur = this.input.value;
		this.input.value = (cur && !cur.endsWith(" ") ? `${cur} ` : cur) + `${snippet} `;
		this.input.focus();
	}

	private async send(): Promise<void> {
		const body = this.input?.value.trim();
		if (!body) return;
		const ok = await this.host.sendMessage(this.channel, body, this.replyTo?._id);
		if (ok && this.input) this.input.value = "";
		if (ok) {
			this.replyTo = null;
			this.renderReplyBanner();
		}
		await this.reload();
	}

	/** 답글 작성 모드 진입: 부모 메시지를 인용해 표시. */
	private startReply(m: MessageDoc): void {
		this.replyTo = m;
		this.renderReplyBanner();
		this.input?.focus();
	}

	/** 작성칸 위 답글 배너(취소 가능) 갱신. */
	private renderReplyBanner(): void {
		const box = this.replyBanner;
		if (!box) return;
		box.empty();
		if (!this.replyTo) {
			box.hide();
			return;
		}
		box.show();
		box.createSpan({ cls: "covault-chat-reply-to", text: t("chat.replying_to", { name: this.senderName(this.replyTo.byUser, this.replyTo.byRole, this.replyTo.byName) }) });
		box.createSpan({ cls: "covault-chat-reply-snip covault-cr-muted", text: this.snippet(this.replyTo.body) });
		const cancel = box.createEl("button", { cls: "clickable-icon covault-chat-reply-cancel" });
		setIcon(cancel, "x");
		cancel.setAttr("aria-label", t("common.cancel"));
		cancel.onclick = () => {
			this.replyTo = null;
			this.renderReplyBanner();
		};
	}

	/** 본문에서 링크/멘션 토큰을 걷어낸 짧은 미리보기. */
	private snippet(body: string, max = 60): string {
		const text = parseMessageBody(body)
			.map((s) =>
				s.kind === "text" ? s.text : s.kind === "url" ? s.url : s.kind === "wikilink" ? s.target : s.kind === "mention" ? `@${s.name}` : s.label,
			)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		return text.length > max ? text.slice(0, max - 1) + "…" : text;
	}

	private async reload(): Promise<void> {
		const list = this.listEl;
		if (!list) return;
		// 채널이 바뀌면 창·증분 상태 초기화(평가 P-2).
		if (this.channel !== this.loadedChannel) {
			this.loadedChannel = this.channel;
			this.limit = ChatSection.PAGE;
			this.renderedIds = [];
			this.lastSig = "";
		}
		// 학급 채널은 학급 공동 공간이 필요.
		if (this.channel === CLASS_CHANNEL && !this.host.homeroomReady()) {
			if (this.lastSig === "no-home") return;
			this.lastSig = "no-home";
			list.empty();
			this.empty(list, t("chat.class_needs_homeroom"));
			return;
		}
		// +1건 더 요청해 "이전 메시지" 존재 여부를 판정(전체 카운트 없이).
		const fetched = await this.host.listMessages(this.channel, this.limit + 1);
		const hasMore = fetched.length > this.limit;
		const msgs = hasMore ? fetched.slice(fetched.length - this.limit) : fetched;
		const sig = `${this.channel}|${this.limit}|${msgs.length}|${msgs[0]?._id ?? ""}|${msgs[msgs.length - 1]?._id ?? ""}|${msgs[msgs.length - 1]?._rev ?? ""}`;
		if (sig === this.lastSig) return; // 변화 없으면 재렌더 생략(폴링 깜빡임 방지)
		this.lastSig = sig;
		this.msgs = msgs;
		const me = this.host.settings.userId;
		const ids = msgs.map((m) => m._id);

		// append-only(기존 렌더가 새 목록의 prefix) → 꼬리만 추가(평가 P-2). 창이 차서 미끄러지거나
		// 삭제·이전 메시지 로드로 머리가 바뀌면 전체 재구성 — 창 크기(≤PAGE)로 유계라 저렴하다.
		const isAppend =
			this.renderedIds.length > 0 &&
			this.renderedIds.length < ids.length &&
			this.renderedIds.every((id, i) => ids[i] === id);
		const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
		if (isAppend) {
			for (const m of msgs.slice(this.renderedIds.length)) this.renderMessage(list, m, m.byUser === me);
			this.renderedIds = ids;
			if (nearBottom) list.scrollTop = list.scrollHeight;
			return;
		}

		const firstRender = this.renderedIds.length === 0;
		const prevScroll = list.scrollTop;
		list.empty();
		if (msgs.length === 0) {
			this.renderedIds = [];
			this.empty(list, t("chat.no_messages"));
			return;
		}
		if (hasMore) {
			const more = list.createEl("button", { cls: "covault-chat-more", text: t("chat.load_more") });
			more.onclick = () => {
				this.limit += ChatSection.PAGE;
				void this.reload();
			};
		}
		for (const m of msgs) this.renderMessage(list, m, m.byUser === me);
		this.renderedIds = ids;
		// 첫 렌더·하단 근처면 최신으로, 아니면 읽던 위치 유지(폴링 중 스크롤 리셋 방지).
		list.scrollTop = firstRender || nearBottom ? list.scrollHeight : prevScroll;
	}

	private renderMessage(parent: HTMLElement, m: MessageDoc, mine: boolean): void {
		const row = parent.createDiv({ cls: `covault-chat-msg${mine ? " is-mine" : ""}` });
		const meta = row.createDiv({ cls: "covault-chat-meta" });
		meta.createSpan({ cls: "covault-feedback-author", text: this.senderName(m.byUser, m.byRole, m.byName) });
		meta.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(m.createdAtMs)) });
		const reply = meta.createEl("button", { cls: "clickable-icon covault-chat-replybtn" });
		setIcon(reply, "reply");
		reply.setAttr("aria-label", t("chat.reply"));
		reply.title = t("chat.reply");
		reply.onclick = () => this.startReply(m);
		if (mine) {
			const del = meta.createEl("button", { cls: "clickable-icon covault-chat-del" });
			setIcon(del, "x");
			del.setAttr("aria-label", t("common.delete"));
			del.onclick = async () => {
				await this.host.deleteMessage(this.channel, m);
				await this.reload();
			};
		}
		// 답글 인용: 부모 메시지 요약(현재 로드된 목록에서 찾음).
		if (m.replyTo) {
			const parentMsg = this.msgs.find((x) => x._id === m.replyTo);
			const quote = row.createDiv({ cls: "covault-chat-quote covault-cr-muted" });
			if (parentMsg) {
				quote.createSpan({ cls: "covault-chat-quote-author", text: this.senderName(parentMsg.byUser, parentMsg.byRole, parentMsg.byName) });
				quote.createSpan({ text: this.snippet(parentMsg.body, 50) });
			} else {
				quote.createSpan({ text: t("chat.reply_deleted") });
			}
		}
		const bubble = row.createDiv({ cls: "covault-chat-bubble" });
		for (const seg of parseMessageBody(m.body)) {
			if (seg.kind === "text") bubble.appendText(seg.text);
			else if (seg.kind === "url") {
				const a = bubble.createEl("a", { cls: "covault-chat-link", text: seg.url, href: seg.url });
				a.onclick = (e) => {
					e.preventDefault();
					window.open(seg.url, "_blank");
				};
			} else if (seg.kind === "mention") {
				bubble.createSpan({ cls: "covault-chat-mention", text: `@${seg.name}` });
			} else if (seg.kind === "feedback") {
				const a = bubble.createEl("a", { cls: "covault-chat-link covault-chat-fb", text: `💬 ${seg.label}` });
				a.onclick = (e) => {
					e.preventDefault();
					void this.host.openFeedback(seg.path, seg.uid);
				};
			} else {
				const dest = this.host.app.metadataCache.getFirstLinkpathDest(seg.target, "");
				const isImg = !!dest && /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(dest.extension);
				if (seg.embed && isImg && dest) {
					// 이미지 임베드는 인라인 미리보기(클릭하면 열기).
					const img = bubble.createEl("img", { cls: "covault-chat-img" });
					img.src = this.host.app.vault.getResourcePath(dest);
					img.onclick = () => void this.host.app.workspace.openLinkText(seg.target, "", false);
				} else {
					const a = bubble.createEl("a", { cls: "covault-chat-link", text: seg.target });
					a.onclick = (e) => {
						e.preventDefault();
						void this.host.app.workspace.openLinkText(seg.target, "", false);
					};
				}
			}
		}
	}

	/** @멘션 자동완성 후보 이름: 본인·선생님·(교사)명단·현재 그룹 멤버. */
	private mentionNames(): string[] {
		const s = this.host.settings;
		const set = new Set<string>();
		if (s.displayName) set.add(s.displayName);
		set.add(t("chat.teacher"));
		for (const m of s.members) if (m.memberName) set.add(m.memberName);
		const gm = this.groupMembers.get(this.channel);
		if (gm) for (const n of Object.values(gm)) if (n) set.add(n);
		return [...set];
	}

	private senderName(byUser: string, byRole: "member" | "manager", byName?: string): string {
		const s = this.host.settings;
		if (byUser === s.userId) return s.displayName || byUser; // 본인
		const fromRoster = resolveSenderName(byUser, byRole, { ownUserId: s.userId, ownName: s.displayName, members: s.members, teacherLabel: t("chat.teacher") });
		// 명단으로 해석되면 그 이름, 아니면(학생이 동료를 모를 때) 문서에 담긴 작성자 이름 사용.
		return fromRoster !== byUser ? fromRoster : byName || byUser;
	}

	private empty(parent: HTMLElement, text: string): void {
		const box = parent.createDiv({ cls: "covault-cr-empty" });
		setIcon(box.createSpan(), "messages-square");
		box.createDiv({ text });
	}

	dispose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.unsub?.();
		this.unsub = null;
		this.root = null;
		this.listEl = null;
		this.input = null;
	}
}
