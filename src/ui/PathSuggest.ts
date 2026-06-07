import { AbstractInputSuggest, App, TAbstractFile, TFile, TFolder } from "obsidian";

export interface PathSuggestOptions {
	/** 파일 제안 포함(기본 true). */
	files?: boolean;
	/** 폴더 제안 포함(기본 false). */
	folders?: boolean;
	/** 파일 확장자 제한(소문자, 점 없이). 예: ["md", "excalidraw"]. */
	extensions?: string[];
}

/**
 * 텍스트 입력에 볼트 경로 자동완성을 붙인다(파일/폴더). Obsidian의 AbstractInputSuggest 기반.
 * 사용: `new PathSuggest(app, textComponent.inputEl, { extensions: ["md"] });`
 */
export class PathSuggest extends AbstractInputSuggest<TAbstractFile> {
	constructor(
		app: App,
		private readonly textInputEl: HTMLInputElement,
		private readonly options: PathSuggestOptions = {},
	) {
		super(app, textInputEl);
	}

	getSuggestions(query: string): TAbstractFile[] {
		const { files = true, folders = false, extensions } = this.options;
		const q = query.toLowerCase();
		const out: TAbstractFile[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder) {
				if (!folders || f.isRoot()) continue;
			} else if (f instanceof TFile) {
				if (!files) continue;
				if (extensions && !extensions.includes(f.extension.toLowerCase())) continue;
			} else {
				continue;
			}
			if (q && !f.path.toLowerCase().includes(q)) continue;
			out.push(f);
		}
		out.sort((a, b) => a.path.localeCompare(b.path));
		return out.slice(0, 50);
	}

	renderSuggestion(value: TAbstractFile, el: HTMLElement): void {
		el.setText(value.path);
		if (value instanceof TFolder) el.addClass("covault-suggest-folder");
	}

	selectSuggestion(value: TAbstractFile): void {
		this.setValue(value.path);
		// Setting/onChange 핸들러가 갱신값을 받도록 input 이벤트를 발생시킨다.
		this.textInputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}
