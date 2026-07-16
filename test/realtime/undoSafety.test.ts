// @vitest-environment happy-dom
// 실시간 공동편집 undo 안전성(검토 2026-07): Obsidian 내장 CM 히스토리가 원격 참가자의 변경을
// 기록하면 Ctrl+Z가 남의 입력을 지운다. 세 겹의 방어를 실물 CM6 + yCollab으로 고정한다.
//  ① bindView의 전문 교체는 히스토리에 안 남는다(참여 직후 undo로 낡은 내용 복귀 차단)
//  ② y-codemirror.next 패치: 원격 변경 dispatch에 addToHistory:false (patches/y-codemirror.next+*.patch)
//  ③ 바인딩 동안 Mod-z는 Prec.highest 키맵으로 Yjs UndoManager(로컬 origin만)로 라우팅
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, historyKeymap, undo as cmHistoryUndo } from "@codemirror/commands";
import { keymap, runScopeHandlers } from "@codemirror/view";
import { bindView, realtimeEditorExtension } from "../../src/core/realtime/editorBinding";

/** 두 Y.Doc을 양방향 릴레이로 연결(원격 참가자 시뮬레이션). 초기 상태도 교환한다. */
function connect(a: Y.Doc, b: Y.Doc): void {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "relay");
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "relay");
	a.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(b, u, "relay");
	});
	b.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "relay") Y.applyUpdate(a, u, "relay");
	});
}

/** Obsidian 에디터처럼 CM 내장 history가 켜진 뷰를 만들고 yCollab 바인딩까지 수행. */
function makeBoundView(editorDoc: string, ytext: Y.Text, awareness: Awareness, yundo: Y.UndoManager): EditorView {
	const view = new EditorView({
		state: EditorState.create({
			doc: editorDoc,
			// Obsidian과 동일하게 내장 히스토리 + 그 키맵이 존재하는 환경을 재현한다.
			extensions: [history(), keymap.of(historyKeymap), realtimeEditorExtension()],
		}),
		parent: document.body,
	});
	bindView(view, ytext, awareness, yundo);
	return view;
}

/** 로컬 사용자의 타이핑(사용자 입력 트랜잭션). */
function typeAt(view: EditorView, pos: number, text: string): void {
	view.dispatch({ changes: { from: pos, insert: text }, userEvent: "input.type", scrollIntoView: false });
}

describe("실시간 undo 안전성 (원격 입력 보호)", () => {
	let docA: Y.Doc;
	let docB: Y.Doc;
	let view: EditorView;

	beforeEach(() => {
		docA = new Y.Doc();
		docB = new Y.Doc();
	});

	afterEach(() => {
		view?.destroy();
		docA.destroy();
		docB.destroy();
	});

	it("바인드 시 전문 교체는 CM 히스토리에 남지 않는다 — 참여 직후 undo가 낡은 내용으로 되돌리지 않음", () => {
		const ytext = docA.getText("content");
		ytext.insert(0, "최신 공동 문서");
		const yundo = new Y.UndoManager(ytext);
		view = makeBoundView("디스크의 낡은 내용", ytext, new Awareness(docA), yundo);
		expect(view.state.doc.toString()).toBe("최신 공동 문서");

		cmHistoryUndo(view); // 내장 히스토리 undo 시도
		expect(view.state.doc.toString()).toBe("최신 공동 문서"); // 되돌릴 항목이 없어야 한다
		expect(ytext.toString()).toBe("최신 공동 문서");
	});

	it("원격 변경은 CM 히스토리에 쌓이지 않는다 — 내장 undo는 내 편집만 되돌린다", () => {
		const ytext = docA.getText("content");
		ytext.insert(0, "AB");
		connect(docA, docB);
		const yundo = new Y.UndoManager(ytext);
		view = makeBoundView("", ytext, new Awareness(docA), yundo);

		typeAt(view, 2, "X"); // 내 편집: "ABX"
		docB.getText("content").insert(0, "Z"); // 원격 참가자 편집: "ZABX"
		expect(view.state.doc.toString()).toBe("ZABX");

		cmHistoryUndo(view); // Obsidian 내장 undo
		const after = view.state.doc.toString();
		expect(after).toContain("Z"); // 원격 입력은 살아남아야 한다
		expect(after).toBe("ZAB"); // 내 "X"만 되돌아간다
		expect(ytext.toString()).toBe("ZAB"); // undo 결과가 Y.Text에도 전파
	});

	it("Mod-z는 Yjs UndoManager로 라우팅된다 — 로컬 origin만 되돌리고 원격은 보존", () => {
		const ytext = docA.getText("content");
		ytext.insert(0, "AB");
		connect(docA, docB);
		const yundo = new Y.UndoManager(ytext);
		view = makeBoundView("", ytext, new Awareness(docA), yundo);

		typeAt(view, 2, "X"); // "ABX"
		docB.getText("content").insert(0, "Z"); // "ZABX"

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
			"editor",
		);
		expect(handled).toBe(true); // Prec.highest 키맵이 내장 historyKeymap보다 먼저 잡는다
		expect(view.state.doc.toString()).toBe("ZAB"); // 원격 "Z"는 보존, 내 "X"만 undo
		expect(ytext.toString()).toBe("ZAB");
	});

	it("Yjs UndoManager redo도 원격 입력을 건드리지 않는다", () => {
		const ytext = docA.getText("content");
		ytext.insert(0, "AB");
		connect(docA, docB);
		const yundo = new Y.UndoManager(ytext);
		view = makeBoundView("", ytext, new Awareness(docA), yundo);

		typeAt(view, 2, "X"); // "ABX"
		docB.getText("content").insert(0, "Z"); // "ZABX"
		yundo.undo(); // "ZAB"
		yundo.redo(); // "ZABX" 복원
		expect(view.state.doc.toString()).toBe("ZABX");
		expect(ytext.toString()).toBe("ZABX");
	});
});
