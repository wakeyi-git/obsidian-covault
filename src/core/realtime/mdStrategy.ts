import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { EditorView } from "@codemirror/view";
import { errMessage } from "../util/err";
import { t } from "../../i18n";
import { bindView, unbindView, isViewBound } from "./editorBinding";
import { PresenceChips } from "./presenceChips";
import { EditorBindingStrategy, Session, StrategyContext } from "./realtimeTypes";

/**
 * 바인딩 직전 로컬 편집을 버전 히스토리로 보존해야 하는가(순수 — 평가 R-A).
 * 원격 Y.Text와 로컬 에디터 내용이 둘 다 비어있지 않고 서로 다르면, 교체 전 보존 대상이다.
 * (둘 중 하나라도 비면 손실 위험 없음 — 빈 쪽은 교체해도 잃을 게 없다.)
 */
export function shouldPreserveLocalEdit(yContent: string, localContent: string): boolean {
	return yContent.length > 0 && localContent.length > 0 && yContent !== localContent;
}

/**
 * Markdown 글자 단위(Y.Text "content") 실시간 바인딩 전략(평가 P2-3b — RealtimeManager에서 추출).
 * CM6 에디터에 yCollab 바인딩 + 참가자 칩 오버레이, 종료 시 Y.Text를 vault·CouchDB로 영속한다.
 */
export class MarkdownStrategy implements EditorBindingStrategy {
	readonly kind = "md" as const;

	initSession(ydoc: Y.Doc): Partial<Session> {
		// Y.Text 키 "content"는 서버(server/hocuspocus/server.js)의 시드/스냅샷 키와 일치해야 한다.
		const ytext = ydoc.getText("content");
		// 세션당 하나의 UndoManager — Ctrl+Z가 Obsidian 내장 히스토리 대신 이걸 타야
		// 원격 참가자의 입력을 되돌리지 않는다(로컬 origin만 추적, bindView의 키맵과 한 쌍).
		return { ytext, yundo: new Y.UndoManager(ytext), mdPresence: new Map() };
	}

	bind(session: Session, target: unknown, ctx: StrategyContext): boolean {
		const views = target as MarkdownView[];
		const ytext = session.ytext;
		const yundo = session.yundo;
		if (!ytext || !yundo) return true;
		for (const view of views) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!cm) {
				ctx.logger.warn(t("realtime.realtime_editor_cm6_not_accessible_open", { file: session.file }));
				continue;
			}
			if (session.bound.has(cm) && isViewBound(cm)) continue; // bound여도 실측 — state 재생성으로 사라졌으면 재바인딩(R-D)
			try {
				// 바인딩이 에디터 내용을 Y.Text로 교체하기 전에, 아직 업로드되지 않은 로컬 편집을
				// 버전 히스토리로 보존한다(평가 R-A). 오프라인 편집 직후 온라인 복귀로 세션에
				// 진입하면 vault에만 있는 편집이 유일본인데, 교체 후엔 업로드도 차단되고 종료
				// 스냅샷이 Y.Text 기준으로 덮으므로 여기서 보존하지 않으면 흔적 없이 사라진다.
				const localContent = cm.state.doc.toString();
				const yContent = ytext.toString();
				if (shouldPreserveLocalEdit(yContent, localContent)) {
					void ctx.getSyncForPath(session.file)
						?.preserveLocalEdit(session.file, localContent)
						.then(() => ctx.logger.info(t("realtime.local_edit_preserved_history", { path: session.file }), true))
						.catch(() => {});
				}
				bindView(cm, ytext, session.awareness, yundo);
				session.bound.add(cm);
				// 뷰 우하단에 참가자 칩(Excalidraw와 동일) — 포인터 없이도 편집자 이름 상시 표시.
				const host = (view as unknown as { contentEl?: HTMLElement }).contentEl;
				if (host && session.mdPresence && !session.mdPresence.has(cm)) {
					session.mdPresence.set(cm, new PresenceChips(host, session.awareness));
				}
			} catch (e) {
				ctx.logger.error(t("realtime.realtime_binding_failed", { file: session.file, error: errMessage(e) }));
			}
		}
		return true; // md는 CM6 접근이 동기적이라 재시도 불필요(에디터 모드 전환은 워크스페이스 이벤트가 처리).
	}

	unbind(session: Session): void {
		for (const cm of session.bound) {
			try {
				unbindView(cm);
			} catch {
				/* 뷰가 이미 사라졌을 수 있음 */
			}
		}
		if (session.mdPresence) {
			for (const chips of session.mdPresence.values()) chips.destroy();
			session.mdPresence.clear();
		}
		session.yundo?.destroy();
	}

	async snapshot(session: Session, path: string, ctx: StrategyContext): Promise<void> {
		// 다른 참가자가 남아 있으면 종료 영속을 통째로 생략한다 — 세션은 계속되고 지금 쓰는 내용은 곧
		// 낡는다. 특히 vault에 쓰면 세션 해제 직후라 LocalWatcher가 정상 채널로 업로드해 서버의 진행 중
		// 스냅샷과 rev 경쟁(충돌 버전 노이즈)을 만든다. 내 vault는 서버 스냅샷이 복제로 도착하면 수렴하고,
		// 마지막 참가자의 종료 스냅샷이 최종 보장이다. (excalidraw는 서버가 저장하지 않으므로 전략이 다르다.)
		const aw = session.awareness;
		let others = 0;
		aw.getStates().forEach((_state, clientId: number) => {
			if (clientId !== aw.clientID) others++;
		});
		if (others > 0) {
			ctx.logger.info(t("realtime.snapshot_skipped_active_peers", { count: String(others), path }));
			return;
		}
		// 종료 영속: Y.Text → vault(변경 시) + CouchDB 업로드.
		// 서버(onStoreDocument)가 세션 중에도 CouchDB 스냅샷을 저장하지만, vault 파일은 서버가 쓸 수 없고
		// 서버가 CouchDB 미연동(폴백 모드)일 수도 있으므로 종료 시 클라이언트가 한 번 더 보장한다
		// (서버가 이미 같은 내용을 저장했으면 contentHash 동일 → skipped-same).
		try {
			const file = ctx.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const content = session.ytext?.toString() ?? "";
				const current = await ctx.app.vault.read(file);
				// 안전장치: 빈 내용으로 기존 내용을 덮어쓰지 않음(데이터 손실 방지)
				if (content.length === 0 && current.length > 0) {
					ctx.logger.warn(t("realtime.skipping_realtime_snapshot_preventing_overwrite", { path }));
				} else {
					if (content !== current) {
						await ctx.app.vault.process(file, () => content); // 백그라운드 쓰기: 가이드라인 권장
					}
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
