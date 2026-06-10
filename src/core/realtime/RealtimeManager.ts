import { App, MarkdownView, TFile, View } from "obsidian";
import { errMessage } from "../util/err";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Awareness } from "y-protocols/awareness";
import { EditorView } from "@codemirror/view";
import { CoreServices } from "../CoreServices";
import { bindView, unbindView, setEditorReadOnly } from "./editorBinding";
import { PresenceChips } from "./presenceChips";
import { clientColor } from "./clientColor";
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
	provider: HocuspocusProvider;
	/** 직접 생성해 provider에 주입한 awareness — provider.awareness의 null 타입을 피하고 바인딩에 그대로 쓴다. */
	awareness: Awareness;
	ready: boolean; // 서버 동기화 완료(시드는 서버 onLoadDocument 담당) → 바인딩 가능
	bound: Set<EditorView>; // md: 바인딩된 CM6
	mdPresence?: Map<EditorView, PresenceChips>; // md: 뷰별 참가자 칩 오버레이
	exBinding?: ExcalidrawBinding; // excalidraw 바인딩
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
 * Yjs 실시간 공동 편집 관리(Hocuspocus). 기술문서 §19. 공유 폴더의 markdown(글자 단위) + Excalidraw(요소 단위) 적용.
 *
 * 열린 에디터를 훑어 공유 파일이면 세션(HocuspocusProvider + Y.Doc)을 띄우고
 * markdown은 CM6(Y.Text), Excalidraw는 imperative API(Y.Map 요소)에 바인딩한다.
 * 모든 세션은 **WebSocket 연결 하나**를 공유한다(HocuspocusProviderWebsocket 멀티플렉싱).
 * 문서 시드·주기 스냅샷은 서버(onLoadDocument/onStoreDocument)가 담당하고, 세션 종료 시
 * vault 쓰기 + CouchDB 업로드(서버 미연동 환경 폴백)만 클라이언트가 수행한다.
 */
export class RealtimeManager {
	private sessions = new Map<string, Session>();
	/** 공유 WebSocket(모든 문서 멀티플렉싱). 첫 세션에서 생성, 마지막 세션 종료 시 닫는다. */
	private socket: HocuspocusProviderWebsocket | null = null;
	/** 지원하지 않는 excalidraw 형식 경고를 경로당 1회만 내기 위한 집합. */
	private warnedUnsupportedExcalidraw = new Set<string>();

	constructor(
		private app: App,
		private core: CoreServices,
		/** 현재 사용자의 공유 공간 목록(교사=설정, 학생=shares). main이 주입. */
		private getSpaces: () => Array<{ id: string; folder: string; token?: string; kind?: "share" | "homeroom" | "mirror" }>,
		/** 로컬 경로 → 담당 동기화 링크(스냅샷 쓰기용). main이 현재 mode 기준으로 주입. */
		private getSyncForPath: (localPath: string) => SnapshotTarget | undefined = () => undefined,
		/** 이 파일의 라이브 세션에 참여 가능한가(파일별 참여자 게이팅). main이 주입(기본 전원 허용). */
		private canEditRealtime: (localPath: string) => Promise<boolean> = async () => true,
	) {}

	// 파일별 참여 허용 캐시(비동기 조회 결과). 파일이 닫히면 비워 재오픈 시 재평가.
	private participantOk = new Map<string, boolean>();
	private participantPending = new Set<string>();
	// 서버 거부(인증 실패·재인가 종료) 재시도 백오프(2s→60s 지수). 동기화 성공 시 해제.
	// 서버가 지속 거부(예: CouchDB 미연동으로 시드 실패)할 때 즉시 재접속 루프 + 알림 폭주를 막는다.
	private retryState = new Map<string, { failures: number; until: number }>();
	// CoVault가 읽기 전용으로 잠근 에디터/그림(정책 해제 시 우리가 잠근 것만 푼다 — 타 플러그인 보호).
	private lockedViews = new WeakSet<EditorView>();
	private lockedExcalidraw = new WeakSet<ExcalidrawLikeView>();

