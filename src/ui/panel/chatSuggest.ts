import { AbstractInputSuggest, App, FuzzySuggestModal, TFile } from "obsidian";
import { t } from "../../i18n";
import { relUnder } from "../../core/realtime/room";

/** vault 파일 선택(첨부용). 모든 파일(노트·이미지·PDF 등). */
export class FilePickModal extends FuzzySuggestModal<TFile> {
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

export type FbItem = { uid: string; label: string; path: string };

/** 현재 노트의 피드백 선택(대화 피드백 참조용). */
export class FeedbackPickModal extends FuzzySuggestModal<FbItem> {
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

/**
 * 입력창 자동완성: `[[`→공동 공간 파일 위키링크, `@`→구성원 멘션. 토큰만 교체한다.
 * 위키링크 후보는 **공동 공간으로 설정한 폴더(sharedFolders) 내부 파일로 제한** — 공유되지 않는
 * 파일을 링크하면 상대가 열 수 없으므로(ChatSection 힌트와 동일 취지) 후보 단계에서 걸러낸다.
 */
export class ChatSuggest extends AbstractInputSuggest<ChatSuggestion> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private mentionNames: () => string[],
		private sharedFolders: () => string[],
	) {
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
			// 빈 폴더("")는 vault 전체를 삼키므로 제외 — 실제 공동 공간 폴더만 후보 범위로 삼는다.
			const folders = this.sharedFolders().filter((folder) => folder !== "");
			return this.app.vault
				.getFiles()
				.filter((f) => folders.some((folder) => relUnder(f.path, folder) !== null))
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
