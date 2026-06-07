import { App, MarkdownView, TFile, View } from "obsidian";
import { errMessage } from "../util/err";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { EditorView } from "@codemirror/view";
import { CoreServices } from "../CoreServices";
import { bindView, unbindView } from "./editorBinding";
import { PresenceChips } from "./presenceChips";
import { clientColor } from "./clientColor";
import { getSecretValue, YJS_TOKEN_ID } from "../secret";
import { ExcalidrawBinding, ExcalidrawImperativeApi } from "./excalidrawBinding";
import { relUnder, roomName, pickSpace } from "./room";
import { t } from "../../i18n";

interface Session {
	file: string;
	kind: "md" | "excalidraw";
	ydoc: Y.Doc;
	ytext?: Y.Text; // md
	yElements?: Y.Array<Y.Map<any>>; // excalidraw 요소
	yAssets?: Y.Map<any>; // excalidraw 이미지 asset
	provider: WebsocketProvider;
	ready: boolean; // 서버 동기화 + 시드 완료 → 바인딩 가능
	bound: Set<EditorView>; // md: 바인딩된 CM6
	mdPresence?: Map<EditorView, PresenceChips>; // md: 뷰별 참가자 칩 오버레이
	exBinding?: ExcalidrawBinding; // excalidraw 바인딩
	snapTimer?: number; // 주기적 CouchDB 스냅샷 타이머(§19.2)
	lastSnapshot?: string; // 마지막으로 스냅샷한 내용(중복 쓰기 방지)
}

/** Excalidraw 뷰(타입 느슨). file과 imperative API 접근만 사용. */
interface ExcalidrawLikeView extends View {
	file?: TFile;
	excalidrawAPI?: ExcalidrawImperativeApi;
}

/** 실시간 스냅샷을 받을 대상(담당 MirrorSync). main이 경로로 해결해 준다. */
export interface SnapshotTarget {
	snapshotNote(localPath: string, content: string): Promise<unknown>;
}

const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

/**
 * Yjs 실시간 공동 편집 관리. 기술문서 §19. 공유 폴더의 markdown(글자 단위) + Excalidraw(요소 단위) 적용.
 *
 * 열린 에디터를 훑어 공유 파일이면 세션(WebSocket provider + Y.Doc)을 띄우고
 * markdown은 CM6(Y.Text), Excalidraw는 imperative API(Y.Map 요소)에 바인딩한다.
 * 파일이 모두 닫히면 세션을 종료하며 vault/CouchDB에 스냅샷을 저장(→ 비실시간 멤버에 영속).
 */
export class RealtimeManager {
	private sessions = new Map<string, Session>();
	/** 지원하지 않는 excalidraw 형식 경고를 경로당 1회만 내기 위한 집합. */
	private warnedUnsupportedExcalidraw = new Set<string>();

	constructor(
		private app: App,
		private core: CoreServices,
		/** 현재 사용자의 공유 공간 목록(교사=설정, 학생=shares). main이 주입. */
		private getSpaces: () => Array<{ id: string; folder: string; token?: string; kind?: "share" | "homeroom" | "mirror" }>,
		/** 로컬 경로 → 담당 동기화 링크(스냅샷 쓰기용). main이 현재 mode 기준으로 주입. */
		private getSyncForPath: (localPath: string) => SnapshotTarget | undefined = () => undefined,
	) {}

	private get settings() {
		return this.core.settings;
	}

	/** 실시간 세션 중인 파일인가 (applier 공존 판단용). */
	isActive(localPath: string): boolean {
		return this.sessions.has(localPath);
	}

	/** 해당 파일의 접속자 수(본인 포함). 세션 없으면 0. */
	presenceFor(localPath: string): number {
		const session = this.sessions.get(localPath);
		if (!session || !session.ready) return 0;
		try {
			return session.provider.awareness.getStates().size;
		} catch {
			return 0;
		}
	}