	private get settings() {
		return this.core.settings;
	}

	/**
	 * 공유 WebSocket 획득(lazy). 빈 소켓(연결된 문서 0개)은 서버 메시지가 없어 재연결 루프를 돌고
	 * 유휴 연결을 낭비하므로, 마지막 세션이 끝나면 endSession이 닫는다(yjsServerUrl 변경도 그때 반영).
	 */
	private getSocket(): HocuspocusProviderWebsocket {
		if (!this.socket) this.socket = new HocuspocusProviderWebsocket({ url: this.settings.yjsServerUrl });
		return this.socket;
	}

	/** 마지막 세션 종료 후 공유 소켓 정리. */
	private teardownSocketIfIdle(): void {
		if (this.sessions.size === 0 && this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}

	/** 파일별 참여자 변경 시 재평가(교사 지정 후, 또는 수신 후). */
	invalidateParticipants(path?: string): void {
		if (path) {
			this.participantOk.delete(path);
			this.participantPending.delete(path);
		} else {
			this.participantOk.clear();
			this.participantPending.clear();
		}
		this.syncOpenEditors();
	}

	/** 캐시 기반 동기 게이트. 미확인이면 비동기 조회를 띄우고 일단 false(조회 끝나면 재호출). */
	private allowedToStart(path: string): boolean {
		const cached = this.participantOk.get(path);
		if (cached !== undefined) return cached;
		if (!this.participantPending.has(path)) {
			this.participantPending.add(path);
			void this.canEditRealtime(path)
				.then((ok) => {
					this.participantPending.delete(path);
					this.participantOk.set(path, ok);
					this.syncOpenEditors();
				})
				.catch(() => {
					this.participantPending.delete(path);
					this.participantOk.set(path, true);
					this.syncOpenEditors();
				});
		}
		return false;
	}

	/** 실시간 세션 중인 파일인가 (applier 공존 판단용). */
	isActive(localPath: string): boolean {
		return this.sessions.has(localPath);
	}

	/** 현재(이 기기) 활성 실시간 세션 목록 — 파일 경로 + 접속자 수. 패널 관리용. */
	activeSessions(): Array<{ path: string; participants: number }> {
		return [...this.sessions.keys()].map((p) => ({ path: p, participants: this.presenceFor(p) }));
	}

	/** 해당 파일의 접속자 수(본인 포함). 세션 없으면 0. */
	presenceFor(localPath: string): number {
		const session = this.sessions.get(localPath);
		if (!session || !session.ready) return 0;
		try {
			return session.awareness.getStates().size;
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
		// 닫힌 파일의 참여 캐시 정리(재오픈 시 최신 지정 반영).
		for (const p of [...this.participantOk.keys()]) if (!targets.has(p)) this.participantOk.delete(p);

		// 공유 파일 읽기 전용 정책 적용(구성원). 세션 활성 파일만 편집 가능.
		this.enforceReadOnly();

		// 열린 공유 파일에 세션 보장 + 바인딩
		let degated = false;
		for (const [path, tgt] of targets) {
			let session = this.sessions.get(path);
			if (session) {
				// 이미 열린 세션: 참여 취소가 '확정'되면(캐시=false) 종료해 즉시 편집을 막는다.
				// 보류(undefined) 중엔 유지해 재평가 깜빡임을 막고, 재평가만 트리거한다.
				const cached = this.participantOk.get(path);
				if (cached === false) {
					void this.endSession(path);
					degated = true;
					continue;
				}
				if (cached === undefined) this.allowedToStart(path);
			} else {
				if (!this.allowedToStart(path)) continue; // 파일별 참여자에 없으면 라이브 미접속(파일 동기화만)
				const st = this.retryState.get(path);
				if (st && Date.now() < st.until) continue; // 서버 거부 백오프 중 — noteServerRefusal의 타이머가 재평가한다
				session = this.startSession(path, tgt.kind);
			}
			if (!session?.ready) continue;
			if (session.kind === "md" && tgt.kind === "md") this.bindViews(session, tgt.views);
			else if (session.kind === "excalidraw" && tgt.kind === "excalidraw") this.bindExcalidraw(session, tgt.view);
		}
		// 세션을 종료한 경우(참여 취소), 그 파일을 읽기 전용 정책에 맞게 즉시 잠근다.
		if (degated) this.enforceReadOnly();
	}

	/**
	 * 공유 파일 읽기 전용 정책(구성원): sharedReadOnly가 켜져 있으면 공유 공간의 markdown 파일을 읽기 전용으로
	 * 잠그고, 그 파일에 실시간 세션이 활성일 때만 편집 가능하게 한다. 우리가 잠근 에디터만 추적해 해제한다.
	 */
	private enforceReadOnly(): void {
		const s = this.settings;
		const policy = s.role === "member" && !!s.sharedReadOnly;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view as MarkdownView;
			const file = view?.file;
			if (!file) continue;
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!cm) continue;
			const desired =
				policy && file.extension === "md" && !this.isExcalidrawPath(file.path) && !!this.spaceFor(file.path) && !this.isActive(file.path);
			if (desired) {
				setEditorReadOnly(cm, true);
				this.lockedViews.add(cm);
			} else if (this.lockedViews.has(cm)) {
				setEditorReadOnly(cm, false);
				this.lockedViews.delete(cm);
			}
		}
		// Excalidraw 그림 — viewModeEnabled로 잠금/해제.
		for (const leaf of this.app.workspace.getLeavesOfType("excalidraw")) {
			const view = leaf.view as ExcalidrawLikeView;
			const file = view?.file;
			if (!file) continue;
			const api = this.getExcalidrawApi(view);
			if (!api) continue;
			const desired = policy && this.isSupportedExcalidraw(file.path) && !!this.spaceFor(file.path) && !this.isActive(file.path);
			const cur = !!api.getAppState?.()?.viewModeEnabled;
			if (desired && !cur) {
				try {
					api.updateScene({ appState: { viewModeEnabled: true } });
				} catch {
					/* API 형태가 다를 수 있음 */
				}
				this.lockedExcalidraw.add(view);
			} else if (!desired && this.lockedExcalidraw.has(view)) {
				try {
					api.updateScene({ appState: { viewModeEnabled: false } });
				} catch {
					/* noop */
				}
				this.lockedExcalidraw.delete(view);
			}
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

		// 공간별 HMAC 토큰만 사용한다(room-scoped, 멤버별 m/r 클레임 포함). 서버가 파일 단위 인가를 강제한다.
		const token = space.token;
		if (!token) return undefined; // 공간 토큰 없으면 이 공간 실시간 비활성(HMAC 시크릿 필요)

		const ydoc = new Y.Doc();
		// awareness는 직접 생성해 주입한다 — provider.awareness가 null일 수 있는 타입을 피하고,
		// y-codemirror.next / y-excalidraw / PresenceChips에 그대로 넘긴다.
		const awareness = new Awareness(ydoc);
		// 'synced'는 재연결마다 재발화하므로 1회 가드(기존 once("sync") 의미 유지).
		let syncedOnce = false;
		const provider = new HocuspocusProvider({
			websocketProvider: this.getSocket(),
			name: room,
			document: ydoc,
			awareness,
			// 토큰은 연결 후 인증 메시지로 전달된다(URL 쿼리 아님) → 리버스 프록시 로그에 남지 않는다.
			token,
			onAuthenticated: () => {
				this.core.logger.info(t("realtime.realtime_connected", { path: dbPath }));
			},
			onAuthenticationFailed: ({ reason }) => {
				// 시크릿 불일치/토큰 만료/참가자 제외(서버 강퇴 후 재인가 거부) — 백오프 후 재평가한다.
				this.noteServerRefusal(path, dbPath, String(reason ?? ""), false);
			},
			onClose: ({ event }) => {
				// 서버 종료 신호: 참가자(rtpart)/정책(rtcontrol) 변경 재인가 또는 서버측 오류(시드 실패 등)로
				// 문서 연결을 닫는다(reason="Reset Connection"). 백오프 후 재평가 — 여전히 허용이면 다시 연결된다.
				// 참여자 지정/해제 때마다 일어나는 **정상 흐름**이므로 조용히(로그만) 처리한다 — 진짜 거부면
				// 재접속 시 onAuthenticationFailed가 알림을 띄운다. 일반 네트워크 끊김은 소켓이 자동 복구한다.
				if (event?.reason !== "Reset Connection") return;
				this.noteServerRefusal(path, dbPath, "server reset (re-auth)", true);
			},
			onSynced: () => {
				if (syncedOnce) return;
				syncedOnce = true;
				this.onSynced(session);
			},
		});
		// 외부 websocketProvider를 주입하면 provider가 소켓에 자동 attach하지 않는다(v4) → 명시 호출 필수.
		provider.attach();

		// 커서·이름 색을 Excalidraw와 동일한 clientColor(clientId) 공식으로 통일(칩과도 일치).
		const color = clientColor(String(awareness.clientID));
		awareness.setLocalStateField("user", { name: this.settings.displayName || t("common.user"), color });

		const session: Session =
			kind === "md"
				? // Y.Text 키 "content"는 서버(server/hocuspocus/server.js)의 시드/스냅샷 키와 일치해야 한다.
					{ file: path, kind, ydoc, ytext: ydoc.getText("content"), provider, awareness, ready: false, bound: new Set(), mdPresence: new Map() }
				: {
						file: path,
						kind,
						ydoc,
						yElements: ydoc.getArray("elements"),
						yAssets: ydoc.getMap("assets"),
						provider,
						awareness,
						ready: false,
						bound: new Set(),
					};
		this.sessions.set(path, session);
		this.core.logger.info(t("realtime.realtime_session_started_room", { path: dbPath, room }));
		return session;
	}

	private onSynced(session: Session): void {
		// 이미 교체/종료된 세션이면 무시 — 좀비 바인딩 방지.
		if (this.sessions.get(session.file) !== session) return;
		this.retryState.delete(session.file); // 정상 동기화 → 거부 백오프 해제
		// 문서 시드는 서버(onLoadDocument)가 CouchDB note 문서로 수행한다 — 클라이언트 시드 없음
		// (여러 클라이언트가 서로 다른 내용을 시드해 문서가 섞이는 문제가 원천 제거됨).
		session.ready = true;
		this.syncOpenEditors(); // 이제 바인딩
	}

	/**
	 * 서버가 이 문서의 연결을 거부/종료했을 때: 세션을 정리하고 지수 백오프(2s→최대 60s) 후 재평가한다.
	 * silent=true(정상 재인가 — 참여자 지정/해제로 서버가 연결을 재설정)는 로그만 남기고,
	 * 진짜 인증 거부는 첫 실패만 알림(Notice) — 지속 거부 시 알림 폭주로 설정 변경조차 못 하게 되는 것을 막는다.
	 */
	private noteServerRefusal(path: string, dbPath: string, reason: string, silent: boolean): void {
		const st = this.retryState.get(path) ?? { failures: 0, until: 0 };
		st.failures++;
		const delay = Math.min(60_000, 2_000 * 2 ** (st.failures - 1));
		st.until = Date.now() + delay;
		this.retryState.set(path, st);
		if (silent) this.core.logger.info(t("realtime.realtime_reauth_reconnect", { path: dbPath }));
		else this.core.logger.warn(t("realtime.realtime_auth_failed", { path: dbPath, reason }), st.failures === 1);
		void this.endSession(path).then(() => {
			window.setTimeout(() => this.invalidateParticipants(path), delay);
		});
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
				spaceToken: space ? (space.token ? t("common.set") : t("common.none")) : "-",
			}),
		);
		// room 이름(교사·학생이 정확히 같아야 실시간 공유됨)
		const room = f && space ? this.roomFor(f.path, space) : null;
		log.info(t("realtime.room_manager_and_members_must_have", { room: room ?? t("common.none_2") }));
		const session = f ? this.sessions.get(f.path) : undefined;
		log.info(
			t("realtime.session_connected_participants", {
				state: session ? (session.ready ? t("realtime.ready") : t("realtime.connecting")) : t("common.none"),
				// 소켓 연결(공유) + 문서 인증(개별) — 인증까지 끝나야 동기화가 시작된다.
				connected: session ? `${this.socket?.status ?? "-"}/${session.provider.isAuthenticated ? "auth" : "unauth"}` : "-",
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
				bindView(cm, ytext, session.awareness);
				session.bound.add(cm);
				// 뷰 우하단에 참가자 칩(Excalidraw와 동일) — 포인터 없이도 편집자 이름 상시 표시.
				const host = (view as unknown as { contentEl?: HTMLElement }).contentEl;
				if (host && session.mdPresence && !session.mdPresence.has(cm)) {
					session.mdPresence.set(cm, new PresenceChips(host, session.awareness));
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
		session.awareness.setLocalStateField("user", {
			name: this.settings.displayName || t("common.user"),
			color: { background: hex, stroke: hex },
		});
		try {
			session.exBinding = new ExcalidrawBinding(session.yElements, session.yAssets, api, {
				awareness: session.awareness,
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

	/**
	 * 실시간 지원 excalidraw 형식: 마크다운(.md)인 엑스칼리드로. 이 검사는 이미 excalidraw 뷰에 열린
	 * 파일에만 적용되므로, .excalidraw.md 뿐 아니라 이름이 .md로 바뀐 엑스칼리드로(예: 파일이름.md)도 지원한다.
	 * .md는 스냅샷이 markdown 업로드 경로를 타 전파되며, 순수 .excalidraw(비-markdown)만 제외한다.
	 */
	private isSupportedExcalidraw(p: string): boolean {
		return p.toLowerCase().endsWith(".md");
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

	/**
	 * 세션을 종료 영속(스냅샷) 없이 닫는다 — 원격(교사) 삭제 적용 직전에 호출.
	 * 종료 스냅샷이 tombstone 위에 내용을 다시 올려 삭제를 무효화하는 것을 막는다.
	 */
	async endSessionForDelete(path: string): Promise<void> {
		await this.endSession(path, false);
	}

	private async endSession(path: string, persist = true): Promise<void> {
		const session = this.sessions.get(path);
		if (!session) return;
		this.sessions.delete(path);

		// 내 awareness를 명시적으로 제거(null) → 모든 피어가 즉시 커서/이름을 지운다.
		// (provider.destroy()도 removeAwarenessStates를 브로드캐스트하지만, 명시 제거로 의도를 보존한다.)
		try {
			session.awareness.setLocalState(null);
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

		if (!persist) {
			// 삭제 적용을 위한 종료 — 스냅샷·vault 쓰기 생략(아래 정리만 수행).
		} else if (session.kind === "excalidraw") {
			// Excalidraw 파일은 플러그인이 onChange 때 디스크에 저장한다. 세션 종료 후 그 파일을
			// CouchDB로 한 번 올려 비실시간 멤버에게 전파(서버는 excalidraw를 CouchDB 스냅샷하지 않는다).
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
			// 종료 영속: Y.Text → vault(변경 시) + CouchDB 업로드.
			// 서버(onStoreDocument)가 세션 중에도 CouchDB 스냅샷을 저장하지만, vault 파일은 서버가 쓸 수 없고
			// 서버가 CouchDB 미연동(폴백 모드)일 수도 있으므로 종료 시 클라이언트가 한 번 더 보장한다
			// (서버가 이미 같은 내용을 저장했으면 contentHash 동일 → skipped-same).
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

		// provider.destroy()는 awareness 정리 + 공유 소켓에서 이 문서만 detach한다(소켓은 유지).
		session.provider.destroy();
		session.ydoc.destroy();
		// 마지막 세션이었다면 빈 소켓을 닫는다(재연결 루프/유휴 연결 방지, URL 변경 반영).
		this.teardownSocketIfIdle();
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
		this.participantOk.clear();
		this.participantPending.clear();
		this.syncOpenEditors();
	}

	async dispose(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
		this.teardownSocketIfIdle();
	}
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}
