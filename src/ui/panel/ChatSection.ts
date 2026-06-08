import { App, FuzzySuggestModal, TFile, setIcon } from "obsidian";
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

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private channels(): Channel[] {
		const cls: Channel = { id: CLASS_CHANNEL, label: t("chat.class_channel") };
		if (this.manager) {
			const dms = this.host.settings.members
				.filter((m) => m.memberId && m.provisioned)
				.map((m) => ({ id: dmChannel(m.memberId), label: m.memberName || m.memberId }));
			return [cls, ...dms];
		}
		return [cls, { id: dmChannel(this.host.settings.userId), label: t("chat.teacher") }];
	}

	render(container: HTMLElement): void {
		this.root = container;
		// 학급 채널 변경(원격 수신)은 classroomStore가 알림 → 현재 학급 채널이면 갱신.
		this.unsub = this.host.classroomStore.onChange(() => {
			if (this.channel === CLASS_CHANNEL) void this.reload();
		});
		// DM은 개인 mirror라 별도 알림이 없어 가볍게 폴링(탭이 열린 동안만).
		this.timer = window.setInterval(() => void this.reload(), 4000);
		this.draw();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
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
		const input = compose.createEl("input", { cls: "covault-chat-input", attr: { type: "text", placeholder: t("chat.placeholder") } });
		input.onkeydown = (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		};
		this.input = input;
		panelButton(compose, t("chat.send"), () => this.send(), { cta: true });

		c.createDiv({ cls: "covault-cr-muted covault-chat-hint", text: t("chat.shared_folder_hint") });

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
		const ok = await this.host.sendMessage(this.channel, body);
		if (ok && this.input) this.input.value = "";
		await this.reload();
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
		const me = this.host.settings.userId;
		for (const m of msgs) this.renderMessage(list, m, m.byUser === me);
		list.scrollTop = list.scrollHeight;
	}

	private renderMessage(parent: HTMLElement, m: MessageDoc, mine: boolean): void {
		const row = parent.createDiv({ cls: `covault-chat-msg${mine ? " is-mine" : ""}` });
		const meta = row.createDiv({ cls: "covault-chat-meta" });
		meta.createSpan({ cls: "covault-feedback-author", text: this.senderName(m.byUser, m.byRole) });
		meta.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(m.createdAtMs)) });
		if (mine) {
			const del = meta.createEl("button", { cls: "clickable-icon covault-chat-del" });
			setIcon(del, "x");
			del.setAttr("aria-label", t("common.delete"));
			del.onclick = async () => {
				await this.host.deleteMessage(this.channel, m);
				await this.reload();
			};
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
			} else {
				const dest = this.host.app.metadataCache.getFirstLinkpathDest(seg.target, "");
				const isImg = !!dest && /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(dest.extension);
				if (seg.embed && isImg && dest) {
					// 이미지 임베드는 인라인 미리보기(클릭하면 열기).
					const img = bubble.createEl("img", { cls: "covault-chat-img" });
					img.src = this.host.app.vault.getResourcePath(dest);
					img.onclick = () => void this.host.app.workspace.openLinkText(seg.target, "", false);
				} else {
					const a = bubble.createEl("a", { cls: "covault-chat-link", text: `🔗 ${seg.target}` });
					a.onclick = (e) => {
						e.preventDefault();
						void this.host.app.workspace.openLinkText(seg.target, "", false);
					};
				}
			}
		}
	}

	private senderName(byUser: string, byRole: "member" | "manager"): string {
		const s = this.host.settings;
		return resolveSenderName(byUser, byRole, { ownUserId: s.userId, ownName: s.displayName, members: s.members, teacherLabel: t("chat.teacher") });
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
