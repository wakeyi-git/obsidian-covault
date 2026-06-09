import { App, MarkdownView, Notice, TFile } from "obsidian";
import { FeedbackDoc, isTextAnchor } from "../core/model/types";
import { getExcalidrawApiForFile, focusExcalidrawElements } from "./excalidrawFocus";
import { t } from "../i18n";

/**
 * 피드백 앵커 위치로 이동(파일 열기 + 텍스트 선택/스크롤 또는 Excalidraw 요소 포커스).
 * FeedbackSection·대화 피드백 링크가 공용으로 쓴다.
 */
export async function jumpToFeedback(app: App, doc: FeedbackDoc, localPath: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(localPath);
	if (!(file instanceof TFile)) {
		new Notice(t("panel.covault_note_not_found", { path: localPath }));
		return;
	}
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file, { active: true });

	// Excalidraw 드로잉 앵커: 요소 선택 + 화면 맞춤(플러그인 가용 시).
	if (!isTextAnchor(doc.anchor)) {
		const api = getExcalidrawApiForFile(app, file);
		if (!api || !focusExcalidrawElements(api, doc.anchor.elementIds)) {
			new Notice(t("panel.could_not_focus_drawing_element"));
		}
		return;
	}

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