	/** 열린 markdown/excalidraw 에디터를 훑어 세션을 맞춘다. workspace 이벤트마다 호출. */
	syncOpenEditors(): void {
		const s = this.settings;
		// 토큰은 공간별(HMAC) 또는 전역(레거시) — startSession이 공간별로 확인하므로 여기선 서버 URL만 본다.
		const on = s.realtimeEnabled && !!s.yjsServerUrl;

		type Target = { kind: "md"; views: MarkdownView[] } | { kind: "excalidraw"; view: ExcalidrawLikeView };
		const targets = new Map<string, Target>();
		if (on) {
			// 공유 markdown 파일(excalidraw 파일은 제외 — 아래 excalidraw 처리가 담당)
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as MarkdownView;
				const file = view?.file;
				if (!file || file.extension !== "md" || this.isExcalidrawPath(file.path)) continue;
				if (!this.spaceFor(file.path)) continue;
				const cur = targets.get(file.path);
				if (cur && cur.kind === "md") cur.views.push(view);
				else targets.set(file.path, { kind: "md", views: [view] });
			}
			// 공유 excalidraw 그림 — .excalidraw.md만 지원(세션 종료 스냅샷이 markdown 업로드 경로를 타야 함).
			// 순수 .excalidraw는 비-markdown이라 스냅샷이 CouchDB에 저장되지 않으므로 실시간을 켜지 않는다.
			for (const leaf of this.app.workspace.getLeavesOfType("excalidraw")) {
				const view = leaf.view as ExcalidrawLikeView;
				const file = view?.file;
				if (!file || !this.spaceFor(file.path)) continue;
				if (!this.isSupportedExcalidraw(file.path)) {
					if (!this.warnedUnsupportedExcalidraw.has(file.path)) {
						this.warnedUnsupportedExcalidraw.add(file.path);
						this.core.logger.warn(
							t("realtime.realtime_unsupported_excalidraw_realtime_support", {
								path: file.path,
							}),
							true,
						);
					}
					continue;
				}
				targets.set(file.path, { kind: "excalidraw", view });
			}
		}

		// 더는 열려 있지 않은 세션 종료
		for (const path of [...this.sessions.keys()]) {
			if (!targets.has(path)) void this.endSession(path);
		}

