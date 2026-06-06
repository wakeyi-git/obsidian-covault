import { App, TFile } from "obsidian";

/** Excalidraw 씬 요소(우리가 읽는 필드만). */
interface ExElement {
	id: string;
	type?: string;
	text?: string;
	x?: number;
	y?: number;
}

/** obsidian-excalidraw-plugin이 노출하는 명령형 API의 일부(우리가 쓰는 메서드만). */
interface ExcalidrawApiLike {
	updateScene(scene: { appState?: Record<string, unknown> }): void;
	getSceneElements(): readonly ExElement[];
	getAppState?(): { selectedElementIds?: Record<string, boolean> };
	scrollToContent?(target?: unknown, opts?: unknown): void;
}

/** 현재 드로잉에서 선택된 요소 정보(피드백 앵커 생성용). 선택이 없거나 미지원이면 null. */
export function getSelectedExcalidrawElements(
	app: App,
	file: TFile,
): { ids: string[]; label?: string; point?: { x: number; y: number } } | null {
	const api = getExcalidrawApiForFile(app, file);
	if (!api?.getAppState) return null;
	const sel = api.getAppState().selectedElementIds ?? {};
	const ids = Object.keys(sel).filter((k) => sel[k]);
	if (ids.length === 0) return null;
	const idSet = new Set(ids);
	const els = api.getSceneElements().filter((e) => idSet.has(e.id));
	const first = els[0];
	const label = first?.text?.slice(0, 40) || first?.type || undefined;
	const point = first && first.x != null && first.y != null ? { x: first.x, y: first.y } : undefined;
	return { ids, label, point };
}

/** path가 Excalidraw 드로잉인지(.excalidraw 또는 .excalidraw.md). */
export function isExcalidrawFile(path: string): boolean {
	const p = path.toLowerCase();
	return p.endsWith(".excalidraw") || p.endsWith(".excalidraw.md");
}

/**
 * 열린 Excalidraw 뷰에서 해당 파일의 명령형 API를 best-effort로 얻는다. 플러그인 미설치/미지원이면 null.
 * 피드백 "위치로" 점프에서 드로잉 요소를 선택·확대하는 데 쓴다(실패해도 파일 열기는 동작).
 */
export function getExcalidrawApiForFile(app: App, file: TFile): ExcalidrawApiLike | null {
	for (const leaf of app.workspace.getLeavesOfType("excalidraw")) {
		const view = leaf.view as unknown as { file?: TFile; excalidrawAPI?: ExcalidrawApiLike };
		if (view?.file?.path === file.path && view.excalidrawAPI?.getSceneElements) return view.excalidrawAPI;
	}
	return null;
}

/** 지정한 요소들을 선택하고 화면 중앙으로 맞춘다. 매칭 요소가 없으면 false. */
export function focusExcalidrawElements(api: ExcalidrawApiLike, elementIds: string[]): boolean {
	const ids = new Set(elementIds);
	const els = api.getSceneElements().filter((e) => ids.has(e.id));
	if (els.length === 0) return false;
	api.updateScene({ appState: { selectedElementIds: Object.fromEntries(els.map((e) => [e.id, true])) } });
	api.scrollToContent?.(els, { fitToContent: true, animate: true });
	return true;
}
