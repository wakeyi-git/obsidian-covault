import { App, MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { ProviderFactory, RealtimeProvider, RealtimeSocket, HocuspocusProviderFactory } from "./providerFactory";
import { EditorView } from "@codemirror/view";
import { CoreServices } from "../CoreServices";
import { setEditorReadOnly } from "./editorBinding";
import { clientColor } from "./clientColor";
import { relUnder, roomName, pickSpace } from "./room";
import { RetryState, nextRetryState, backoffDelay, inBackoff } from "./retryBackoff";
import { EditorBindingStrategy, ExcalidrawLikeView, Session, SnapshotTarget, StrategyContext } from "./realtimeTypes";
import { MarkdownStrategy } from "./mdStrategy";
import { ExcalidrawStrategy, getExcalidrawApi } from "./excalidrawStrategy";
import { t } from "../../i18n";

export type { SnapshotTarget } from "./realtimeTypes";

/**
 * Yjs 실시간 공동 편집 관리(Hocuspocus). 기술문서 §19. 공유 폴더 markdown(글자) + Excalidraw(요소) 적용.
 * 열린 에디터를 훑어 공유 파일이면 세션(provider+Y.Doc)을 띄우고, kind별 바인딩·종료 스냅샷은 EditorBindingStrategy에
 * 위임(P2-3b). provider/소켓 생성은 ProviderFactory 주입(P2-1), 모든 세션이 WebSocket 연결 하나를 공유(멀티플렉싱).
 * 시드·주기 스냅샷은 서버가 담당, 세션 종료 시 vault 쓰기+CouchDB 업로드(폴백)만 클라이언트가 수행.
 */
export class RealtimeManager {
	private sessions = new Map<string, Session>();
	/** 공유 WebSocket(모든 문서 멀티플렉싱). 첫 세션에서 생성, 마지막 세션 종료 시 닫는다. */
	private socket: RealtimeSocket | null = null;
	/** 지원하지 않는 excalidraw 형식 경고를 경로당 1회만 내기 위한 집합. */
	private warnedUnsupportedExcalidraw = new Set<string>();
	/** kind별 바인딩 전략(평가 P2-3b) — 세션 Y 구조·바인딩·종료 스냅샷의 md/excalidraw 분기를 캡슐화. */
	private readonly strategies: Record<"md" | "excalidraw", EditorBindingStrategy> = {
		md: new MarkdownStrategy(),
		excalidraw: new ExcalidrawStrategy(),
	};

	constructor(
		private app: App,
		private core: CoreServices,
		/** 현재 사용자의 공유 공간 목록(교사=설정, 학생=shares). main이 주입. */
		private getSpaces: () => Array<{ id: string; folder: string; token?: string; kind?: "share" | "homeroom" | "mirror" }>,
		/** 로컬 경로 → 담당 동기화 링크(스냅샷 쓰기용). main이 현재 mode 기준으로 주입. */
		private getSyncForPath: (localPath: string) => SnapshotTarget | undefined = () => undefined,
		/** 이 파일의 라이브 세션에 참여 가능한가(파일별 참여자 게이팅). main이 주입(기본 전원 허용). */
		private canEditRealtime: (localPath: string) => Promise<boolean> = async () => true,
		/** mirror(1:1) 세션을 이 기기의 마지막 참여자가 노트를 닫아 종료할 때(피어0) 호출 — 교사가 rtpart 옵트인 해제(자동 만료). */
		private onMirrorClosedAlone: (localPath: string) => void = () => {},
		/** provider/소켓 생성 seam(평가 P2-1). 기본=실제 Hocuspocus, 테스트는 fake 주입. */
		private providerFactory: ProviderFactory = new HocuspocusProviderFactory(),
	) {}

	// 파일별 참여 허용 캐시(비동기 조회 결과). 파일이 닫히면 비워 재오픈 시 재평가.
	private participantOk = new Map<string, boolean>();
	private participantPending = new Set<string>();
	// 서버 거부(인증 실패·재인가 종료) 재시도 백오프(retryBackoff.ts — 순수 로직). 동기화 성공 시 해제.
	private retryState = new Map<string, RetryState>();
	// 백오프 재평가 타이머(평가 C-2). dispose 후 잔존 타이머가 세션을 재생성하지 않도록 추적·취소한다.
	private retryTimers = new Set<number>();
	// Excalidraw imperative API 마운트 지연 재시도(경로당 시도 횟수·중복 예약 가드·타이머 추적).
	private excalidrawRebindAttempts = new Map<string, number>();
	private excalidrawRebindPending = new Set<string>();
	private excalidrawRetryTimers = new Set<number>();
	private disposed = false;
	// CoVault가 읽기 전용으로 잠근 에디터/그림(정책 해제 시 우리가 잠근 것만 푼다 — 타 플러그인 보호).
	private lockedViews = new WeakSet<EditorView>();
	private lockedExcalidraw = new WeakSet<ExcalidrawLikeView>();

	private get settings() {
		return this.core.settings;
	}

	/** 바인딩 전략에 넘길 주변 의존성(평가 P2-3b). */
	private get strategyCtx(): StrategyContext {
		return {
			app: this.app,
			logger: this.core.logger,
			settings: this.settings,
			getSyncForPath: this.getSyncForPath,
		};
	}

	/**
	 * 공유 WebSocket 획득(lazy). 빈 소켓(연결된 문서 0개)은 서버 메시지가 없어 재연결 루프를 돌고
	 * 유휴 연결을 낭비하므로, 마지막 세션이 끝나면 endSession이 닫는다(yjsServerUrl 변경도 그때 반영).
	 */
	private getSocket(): RealtimeSocket {
		if (!this.socket) this.socket = this.providerFactory.createSocket(this.settings.yjsServerUrl);
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

		// 더는 열려 있지 않은 세션 종료(노트 닫힘) — mirror 1:1 자동 만료가 발화하는 유일한 경로.
		for (const path of [...this.sessions.keys()]) {
			if (!targets.has(path)) void this.endSession(path, true, "closed");
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
				if (inBackoff(this.retryState.get(path), Date.now())) continue; // 서버 거부 백오프 중 — noteServerRefusal의 타이머가 재평가한다
				session = this.startSession(path, tgt.kind);
			}
			if (!session?.ready) continue;
			if (session.kind === tgt.kind) {
				const target = tgt.kind === "md" ? tgt.views : tgt.view;
				const bound = this.strategies[session.kind].bind(session, target, this.strategyCtx);
				// Excalidraw 뷰의 imperative API가 아직 마운트 안 됐으면(onSynced가 뷰보다 먼저) 짧게 재시도한다 —
				// 워크스페이스 이벤트 없이도 준비되는 즉시 바인딩(현장: 탭 전환해야 붙던 문제).
				if (session.kind === "excalidraw") {
					if (bound) this.excalidrawRebindAttempts.delete(path);
					else this.scheduleExcalidrawRebind(path);
				}
			}
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
			const desired = policy && this.isSupportedExcalidraw(file.path) && !!this.spaceFor(file.path) && !this.isActive(file.path);
			const api = getExcalidrawApi(this.app, view);
			if (!api) {
				// imperative API가 아직 마운트 안 됐는데 잠가야 하면(비참여자 읽기전용) 짧게 재시도 —
				// 그렇지 않으면 API 준비 전에 enforceReadOnly가 끝나 그림이 편집 가능한 채로 남는다(현장 버그).
				if (desired) this.scheduleExcalidrawRebind(file.path);
				continue;
			}
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
		const provider = this.providerFactory.createProvider({
			socket: this.getSocket(),
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

		// kind별 Y 구조(ytext / yElements+yAssets)는 전략이 만든다(평가 P2-3b).
		const session: Session = {
			file: path,
			kind,
			ydoc,
			provider,
			awareness,
			ready: false,
			bound: new Set(),
			...this.strategies[kind].initSession(ydoc),
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

	/** Excalidraw API 미마운트 시 짧게 재시도(~300ms×15). 준비 즉시 syncOpenEditors가 재바인딩, 소진 시 경로당 1회 경고. */
	private scheduleExcalidrawRebind(path: string): void {
		if (this.disposed || this.excalidrawRebindPending.has(path)) return;
		const attempts = (this.excalidrawRebindAttempts.get(path) ?? 0) + 1;
		if (attempts > 15) {
			this.core.logger.warn(t("realtime.realtime_cannot_access_excalidraw_api_check", { file: path }), true);
			return; // 포기(다음 워크스페이스 이벤트로 다시 시도될 수 있음 — attempts는 endSession에서 초기화).
		}
		this.excalidrawRebindAttempts.set(path, attempts);
		this.excalidrawRebindPending.add(path);
		const timer = window.setTimeout(() => {
			this.excalidrawRebindPending.delete(path);
			this.excalidrawRetryTimers.delete(timer);
			if (!this.disposed) this.syncOpenEditors();
		}, 300);
		this.excalidrawRetryTimers.add(timer);
	}

	/**
	 * 서버가 이 문서 연결을 거부/종료했을 때: 세션 정리 후 지수 백오프(2s→60s) 재평가. silent=true(정상 재인가)는
	 * 로그만, 진짜 인증 거부는 첫 실패만 알림(지속 거부 시 알림 폭주로 설정 변경조차 막히는 것 방지).
	 */
	private noteServerRefusal(path: string, dbPath: string, reason: string, silent: boolean): void {
		const st = nextRetryState(this.retryState.get(path), Date.now());
		this.retryState.set(path, st);
		const delay = backoffDelay(st.failures);
		if (silent) this.core.logger.info(t("realtime.realtime_reauth_reconnect", { path: dbPath }));
		else this.core.logger.warn(t("realtime.realtime_auth_failed", { path: dbPath, reason }), st.failures === 1);
		void this.endSession(path).then(() => {
			if (this.disposed) return;
			const timer = window.setTimeout(() => {
				this.retryTimers.delete(timer);
				if (!this.disposed) this.invalidateParticipants(path);
			}, delay);
			this.retryTimers.add(timer);
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
			const api = exView ? getExcalidrawApi(this.app, exView) : null;
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

	/** excalidraw 파일 경로 여부(.excalidraw 또는 .excalidraw.md). markdown 처리에서 제외용. */
	private isExcalidrawPath(p: string): boolean {
		const lower = p.toLowerCase();
		return lower.endsWith(".excalidraw") || lower.endsWith(".excalidraw.md");
	}

	/** 실시간 지원 excalidraw: .md인 엑스칼리드로(이미 excalidraw 뷰에 열린 파일만 검사). 순수 .excalidraw(비-md)만 제외. */
	private isSupportedExcalidraw(p: string): boolean {
		return p.toLowerCase().endsWith(".md");
	}

	/** 세션을 종료 스냅샷 없이 닫는다 — 원격(교사) 삭제 적용 직전(종료 스냅샷이 tombstone 위에 내용을 되올리는 것 방지). */
	async endSessionForDelete(path: string): Promise<void> {
		await this.endSession(path, false);
	}

	private async endSession(path: string, persist = true, reason?: "closed"): Promise<void> {
		const session = this.sessions.get(path);
		if (!session) return;
		// mirror 1:1 자동 만료: 노트 닫힘으로 종료하는데 이 기기가 마지막 참여자(피어≤1=나뿐)면 끝낸다(setLocalState(null) 전 캡처).
		const expireMirror = reason === "closed" && this.presenceFor(path) <= 1 && this.isMirrorPath(path);
		this.sessions.delete(path);
		// Excalidraw 재시도 상태 정리(파일이 닫혔으니 재오픈 시 새로 카운트).
		this.excalidrawRebindAttempts.delete(path);
		this.excalidrawRebindPending.delete(path);

		// 내 awareness를 명시적으로 제거(null) → 모든 피어가 즉시 커서/이름을 지운다.
		// (provider.destroy()도 removeAwarenessStates를 브로드캐스트하지만, 명시 제거로 의도를 보존한다.)
		try {
			session.awareness.setLocalState(null);
		} catch {
			/* noop */
		}

		// 바인딩 해제(kind별 — 평가 P2-3b: md=CM6 unbind+칩 정리, excalidraw=exBinding.destroy).
		this.strategies[session.kind].unbind(session);

		// 종료 영속(스냅샷). persist=false(원격 삭제 적용 직전)면 생략 — tombstone 위에 내용을 되올려
		// 삭제를 무효화하는 것을 막는다. kind별 영속은 전략이 담당(md=Y.Text→vault+업로드, excalidraw=디스크 파일 업로드).
		if (persist) await this.strategies[session.kind].snapshot(session, path, this.strategyCtx);

		// provider.destroy()는 awareness 정리 + 공유 소켓에서 이 문서만 detach한다(소켓은 유지).
		session.provider.destroy();
		session.ydoc.destroy();
		// 마지막 세션이었다면 빈 소켓을 닫는다(재연결 루프/유휴 연결 방지, URL 변경 반영).
		this.teardownSocketIfIdle();
		// 자동 만료 통지(교사 클라이언트가 rtpart 해제). 세션 정리를 모두 끝낸 뒤 발화한다.
		if (expireMirror) this.onMirrorClosedAlone(path);
	}

	/** folder 기준 상대경로(dbPath). 순수 로직은 room.ts. */
	private relUnder(localPath: string, folder: string): string | null {
		return relUnder(localPath, folder);
	}

	/** 파일의 room 이름(모든 멤버가 동일해야 함). mirror 공간도 spaceId(mirror-<id>)로 같은 share 네임스페이스를 쓴다. */
	private roomFor(localPath: string, space: { id: string; folder: string }): string | null {
		return roomName(this.settings.workspaceId, space.id, localPath, space.folder);
	}

	/** 파일이 속한 공간(없으면 null). 보관/충돌/제외 폴더 제외, 겹치면 가장 구체적인(folder 최장) 공간 택. */
	private spaceFor(localPath: string): { id: string; folder: string; token?: string; kind?: "share" | "homeroom" | "mirror" } | null {
		return pickSpace(this.getSpaces(), localPath, (folder) => this.isExcludedFromRealtime(localPath, folder));
	}

	/**
	 * 파일이 개인 mirror(교사↔구성원 1:1) 공간 소속인가. mirror 폴더 전체가 자동 실시간이 되어 텍스트↔CRDT
	 * 재조정으로 노트가 중복 누적되던 문제를 막기 위해, mirror 파일은 rtpart 옵트인이 있을 때만 세션을 띄운다.
	 */
	isMirrorPath(localPath: string): boolean {
		return this.spaceFor(localPath)?.kind === "mirror";
	}

	/** 파일이 속한 mirror 공간의 memberId(spaceId=mirror-<id>). mirror 아니면 null — 1:1 토글이 참여자로 지정. */
	mirrorMemberIdFor(localPath: string): string | null {
		const sp = this.spaceFor(localPath);
		return sp?.kind === "mirror" && sp.id.startsWith("mirror-") ? sp.id.slice("mirror-".length) : null;
	}

	/** 보관(_삭제됨)·충돌(_충돌)·제외 폴더 아래 파일인지(실시간 제외 — [MirrorContext.isExcluded]와 동일 규칙). */
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

	/** 모든 세션을 깨끗이 종료(awareness 제거) 후 재정렬. 설정 적용/재배포로 mode 재시작 시 호출(유령 커서 방지). */
	async refresh(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
		this.participantOk.clear();
		this.participantPending.clear();
		this.syncOpenEditors();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const timer of this.retryTimers) window.clearTimeout(timer);
		this.retryTimers.clear();
		for (const timer of this.excalidrawRetryTimers) window.clearTimeout(timer);
		this.excalidrawRetryTimers.clear();
		this.excalidrawRebindPending.clear();
		this.excalidrawRebindAttempts.clear();
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
		this.teardownSocketIfIdle();
	}
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}