		// 열린 공유 파일에 세션 보장 + 바인딩
		for (const [path, tgt] of targets) {
			let session = this.sessions.get(path);
			if (!session) session = this.startSession(path, tgt.kind);
			if (!session?.ready) continue;
			if (session.kind === "md" && tgt.kind === "md") this.bindViews(session, tgt.views);
			else if (session.kind === "excalidraw" && tgt.kind === "excalidraw") this.bindExcalidraw(session, tgt.view);
		}
	}

	private startSession(path: string, kind: "md" | "excalidraw"): Session | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return undefined;
		const space = this.spaceFor(path);
		if (!space) return undefined;

		const room = this.roomFor(path, space);
		if (!room) return undefined;
		const dbPath = this.relUnder(path, space.folder) ?? path;

		// 공간별 HMAC 토큰만 사용한다(room-scoped). 레거시 전역 토큰 폴백은 제거 —
		// 전역 토큰은 모든 room 접근을 허용해 공간 격리를 깨므로 더는 쓰지 않는다.
		const token = space.token;
		if (!token) return undefined; // 공간 토큰 없으면 이 공간 실시간 비활성(HMAC 시크릿 필요)

		const ydoc = new Y.Doc();
		const provider = new WebsocketProvider(this.settings.yjsServerUrl, room, ydoc, {
			params: { token },
		});

		// 커서·이름 색을 Excalidraw와 동일한 clientColor(clientId) 공식으로 통일(칩과도 일치).
		const color = clientColor(String(provider.awareness.clientID));
		provider.awareness.setLocalStateField("user", { name: this.settings.displayName || t("common.user"), color });

		const session: Session =
			kind === "md"
				? { file: path, kind, ydoc, ytext: ydoc.getText("content"), provider, ready: false, bound: new Set(), mdPresence: new Map() }
				: {
						file: path,
						kind,
						ydoc,
						yElements: ydoc.getArray("elements"),
						yAssets: ydoc.getMap("assets"),
						provider,
						ready: false,
						bound: new Set(),
					};
		this.sessions.set(path, session);

		provider.on("status", (e: { status: string }) => {
			if (e.status === "connected") this.core.logger.info(t("realtime.realtime_connected", { path: dbPath }));
		});
		provider.once("sync", (synced: boolean) => {
			if (!synced) return;
			// 잠깐 기다려 다른 접속자/서버 상태가 반영된 뒤 시드 판단(시드 충돌 방지)
			window.setTimeout(() => void this.onSynced(session, file), 400);
		});
		this.core.logger.info(t("realtime.realtime_session_started_room", { path: dbPath, room }));
		return session;
	}

	private async onSynced(session: Session, file: TFile): Promise<void> {
		// 이미 교체/종료된 세션이면(setTimeout 대기 중 endSession 발생) 무시 — 좀비 타이머/바인딩 방지.
		if (this.sessions.get(session.file) !== session) return;

		if (session.kind === "excalidraw") {
			// 시드는 바인딩(ExcalidrawBinding)이 첫 진입자일 때 처리한다.
			session.ready = true;
			this.syncOpenEditors();
			return;
		}

		try {
			if (session.ytext && session.ytext.length === 0) {
				// 단일 시드: 나 혼자일 때만 파일 내용으로 시드. 다른 참여자가 있으면 그들의 공유 내용을 받는다.
				// (여러 명이 서로 다른 파일 내용을 시드하면 문서가 뒤섞여 깨진다.)
				const others = session.provider.awareness.getStates().size; // 본인 포함
				if (others <= 1) {
					const content = await this.app.vault.read(file);
					if (content.length > 0) {
						session.ytext.insert(0, content);
						this.core.logger.info(t("realtime.realtime_seed_first_join", { file: session.file }));
					}
				} else {
					this.core.logger.info(
						t("realtime.realtime_other_participants_present_skipping_see", { file: session.file }),
					);
				}
			}
		} catch {
			/* 읽기 실패 무시 */
		}
		session.ready = true;
		session.lastSnapshot = session.ytext?.toString() ?? "";
		this.maybeStartSnapshot(session);
		this.syncOpenEditors(); // 이제 바인딩
	}

	/** 주기적 CouchDB 스냅샷 타이머 시작(§19.2). snapshotSec>0일 때만. */
	private maybeStartSnapshot(session: Session): void {
		const sec = this.settings.realtimeSnapshotSec;
		if (!sec || sec <= 0 || session.snapTimer != null) return;
		session.snapTimer = window.setInterval(() => void this.snapshotTick(session), Math.max(5, sec) * 1000);
		this.core.logger.info(t("realtime.realtime_periodic_snapshot_enabled_s", { file: session.file, sec }));
	}

	private async snapshotTick(session: Session): Promise<void> {
		try {
			if (!session.ready || !session.ytext || !this.isSnapshotLeader(session)) return;
			const content = session.ytext.toString();
			if (content === session.lastSnapshot || content.length === 0) return; // 변화 없음/빈 내용 방지
			const target = this.getSyncForPath(session.file);
			if (!target) return;
			const res = await target.snapshotNote(session.file, content);
			session.lastSnapshot = content;
			this.core.logger.info(t("realtime.periodic_snapshot_to_couchdb", { file: session.file, res: String(res) }));
		} catch (e) {
			this.core.logger.warn(
				t("realtime.periodic_snapshot_failed", {
					file: session.file,
					error: errMessage(e),
				}),
			);
		}
	}

	/** 단일 작성자 선출: 내 clientID가 현재 awareness 최소면 내가 쓴다(동시 작성 → 충돌 방지). */
	private isSnapshotLeader(session: Session): boolean {
		try {
			const states = session.provider.awareness.getStates();
			const myId = session.provider.awareness.clientID;
			let min = myId;
			for (const id of states.keys()) if (id < min) min = id;
			return myId === min;
		} catch {
			return false;
		}
	}

	/** 실시간 상태 점검(명령). 왜 세션이 안 뜨는지 진단용. */
	diagnose(): void {
		const s = this.settings;
		const log = this.core.logger;
		const spaces = this.getSpaces();
		const withToken = spaces.filter((x) => x.token).length;
		log.info(
			t("realtime.realtime_check_enabled_url_globaltoken_spacetoke", {
				enabled: String(s.realtimeEnabled),
				url: s.yjsServerUrl ? t("common.set") : t("common.none"),
				legacy: getSecretValue(this.app, YJS_TOKEN_ID, s.yjsToken) ? t("common.set") : t("common.none"),
				spaceTokens: `${withToken}/${spaces.length}`,
			}),
			true,
		);
		log.info(
			t("realtime.shared_folders", {
				folders: this.getSpaces().map((x) => x.folder).join(", ") || t("common.none_2"),
			}),
		);
		const f = this.app.workspace.getActiveFile();
		const space = f ? this.spaceFor(f.path) : null;
		log.info(
			t("realtime.active_file_shared_space_spacetoken", {
				file: f?.path ?? t("common.none_2"),
				space: f ? (space?.id ?? t("realtime.no_outside_shared_folder")) : "-",
				spaceToken: space
					? space.token
						? t("common.set")
						: getSecretValue(this.app, YJS_TOKEN_ID, s.yjsToken)
							? t("realtime.using_global")
							: t("common.none")
					: "-",
			}),
		);
		// room 이름(교사·학생이 정확히 같아야 실시간 공유됨)
		const room = f && space ? this.roomFor(f.path, space) : null;
		log.info(t("realtime.room_manager_and_members_must_have", { room: room ?? t("common.none_2") }));
		const session = f ? this.sessions.get(f.path) : undefined;
		log.info(
			t("realtime.session_connected_participants", {
				state: session ? (session.ready ? t("realtime.ready") : t("realtime.connecting")) : t("common.none"),
				connected: session ? String((session.provider as any).wsconnected) : "-",
				presence: f ? this.presenceFor(f.path) : 0,
			}),
		);
		// 에디터 유형별 접근 점검: Excalidraw 파일이면 Excalidraw API, 아니면 CM6.
		if (f && this.isExcalidrawPath(f.path)) {
			const plugin = (this.app as any).plugins?.plugins?.["obsidian-excalidraw-plugin"];
			const exView = this.app.workspace
				.getLeavesOfType("excalidraw")
				.map((l) => l.view as ExcalidrawLikeView)
				.find((v) => v?.file?.path === f.path);
			const api = exView ? this.getExcalidrawApi(exView) : null;
			log.info(
				t("realtime.excalidraw_plugin_api_bound", {
					plugin: plugin ? t("realtime.installed") : t("realtime.not_installed"),
					api: api ? t("realtime.yes") : t("realtime.no"),
					bound: session?.exBinding ? t("realtime.yes_2") : t("realtime.no_2"),
				}),
			);
		} else {
			const md = this.app.workspace.getActiveViewOfType(MarkdownView);
			const cm = md ? (md.editor as unknown as { cm?: EditorView }).cm : undefined;
			log.info(
				t("realtime.active_editor_cm6_access", {
					access: cm ? t("realtime.available_edit_mode") : t("realtime.unavailable_open_in_edit_mode_if"),
				}),
			);
		}
	}

	private bindViews(session: Session, views: MarkdownView[]): void {
		const ytext = session.ytext;
		if (!ytext) return;
		for (const view of views) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!cm) {
				this.core.logger.warn(
					t("realtime.realtime_editor_cm6_not_accessible_open", { file: session.file }),
				);
				continue;
			}
			if (session.bound.has(cm)) continue;
			try {
				bindView(cm, ytext, session.provider.awareness);
				session.bound.add(cm);
				// 뷰 우하단에 참가자 칩(Excalidraw와 동일) — 포인터 없이도 편집자 이름 상시 표시.
				const host = (view as unknown as { contentEl?: HTMLElement }).contentEl;
				if (host && session.mdPresence && !session.mdPresence.has(cm)) {
					session.mdPresence.set(cm, new PresenceChips(host, session.provider.awareness));
				}
			} catch (e) {
				this.core.logger.error(
					t("realtime.realtime_binding_failed", {
						file: session.file,
						error: errMessage(e),
					}),
				);
			}
		}
	}

	/** Excalidraw 그림에 Yjs 바인딩(1회). 첫 진입자(awareness≤1 & 비어있음)면 현재 씬을 시드. */
	private bindExcalidraw(session: Session, view: ExcalidrawLikeView): void {
		if (session.exBinding || !session.yElements || !session.yAssets) return;
		const api = this.getExcalidrawApi(view);
		if (!api) {
			this.core.logger.warn(
				t("realtime.realtime_cannot_access_excalidraw_api_check", { file: session.file }),
			);
			return;
		}
		const containerEl = (view as unknown as { contentEl?: HTMLElement; containerEl?: HTMLElement }).contentEl
			?? (view as unknown as { containerEl?: HTMLElement }).containerEl;
		// Excalidraw collaborator color는 {background, stroke} 객체를 기대(마크다운 yCollab는 문자열) → 여기서 객체로 재설정.
		const hex = COLORS[Math.abs(hash(this.settings.deviceId)) % COLORS.length];
		session.provider.awareness.setLocalStateField("user", {
			name: this.settings.displayName || t("common.user"),
			color: { background: hex, stroke: hex },
		});
		try {
			session.exBinding = new ExcalidrawBinding(session.yElements, session.yAssets, api, {
				awareness: session.provider.awareness,
				containerEl,
			});
			this.core.logger.ok(t("realtime.realtime_excalidraw_bound", { file: session.file }));
		} catch (e) {
			this.core.logger.error(
				t("realtime.realtime_binding_failed", {
					file: session.file,
					error: errMessage(e),
				}),
			);
		}
	}

	/** excalidraw 파일 경로 여부(.excalidraw 또는 .excalidraw.md). markdown 처리에서 제외용. */
	private isExcalidrawPath(p: string): boolean {
		const lower = p.toLowerCase();
		return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md");
	}

	/** 실시간 지원 excalidraw 형식(.excalidraw.md만). 스냅샷이 markdown 업로드 경로를 타야 전파된다. */
	private isSupportedExcalidraw(p: string): boolean {
		return p.toLowerCase().endsWith(".excalidraw.md");
	}

	/** Excalidraw 뷰의 imperative API 획득. 뷰 속성 → ExcalidrawAutomate 순으로 시도. */
	private getExcalidrawApi(view: ExcalidrawLikeView): ExcalidrawImperativeApi | null {
		if (view.excalidrawAPI && typeof view.excalidrawAPI.onChange === "function") return view.excalidrawAPI;
		const plugin = (this.app as any).plugins?.plugins?.["obsidian-excalidraw-plugin"];
		const ea = plugin?.ea;
		try {
			const api = ea?.getAPI?.(view)?.getExcalidrawAPI?.();
			if (api && typeof api.onChange === "function") return api as ExcalidrawImperativeApi;
		} catch {
			/* EA 버전에 따라 미지원 */
		}
		return null;
	}

	private async endSession(path: string): Promise<void> {
		const session = this.sessions.get(path);
		if (!session) return;
		this.sessions.delete(path);

		if (session.snapTimer != null) window.clearInterval(session.snapTimer);

		// 내 awareness를 명시적으로 제거(null) → 모든 피어가 즉시 커서/이름을 지운다.
		// (provider.destroy()는 소켓만 닫아 서버 정리에 의존 → 서버가 정리 안 하면 유령 커서가 남음.)
		try {
			session.provider.awareness.setLocalState(null);
		} catch {
			/* noop */
		}

		// 바인딩 해제
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
		session.exBinding?.destroy();

		if (session.kind === "excalidraw") {
			// Excalidraw 파일은 플러그인이 onChange 때 디스크에 저장한다. 세션 종료 후 그 파일을
			// CouchDB로 한 번 올려 비실시간 멤버에게 전파(세션 중엔 isRealtimeActive로 업로드 보류됨).
			try {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					const content = await this.app.vault.read(file);
					if (content.length > 0) {
						const res = await this.getSyncForPath(path)?.snapshotNote(path, content);
						if (res === "uploaded" || res === "skipped-same") {
							this.core.logger.ok(t("realtime.realtime_snapshot_saved", { path }));
						} else if (res) {
							this.core.logger.warn(
								t("realtime.realtime_snapshot_not_saved_may_not", {
									reason: String(res),
									path,
								}),
								true,
							);
						}
					}
				}
			} catch (e) {
				this.core.logger.error(
					t("realtime.snapshot_save_failed", { path, error: errMessage(e) }),
				);
			}
		} else {
			// 스냅샷 영속: Y.Text → vault(변경 시) + CouchDB에 직접 업로드.
			// 실시간 중에는 LocalWatcher가 업로드를 보류하므로(Obsidian 자동저장 포함), Excalidraw와 동일하게
			// 종료 시 명시적으로 올린다. Obsidian 자동저장으로 vault가 이미 최신이면 vault 쓰기는 생략되지만,
			// CouchDB는 세션 중 갱신되지 않았으므로 반드시 업로드해야 비실시간 멤버가 최신본을 받는다.
			try {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					const content = session.ytext?.toString() ?? "";
					const current = await this.app.vault.read(file);
					// 안전장치: 빈 내용으로 기존 내용을 덮어쓰지 않음(데이터 손실 방지)
					if (content.length === 0 && current.length > 0) {
						this.core.logger.warn(t("realtime.skipping_realtime_snapshot_preventing_overwrite", { path }));
					} else {
						if (content !== current) {
							await this.app.vault.process(file, () => content); // 백그라운드 쓰기: 가이드라인 권장
						}
						const res = await this.getSyncForPath(path)?.snapshotNote(path, content);
						if (res === "uploaded" || res === "skipped-same") {
							this.core.logger.ok(t("realtime.realtime_snapshot_saved", { path }));
						} else if (res) {
							this.core.logger.warn(
								t("realtime.realtime_snapshot_not_saved_may_not", {
									reason: String(res),
									path,
								}),
								true,
							);
						}
					}
				}
			} catch (e) {
				this.core.logger.error(
					t("realtime.snapshot_save_failed", { path, error: errMessage(e) }),
				);
			}
		}

		session.provider.destroy();
		session.ydoc.destroy();
	}

	/** folder 기준 상대경로(dbPath). 순수 로직은 room.ts. */
	private relUnder(localPath: string, folder: string): string | null {
		return relUnder(localPath, folder);
	}

	/** 파일의 room 이름(모든 멤버가 동일해야 함). mirror 공간도 spaceId(mirror-<id>)로 같은 share 네임스페이스를 쓴다. */
	private roomFor(localPath: string, space: { id: string; folder: string }): string | null {
		return roomName(this.settings.workspaceId, space.id, localPath, space.folder);
	}

	/**
	 * 파일 경로가 속한 공간(있으면). 보관/충돌/제외 폴더 아래 파일은 실시간 대상이 아니다.
	 * 겹치면 가장 구체적인(folder가 가장 긴) 공간을 택한다 — mirror(folder="")가 하위 공유 폴더를 가리지 않게.
	 */
	private spaceFor(localPath: string): { id: string; folder: string; token?: string } | null {
		return pickSpace(this.getSpaces(), localPath, (folder) => this.isExcludedFromRealtime(localPath, folder));
	}

	/**
	 * 보관(_삭제됨)·충돌(_충돌)·제외 폴더 아래 파일인지(실시간 제외).
	 * 보관본이 별도 room으로 실시간 세션을 띄워 협업이 갈라지는 것을 막는다([MirrorContext.isExcluded]와 동일 규칙).
	 */
	private isExcludedFromRealtime(localPath: string, folder: string): boolean {
		const s = this.settings;
		const rel = this.relUnder(localPath, folder);
		if (rel === null) return false;
		const under = (base: string): boolean => !!base && (rel === base || rel.startsWith(base + "/"));
		if (under(s.archiveFolder) || under(s.conflictFolder)) return true;
		for (const f of s.excludeFolders) {
			const ff = f.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
			if (ff && (localPath === ff || localPath.startsWith(ff + "/"))) return true;
		}
		return false;
	}

	/**
	 * 모든 세션을 깨끗이 종료(awareness 제거)한 뒤 다시 맞춘다.
	 * 설정 적용/공유 공간 재배포로 mode가 재시작될 때 호출 → 유령(이전 위치) 커서가 남지 않게 한다.
	 */
	async refresh(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
		this.syncOpenEditors();
	}

	async dispose(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
	}
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}
