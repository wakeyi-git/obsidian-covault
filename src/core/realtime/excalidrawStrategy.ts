import { App, TFile } from "obsidian";
import * as Y from "yjs";
import { errMessage } from "../util/err";
import { t } from "../../i18n";
import { ExcalidrawBinding, ExcalidrawImperativeApi } from "./excalidrawBinding";
import { EditorBindingStrategy, ExcalidrawLikeView, Session, StrategyContext } from "./realtimeTypes";

const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

/**
 * Excalidraw 뷰의 imperative API 획득. 뷰 속성 → ExcalidrawAutomate 순으로 시도.
 * RealtimeManager(enforceReadOnly·diagnose)와 ExcalidrawStrategy가 공유한다.
 */
export function getExcalidrawApi(app: App, view: ExcalidrawLikeView): ExcalidrawImperativeApi | null {
	if (view.excalidrawAPI && typeof view.excalidrawAPI.onChange === "function") return view.excalidrawAPI;
	const plugin = (app as any).plugins?.plugins?.["obsidian-excalidraw-plugin"];
	const ea = plugin?.ea;
	try {
		const api = ea?.getAPI?.(view)?.getExcalidrawAPI?.();
		if (api && typeof api.onChange === "function") return api as ExcalidrawImperativeApi;
	} catch {
		/* EA 버전에 따라 미지원 */
	}
	return null;
}

/**
 * Excalidraw 요소 단위(Y.Array "elements" + Y.Map "assets") 실시간 바인딩 전략(평가 P2-3b).
 * imperative API에 바인딩하고, 종료 시 디스크에 저장된 그림을 CouchDB로 한 번 올려 비실시간 멤버에 전파한다.
 */
export class ExcalidrawStrategy implements EditorBindingStrategy {
	readonly kind = "excalidraw" as const;

	initSession(ydoc: Y.Doc): Partial<Session> {
		return { yElements: ydoc.getArray("elements"), yAssets: ydoc.getMap("assets") };
	}

	bind(session: Session, target: unknown, ctx: StrategyContext): boolean {
		const view = target as ExcalidrawLikeView;
		if (session.exBinding) return true; // 이미 바인딩됨
		if (!session.yElements || !session.yAssets) return true; // 구조 없음(있을 수 없음) — 재시도 무의미
		const api = getExcalidrawApi(ctx.app, view);
		// API가 아직 null = Excalidraw 뷰의 imperative API 마운트 지연(onSynced가 먼저 도는 경우).
		// false를 반환해 매니저가 짧게 재시도하게 한다(경고는 재시도 소진 후 1회 — 폭주 방지).
		if (!api) return false;
		const containerEl = (view as unknown as { contentEl?: HTMLElement; containerEl?: HTMLElement }).contentEl
			?? (view as unknown as { containerEl?: HTMLElement }).containerEl;
		// Excalidraw collaborator color는 {background, stroke} 객체를 기대(마크다운 yCollab는 문자열) → 여기서 객체로 재설정.
		const hex = COLORS[Math.abs(hash(ctx.settings.deviceId)) % COLORS.length];
		session.awareness.setLocalStateField("user", {
			name: ctx.settings.displayName || t("common.user"),
			color: { background: hex, stroke: hex },
		});
		try {
			session.exBinding = new ExcalidrawBinding(session.yElements, session.yAssets, api, {
				awareness: session.awareness,
				containerEl,
			});
			ctx.logger.ok(t("realtime.realtime_excalidraw_bound", { file: session.file }));
		} catch (e) {
			ctx.logger.error(t("realtime.realtime_binding_failed", { file: session.file, error: errMessage(e) }));
		}
		return true; // API를 얻어 바인딩을 시도함(성공/예외 모두) — 재시도 무의미.
	}

	unbind(session: Session): void {
		session.exBinding?.destroy();
	}

	async snapshot(session: Session, path: string, ctx: StrategyContext): Promise<void> {
		// Excalidraw 파일은 플러그인이 onChange 때 디스크에 저장한다. 세션 종료 후 그 파일을
		// CouchDB로 한 번 올려 비실시간 멤버에게 전파(서버는 excalidraw를 CouchDB 스냅샷하지 않는다).
		try {
			const file = ctx.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const content = await ctx.app.vault.read(file);
				if (content.length > 0) {
					const res = await ctx.getSyncForPath(path)?.snapshotNote(path, content);
					if (res === "uploaded" || res === "skipped-same") {
						ctx.logger.ok(t("realtime.realtime_snapshot_saved", { path }));
					} else if (res) {
						ctx.logger.warn(t("realtime.realtime_snapshot_not_saved_may_not", { reason: String(res), path }), true);
					}
				}
			}
		} catch (e) {
			ctx.logger.error(t("realtime.snapshot_save_failed", { path, error: errMessage(e) }));
		}
	}
}
