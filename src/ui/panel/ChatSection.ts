import { AbstractInputSuggest, App, FuzzySuggestModal, Notice, TFile, setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { MessageDoc, CLASS_CHANNEL, dmChannel } from "../../core/model/types";
import { parseMessageBody } from "../../core/classroom/messages";
import { resolveSenderName } from "../../core/classroom/people";
import { t, formatDate } from "../../i18n";

interface Channel {
	id: string;
	label: string;
}

/** vault 파일 선택(첨부용). 모든 파일(노트·이미지·PDF 등). */
class FilePickModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder(t("chat.pick_file"));
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles();
	}
	getItemText(f: TFile): string {
		return f.path;
	}
	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

type FbItem = { uid: string; label: string; path: string };

/** 현재 노트의 피드백 선택(대화 피드백 참조용). */
class FeedbackPickModal extends FuzzySuggestModal<FbItem> {
	constructor(app: App, private items: FbItem[], private onPick: (i: FbItem) => void) {
		super(app);
		this.setPlaceholder(t("chat.attach_feedback"));
	}
	getItems(): FbItem[] {
		return this.items;
	}
	getItemText(i: FbItem): string {
		return i.label;
	}
	onChooseItem(i: FbItem): void {
		this.onPick(i);
	}
}

type Tok = { partial: string; start: number; end: number };
type ChatSuggestion = { kind: "file"; file: TFile } | { kind: "mention"; name: string };

/** 입력창 자동완성: `[[`→vault 파일 위키링크, `@`→구성원 멘션. 토큰만 교체한다. */
class ChatSuggest extends AbstractInputSuggest<ChatSuggestion> {
	constructor(app: App, private inputEl: HTMLInputElement, private mentionNames: () => string[]) {
		super(app, inputEl);
	}

	private before(): string {
		const val = this.inputEl.value;
		return val.slice(0, this.inputEl.selectionStart ?? val.length);
	}
	/** 닫히지 않은 `[[<부분>`. */
	private wikiToken(): Tok | null {
		const before = this.before();
		const idx = before.lastIndexOf("[[");
		if (idx < 0) return null;
		const between = before.slice(idx + 2);
		if (between.includes("]]") || between.includes("[")) return null;
		return { partial: between, start: idx, end: before.length };
	}
	/** 공백/`]` 없는 `@<부분>`. */
	private mentionToken(): Tok | null {
		const before = this.before();
		const at = before.lastIndexOf("@");
		if (at < 0) return null;
		const between = before.slice(at + 1);
		if (/[\s\]]/.test(between)) return null;
		return { partial: between, start: at, end: before.length };
	}

	getSuggestions(_q: string): ChatSuggestion[] {
		const wt = this.wikiToken();
		const mt = this.mentionToken();
		// 커서에 더 가까운(start 큰) 토큰 우선.
		if (mt && (!wt || mt.start > wt.start)) {
			const term = mt.partial.toLowerCase().trim();
			return this.mentionNames()
				.filter((n) => !term || n.toLowerCase().includes(term))
				.slice(0, 20)
				.map((name) => ({ kind: "mention", name }) as ChatSuggestion);
		}
		if (wt) {
			const term = wt.partial.toLowerCase().trim();
			return this.app.vault
				.getFiles()
				.filter((f) => !term || f.basename.toLowerCase().includes(term) || f.path.toLowerCase().includes(term))
				.sort((a, b) => a.path.localeCompare(b.path))
				.slice(0, 20)
				.map((file) => ({ kind: "file", file }) as ChatSuggestion);
		}
		return [];
	}

	renderSuggestion(s: ChatSuggestion, el: HTMLElement): void {
		el.addClass("covault-chat-suggest");
		if (s.kind === "mention") {
			el.createDiv({ cls: "covault-chat-suggest-name", text: `@${s.name}` });
		} else {
			el.createDiv({ cls: "covault-chat-suggest-name", text: s.file.basename });
			if (s.file.parent && s.file.parent.path !== "/") el.createDiv({ cls: "covault-chat-suggest-path", text: s.file.path });
		}
	}

	selectSuggestion(s: ChatSuggestion): void {
		if (s.kind === "mention") this.replace(this.mentionToken(), `@[${s.name}] `);
		else this.replace(this.wikiToken(), `[[${s.file.basename}]]`);
	}

	private replace(tok: Tok | null, ins: string): void {
		if (!tok) {
			this.close();
			return;
		}
		const val = this.inputEl.value;
		this.inputEl.value = val.slice(0, tok.start) + ins + val.slice(tok.end);
		const caret = tok.start + ins.length;
		this.inputEl.setSelectionRange(caret, caret);
		this.inputEl.dispatchEvent(new Event("input"));
		this.inputEl.focus();
		this.close();
	}
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

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
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
			this.groups = g.map((x) => ({ id: x.channel, label: `👥 ${x.name}` }));
			if (this.root) this.draw();
		} catch {
			/* 무시 */
		}
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		const keepInput = this.input?.value ?? ""; // 그룹 목록 갱신 등으로 다시 그릴 때 작성 중 텍스트 보존
		c.empty();
		c.addClass("covault-chat");

		// 채널 선택
		const head = c.createDiv({ cls: "covault-chat-head" });
		const sel = head.createEl("select", { cls: "covault-chat-channel dropdown" });
		for (const ch of this.channels()) {
			const opt = sel.createEl("option", { text: ch.label });
			opt.value = ch.id;
		}
		sel.value = this.channel;
		sel.onchange = () => {
			this.channel = sel.value;
			this.lastSig = "";
			void this.reload();
		};

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
		// 학급 채널은 학급 공동 공간이 필요.
		if (this.channel === CLASS_CHANNEL && !this.host.homeroomReady()) {
			if (this.lastSig === "no-home") return;
			this.lastSig = "no-home";
			list.empty();
			this.empty(list, t("chat.class_needs_homeroom"));
			return;
		}
		const msgs = await this.host.listMessages(this.channel);
		const sig = `${this.channel}|${msgs.length}|${msgs[msgs.length - 1]?._id ?? ""}|${msgs[msgs.length - 1]?._rev ?? ""}`;
		if (sig === this.lastSig) return; // 변화 없으면 재렌더 생략(폴링 깜빡임 방지)
		this.lastSig = sig;
		list.empty();
		if (msgs.length === 0) {
			this.empty(list, t("chat.no_messages"));
			return;
		}
		this.msgs = msgs;
		const me = this.host.settings.userId;
		for (const m of msgs) this.renderMessage(list, m, m.byUser === me);
		list.scrollTop = list.scrollHeight;
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
