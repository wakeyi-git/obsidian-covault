import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Obsidian(CodeMirror6) 에디터에 Yjs 바인딩을 동적으로 붙였다 뗐다 한다.
 *
 * 전역 editor extension으로 Compartment 하나를 등록해 두고(빈 확장),
 * 특정 EditorView에 대해 compartment를 yCollab으로 reconfigure하면 그 에디터만 실시간 바인딩된다.
 */
const rtCompartment = new Compartment();
// 공유 파일 읽기 전용 정책용 컴파트먼트(구성원). 실시간 세션이 없으면 읽기 전용으로 잠근다.
const readOnlyCompartment = new Compartment();

/** plugin.registerEditorExtension(...)에 넘길 전역 확장. 처음엔 빈 상태. */
export function realtimeEditorExtension(): Extension {
	return [rtCompartment.of([]), readOnlyCompartment.of([])];
}

/** 해당 뷰를 읽기 전용으로 잠그거나 해제(공유 파일 정책). 상태가 같으면 무동작. */
export function setEditorReadOnly(view: EditorView, readOnly: boolean): void {
	if (view.state.readOnly === readOnly) return;
	view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnly ? EditorState.readOnly.of(true) : []) });
}

/** 해당 뷰에 Y.Text ↔ 에디터 실시간 바인딩 부착. */
export function bindView(view: EditorView, ytext: Y.Text, awareness: Awareness): void {
	// yCollab(y-codemirror.next)은 바인딩 시 에디터의 기존 내용을 Y.Text 현재 상태로 자동 교체하지 않는다.
	// 그래서 세션 도중 늦게 참여한 사람은 (디스크에서 읽은) 오래된 내용이 남고 이후 델타만 받아 최신본이 안 보인다.
	// 바인딩 직전에 에디터를 Y.Text 현재 상태로 맞춘다(Excalidraw가 updateScene으로 하는 것과 동일).
	// yCollab이 아직 비활성이라 이 교체는 Y.Text로 역전파되지 않는다. 빈 Y.Text로 기존 내용을 지우지는 않는다.
	const yContent = ytext.toString();
	const cur = view.state.doc.toString();
	if (yContent.length > 0 && yContent !== cur) {
		view.dispatch({ changes: { from: 0, to: cur.length, insert: yContent } });
	}
	const ext: Extension = yCollab(ytext, awareness);
	view.dispatch({ effects: rtCompartment.reconfigure(ext) });
	// 커서 라벨 CSS(.cm-ySelectionInfo)를 이 클래스 아래로 스코프한다 — 전역 선택자는
	// y-codemirror를 쓰는 다른 플러그인의 커서 스타일까지 덮어쓴다.
	view.dom.classList.add("covault-rt");
}

/** 해당 뷰의 실시간 바인딩 해제. */
export function unbindView(view: EditorView): void {
	view.dispatch({ effects: rtCompartment.reconfigure([]) });
	view.dom.classList.remove("covault-rt");
}

/**
 * 이 뷰의 **현재 상태**에 실시간 바인딩(yCollab)이 실제로 구성되어 있는가(평가 R-D).
 * Obsidian이 읽기↔편집 모드 전환 등으로 EditorState를 재생성하면 Compartment가 초기값([])으로
 * 돌아가 바인딩이 사라지는데, 호출측의 bound Set에는 남아 재바인딩이 영구 스킵될 수 있다 —
 * 에디터는 정상처럼 보이지만 동기화되지 않는 좀비 상태. Set 멤버십 대신 상태를 실측한다.
 */
export function isViewBound(view: EditorView): boolean {
	const ext = rtCompartment.get(view.state);
	return Array.isArray(ext) ? ext.length > 0 : ext != null;
}
