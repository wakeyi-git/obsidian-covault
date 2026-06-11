import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { errMessage } from "./core/util/err";
import { registerCommands as registerCovaultCommands } from "./commands";
import { jumpToFeedback } from "./ui/feedbackJump";
import { CoVaultSettings, DEFAULT_SETTINGS, Role, MemberConfig, SharedSpace, GroupConfig } from "./settings/types";
import { localizeDefaultFolders } from "./settings/localizeDefaults";
import { VersionDoc, NoticeDoc, ResponseDoc, MessageDoc, GroupRequestDoc } from "./core/model/types";
import { AssignmentDoc, AssignmentStateDoc, AssignmentGrade } from "./core/model/types";
import { RoutineDoc, RoutineStateDoc } from "./core/model/types";
import { CoVaultSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { CoVaultMode } from "./modes/CoVaultMode";
import { MemberMode } from "./modes/member/MemberMode";
import { ManagerMode } from "./modes/manager/ManagerMode";
import { TFile, TFolder } from "obsidian";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { ConflictModal, ConflictRow, ConflictHost } from "./ui/ConflictModal";
import { VersionHistoryModal } from "./ui/VersionHistoryModal";
import { SetupWizardModal } from "./ui/SetupWizardModal";
import { ResolveChoice } from "./core/sync/ConflictManager";
import { BulkCopy, CopyOptions, CopyResult, CopyPlan } from "./modes/manager/BulkCopy";
import { RealtimeManager } from "./core/realtime/RealtimeManager";
import { getCouchPassword } from "./core/secret";
import { realtimeEditorExtension } from "./core/realtime/editorBinding";
import { FeedbackStore } from "./core/feedback/FeedbackStore";
import { ClassroomStore } from "./core/classroom/ClassroomStore";
import { ClassroomController } from "./modes/ClassroomController";
import { RealtimeController } from "./modes/RealtimeController";
import { MemberController } from "./modes/MemberController";
import { GroupRequestController } from "./modes/GroupRequestController";
import { RecoveryController } from "./modes/RecoveryController";
import { ParticipantController } from "./modes/ParticipantController";
import { DeploymentController } from "./modes/DeploymentController";
import { ServerResetController } from "./modes/ServerResetController";
import { OnboardingController } from "./modes/OnboardingController";
import { PouchService } from "./core/couch/PouchService";
import { promptAddFeedback } from "./ui/FeedbackView";
import { CoVaultPanelView, PANEL_VIEW_TYPE } from "./ui/PanelView";
import { PanelHost, PanelTab, SystemView, DashboardRow, DeleteModifyRow, PurgeRow } from "./ui/panel/PanelSection";
import { MirrorSync } from "./core/sync/MirrorSync";
import { DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "./core/sync/RestoreManager";
import { testConnection } from "./core/sync/connectionTest";
import { runDiagnostics } from "./core/sync/diagnostics";
import { CouchAdmin } from "./core/couch/CouchAdmin";
import { INVITE_ACTION, InvitePayload } from "./core/invite/invite";
import { ConfirmModal } from "./ui/ConfirmModal";
import { exportSettings, importSettings } from "./settings/portable";
import { ResetModal } from "./ui/ResetModal";
import { currentLocale, initI18n, t } from "./i18n";

/**
 * CoVault for Obsidian — 플러그인 진입점.
 *
 * 역할은 최초 1회 선택 후 잠긴다(기술문서 §5.4 보강). 실행 시 저장된 last_seq부터 증분 재개하고,
 * 전체 동기화는 최초 1회와 수동 명령에서만 수행한다.
 */
export default class CoVaultPlugin extends Plugin implements SettingsHost, ConflictHost, PanelHost {
	settings!: CoVaultSettings;
	logger = new Logger();
	private core!: CoreServices;
	private mode: CoVaultMode | null = null;
	private realtime!: RealtimeManager;
	private rtStatus!: HTMLElement;
	private feedback!: FeedbackStore;
	private classroom!: ClassroomStore;
	private classroomCtl!: ClassroomController;
	private pendingChatChannel: string | null = null; // 그룹 대화 카드 → 대화 탭 초기 채널 전달
	private pendingSystemView: SystemView | null = null; // 명령/CTA → 시스템 탭 초기 서브뷰 전달
	private realtimeCtl!: RealtimeController;
	private memberCtl!: MemberController;
	private recoveryCtl!: RecoveryController;
	private participantCtl!: ParticipantController;
	private deploymentCtl!: DeploymentController;
	private groupRequestCtl!: GroupRequestController;
	private groupRequestTimer: number | null = null; // grouprequest 변경 → 교사 처리 debounce
	private serverResetCtl!: ServerResetController;
	private onboardingCtl!: OnboardingController;
	private applyTimer: number | null = null;

	/** PanelHost: 피드백 섹션이 사용. */
	get feedbackStore(): FeedbackStore {
		return this.feedback;
	}

	/** PanelHost: 대시보드 섹션이 사용. */
	get classroomStore(): ClassroomStore {
		return this.classroom;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		initI18n(this.settings.language); // 모든 t() 이전에 로케일 확정

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);

		// 실시간 공동 편집(Yjs) — 공유 폴더 문서
		this.realtime = new RealtimeManager(
			this.app,
			this.core,
			() => this.core.sharedSpaces,
			(p) => this.syncForLocalPath(p), // 주기적 스냅샷 쓰기 대상
			(p) => this.participantCtl.canEditRealtime(p), // 파일별 참여자 게이팅
		);
		this.core.isRealtimeActive = (p) => this.realtime.isActive(p);
		this.core.endRealtimeSession = (p) => this.realtime.endSessionForDelete(p);
		this.realtimeCtl = new RealtimeController({
			app: this.app,
			settings: () => this.settings,
			realtime: () => this.realtime,
			openLog: () => this.openLog(),
		});
		this.memberCtl = new MemberController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			couchPassword: () => this.couchPassword(),
			saveSettings: () => this.saveSettings(),
			requestApply: () => this.requestApply(),
			openLog: () => this.openLog(),
			mintMirror: (m) => this.realtimeCtl.mintMirror(m),
			mintMemberToken: (sp, memberId) => this.realtimeCtl.mintMemberToken(sp, memberId),
		});
		this.registerEditorExtension(realtimeEditorExtension());

		// 피드백 레이어(§19.5)
		this.feedback = new FeedbackStore(
			this.core,
			(p) => this.syncForLocalPath(p),
			() => this.mode?.getSyncs() ?? [],
		);
		this.core.onFeedbackChange = () => this.feedback.refresh();

		// 학급 운영(대시보드) 저장소 — 학급 공유 공간 pouch에 알림장·시간표 등 공통 문서를 읽고 쓴다.
		this.classroom = new ClassroomStore(this.core, () => this.homeroomPouch());
		this.classroomCtl = new ClassroomController({
			app: this.app,
			logger: this.logger,
			classroom: this.classroom,
			settings: () => this.settings, // settings는 load/import에서 교체되므로 getter로
			couchPassword: () => this.couchPassword(),
			homeroomReady: () => this.homeroomReady(),
			homeroomFolder: () => this.homeroomFolder(),
			saveSettings: () => this.saveSettings(),
			requestApply: () => this.requestApply(),
			memberSyncByRemoteDb: (db) => this.mode?.findSyncByDb(db),
			studentMirrorSync: () => this.mode?.findSyncByDb(this.settings.remoteDb),
			homeroomDb: () => this.core.homeroom?.remoteDb ?? null,
		});
		this.recoveryCtl = new RecoveryController({
			app: this.app,
			logger: this.logger,
			getSyncs: () => this.mode?.getSyncs() ?? [],
			findSyncByDb: (db) => this.mode?.findSyncByDb(db),
			findSyncOwning: (p) => this.mode?.findSyncOwning(p),
			openLog: () => this.openLog(),
		});
		this.participantCtl = new ParticipantController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			realtime: () => this.realtime,
			getSyncs: () => this.mode?.getSyncs() ?? [],
			findSyncOwning: (p) => this.mode?.findSyncOwning(p),
			sharedSpaces: () => this.core.sharedSpaces,
			saveSettings: () => this.saveSettings(),
			refreshMemberShares: () => this.refreshMemberShares(),
			writeRtControl: () => this.deploymentCtl.writeRtControl(),
			redeployValidate: () => this.deploymentCtl.redeployValidate(),
			requestValidateRedeploy: (db) => this.deploymentCtl.requestValidateRedeploy(db),
		});
		this.deploymentCtl = new DeploymentController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			couchPassword: () => this.couchPassword(),
			saveSettings: () => this.saveSettings(),
			restartMode: () => this.restartMode(),
			openLog: () => this.openLog(),
			openDashboard: () => this.activatePanel("dashboard"),
			writeMemberSync: (admin, m) => this.writeMemberSync(admin, m),
			mintRealtimeTokens: () => this.mintRealtimeTokens(),
			refreshMemberShares: () => this.refreshMemberShares(),
		});
		this.groupRequestCtl = new GroupRequestController({
			logger: this.logger,
			classroom: this.classroom,
			settings: () => this.settings,
			homeroomReady: () => this.homeroomReady(),
			saveSettings: () => this.saveSettings(),
			deployShared: (space, opts) => this.deploymentCtl.deployShared(space, opts),
			saveGroup: (g) => this.saveGroup(g),
		});
		this.serverResetCtl = new ServerResetController({
			logger: this.logger,
			settings: () => this.settings,
			couchPassword: () => this.couchPassword(),
			saveSettings: () => this.saveSettings(),
			openLog: () => this.openLog(),
			stopMode: async () => {
				await this.mode?.stop();
				this.mode = null;
			},
			cancelPendingApply: () => {
				if (this.applyTimer) {
					window.clearTimeout(this.applyTimer);
					this.applyTimer = null;
				}
			},
			destroyDbCache: async (db) => {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
			},
			clearCoreSharedSpaces: () => {
				this.core.sharedSpaces = [];
			},
		});
		this.onboardingCtl = new OnboardingController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			stopMode: async () => {
				await this.mode?.stop();
				this.mode = null;
			},
			startMode: () => this.startMode(),
			destroyLocalCaches: () => this.destroyLocalCaches(),
			openLog: () => this.openLog(),
			promptRoleSetup: () => this.promptRoleSetup(),
			probeStatus: async (db) => {
				const probe = this.core.createPouch(db);
				try {
					const info = await probe.rawInfo();
					return info.status ?? null;
				} catch {
					return null; // 서버 도달 실패 → startMode 재시도에 맡긴다
				} finally {
					await probe.close();
				}
			},
			confirmInvite: (payload) => this.confirmInvite(payload),
		});
		this.core.onClassroomChange = () => this.classroom.refresh();
		// 파일별 실시간 참여자 변경(수신 포함) → 게이트 재평가. 빠진 구성원의 활성 세션을 즉시 종료.
		this.core.onParticipantsChange = () => this.realtime?.invalidateParticipants();
		// 그룹 신청 변경 — 교사: debounce 후 대기 신청 처리(자동 승인이면 배포 포함), 구성원: 패널이 폴링으로 갱신.
		this.core.onGroupRequestChange = () => {
			if (this.settings.role !== "manager") return;
			if (this.groupRequestTimer) window.clearTimeout(this.groupRequestTimer);
			this.groupRequestTimer = window.setTimeout(() => {
				this.groupRequestTimer = null;
				void this.groupRequestCtl.processPending();
			}, 2000);
		};
		// 알림장·수업은 편집창 + 프론트매터로 작성한다 — 파일 프론트매터 변경/삭제/이름변경을 게시 메타에 반영(교사).
		this.registerEvent(this.app.metadataCache.on("changed", (file) => { if (file instanceof TFile) void this.classroomCtl.syncNoticeFromFile(file); }));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile)) return;
			void this.classroomCtl.onNoticeFileDeleted(file.path);
			void this.participantCtl.onFileDeleted(file.path); // 실시간 지정 문서 정리
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			void this.classroomCtl.onNoticeFileRenamed(file, oldPath);
			void this.participantCtl.onFileRenamed(oldPath, file.path); // 실시간 지정 문서 이전
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onWorkspaceChange()));
		this.rtStatus = this.addStatusBarItem();
		this.registerInterval(window.setInterval(() => this.updateRtStatus(), 2000));

		// 백그라운드(앱/창 비활성) 시 원격 동기화 일시정지 → 배터리/네트워크 절감(기술문서 §24.6)
		this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());

		this.registerView(PANEL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CoVaultPanelView(leaf, this));
		this.addSettingTab(new CoVaultSettingTab(this.app, this));
		// 아이콘은 학급 전용(학사모)이 아닌 제품 정체성(공유 금고) 기준 — 볼트 공유·동기화·실시간 편집 전반에 쓰인다.
		this.addRibbonIcon("vault", t("command.open_covault_panel"), () => this.activatePanel());
		this.registerCommands();

		// 학생 초대 딥링크: 폰 카메라로 QR 스캔 → obsidian://covault-invite?d=... → 자동 설정
		this.registerObsidianProtocolHandler(INVITE_ACTION, (params) => {
			void this.ingestInvite(params.d ?? "");
		});

		// 무거운 작업(PouchDB live replication 시작)은 워크스페이스가 준비된 뒤로 미뤄 Obsidian 시작을 막지 않는다.
		// onLayoutReady는 이미 준비된 상태(플러그인을 나중에 켠 경우)면 즉시 콜백을 실행한다.
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.setupComplete) this.promptRoleSetup(); // 최초 실행: 역할 선택 후 시작
			else void this.startMode();
		});

		this.logger.info(t("command.covault_loaded_role_setup", { role: this.settings.role, setup: String(this.settings.setupComplete) }));
	}

	async onunload(): Promise<void> {
		if (this.applyTimer) window.clearTimeout(this.applyTimer);
		if (this.groupRequestTimer) window.clearTimeout(this.groupRequestTimer);
		this.deploymentCtl?.dispose(); // 대기 중인 validate 재배포 타이머 정리
		await this.realtime?.dispose();
		await this.mode?.stop();
		await this.core?.flushPersist();
		this.core?.dispose();
	}

	// --- 설정 ---
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/** 활성 CouchDB 비밀번호(Secret Storage 우선, 평문 폴백). */
	private couchPassword(): string {
		return getCouchPassword(this.app, this.settings.password);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- 모드 시작/정지 ---
	private createMode(role: Role): CoVaultMode {
		return role === "manager" ? new ManagerMode(this.core) : new MemberMode(this.core);
	}

	private async startMode(): Promise<void> {
		this.core.settings = this.settings;
		this.mode = this.createMode(this.settings.role);
		await this.mode.start();
		// 재배포/설정 적용 시 기존 세션을 깨끗이 종료(awareness 제거) 후 재구성 → 유령 커서 방지
		await this.realtime?.refresh();
		void this.participantCtl.backfillRtPartNames(); // 구버전 지정 문서에 이름 채우기(학생 카드에 이름 표시)
		void this.classroomCtl.cleanupLegacyGroups(); // 0.100.x 파일별 그룹 문서 정리(드롭다운 유령 제거)
		if (this.settings.role === "manager") {
			void this.deploymentCtl.redeployValidate(); // validate 버전 마이그레이션(1회, 실패 시 다음 시작 재시도)
			void this.groupRequestCtl.syncRoster(); // 학급 명단 배포(구성원 그룹 신청 UI 선택지)
			void this.groupRequestCtl.processPending(); // 오프라인 동안 쌓인 그룹 신청 캐치업
			this.realtimeCtl.warnExpiringTokens(); // 토큰 만료 임박/경과 경고(재배포 유도)
		}
		// 모드 시작 완료 알림 — 패널이 모드보다 먼저 그려졌으면(워크스페이스 복원) homeroomReady=false로
		// "학급 공동 공간 지정" 안내가 남는다. 준비 완료 시점에 한 번 갱신해 stale 화면을 지운다.
		this.classroom.refresh();
	}

	/** 최초 실행 역할 선택 모달 → 역할 잠금 + 모드 시작. 학생은 초대 코드로 바로 설정 가능. */
	private promptRoleSetup(): void {
		// 신규 설치(비한국어 로케일)의 기본 폴더명 현지화 — 최초 실행 전용이라 기존 폴더는 불변.
		if (localizeDefaultFolders(this.settings, currentLocale())) void this.saveSettings();
		new RoleSetupModal(
			this.app,
			async (role) => {
				this.settings.role = role;
				this.settings.setupComplete = true;
				if (role === "manager") {
					this.settings.userId = "manager";
					if (this.settings.displayName === t("common.member_a")) this.settings.displayName = t("common.manager");
				}
				await this.saveSettings();
				this.logger.ok(
					role === "manager"
						? t("panel.manager_mode_set_up_follow_the")
						: t("command.member_mode_setup_complete_connect_using"),
					true,
				);
				await this.startMode();
				// 교사는 온보딩 마법사(모달)를 자동으로 띄운다(이미 완료/닫았으면 생략).
				if (role === "manager" && !this.settings.managerOnboardingDone) this.openSetupWizard();
			},
			(code) => void this.ingestInvite(code),
		).open();
	}

	/** 역할 재설정(데이터 초기화). 설정 탭에서 호출. 로컬 캐시까지 비운다. */
	resetSetup(): Promise<void> {
		return this.onboardingCtl.resetSetup();
	}

	/** 현재 역할이 로컬 캐시를 가진 모든 DB(개인/학생 mirror + 공유 공간). 중복 제거. */
	private collectLocalDbs(): string[] {
		const s = this.settings;
		const dbs =
			s.role === "manager"
				? s.members.map((st) => st.remoteDb)
				: [s.remoteDb];
		dbs.push(...s.sharedSpaces.map((sp) => sp.remoteDb));
		return [...new Set(dbs.filter((d) => d))];
	}

	/** 현재 역할의 모든 mirror DB + 공유 공간 DB 로컬 캐시(IndexedDB)를 삭제. */
	private async destroyLocalCaches(): Promise<void> {
		const dbs = this.collectLocalDbs();
		for (const db of dbs) {
			try {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
				this.logger.ok(t("command.local_cache_deleted", { db }));
			} catch (e) {
				this.logger.error(t("command.failed_to_delete_local_cache", { db, err: errMessage(e) }));
			}
		}
	}

	/** 로컬 캐시 초기화(확인 후). 아직 업로드되지 않은 로컬 변경이 유실될 수 있는 파괴적 동작이라 확인을 받는다. */
	async resetLocalCache(): Promise<void> {
		new ConfirmModal(this.app, {
			title: t("command.reset_cache_confirm_title"),
			message: t("command.reset_cache_confirm_body"),
			confirmText: t("common.reset"),
			warning: true,
			onConfirm: () => this.doResetLocalCache(),
		}).open();
	}

	/** 로컬 캐시 초기화 후 서버에서 다시 받기. */
	private async doResetLocalCache(): Promise<void> {
		await this.openLog();
		await this.mode?.stop();
		this.mode = null;
		await this.destroyLocalCaches();
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		if (this.settings.setupComplete) await this.startMode();
		this.logger.ok(t("command.local_cache_reset_re_syncing_from"), true);
	}

	// --- 학생 프로비저닝 + 초대 (Manager) ---
	/** 성공(프로비저닝+초대 표시) 시 true. 실패 시 false(호출자가 로컬 상태를 되돌릴 수 있게). */
	inviteMember(member: MemberConfig): Promise<boolean> {
		return this.memberCtl.inviteMember(member);
	}

	/** 프로비저닝되지 않은 모든 구성원을 일괄 초대. 프로비저닝된 수를 반환. */
	inviteAllMembers(): Promise<number> {
		return this.memberCtl.inviteAllMembers();
	}

	/**
	 * 학생 비밀번호 재발급(회전). 새 비밀번호로 _users를 갱신하므로 **이전 초대 코드는 즉시 무효**가 된다.
	 * 잃어버린/유출된 초대를 폐기하는 용도. 새 초대 코드를 바로 보여준다.
	 *
	 * 서버 갱신이 실패하면 로컬 비밀번호를 이전 값으로 되돌려, 로컬만 새 비밀번호로 바뀐 불일치를 막는다.
	 */
	rotateMemberPassword(member: MemberConfig): Promise<void> {
		return this.memberCtl.rotateMemberPassword(member);
	}

	// --- 공유 공간 배포 (Manager) ---
	deployShared(space: SharedSpace): Promise<void> {
		return this.deploymentCtl.deployShared(space);
	}

	/**
	 * 학급 공동 공간의 pouch(미지정/미수신이면 undefined). core.homeroom(지정된 공간 DB)로 현재 모드의
	 * 동기화 링크에서 해석한다 — 교사(설정의 sharedSpaces)·학생(수신한 shares) 양쪽 모두 동작.
	 */
	private homeroomPouch(): PouchService | undefined {
		const h = this.core.homeroom;
		if (!h) return undefined;
		return this.mode?.findSyncByDb(h.remoteDb)?.ctx.pouch;
	}

	/** 학급 운영 기능의 기준 폴더(지정된 학급 공동 공간의 폴더). 미지정이면 null. */
	private homeroomFolder(): string | null {
		return this.core.homeroom?.folder ?? null;
	}

	/** PanelHost: 학급 공동 공간이 준비됐는지(지정 + 배포 + 동기화 링크 존재). */
	homeroomReady(): boolean {
		return !!this.homeroomPouch();
	}

	/**
	 * PanelHost: 학급 공동 공간이 '지정'되어 있는지(연결 준비와 무관). 교사=설정 기준이라 모드 시작 전에도
	 * 즉시 판단된다 — 볼트 재시작 직후 패널이 모드보다 먼저 그려질 때 "지정하세요" 안내가 깜빡이는 것 방지.
	 */
	homeroomConfigured(): boolean {
		if (this.settings.role === "manager") return this.settings.sharedSpaces.some((sp) => sp.kind === "homeroom");
		return !!this.core.homeroom;
	}

	// --- 실시간 참여 게이트/파일별 참여자/읽기전용 → ParticipantController 위임 ---
	realtimeTokenReceived(): boolean {
		return this.participantCtl.realtimeTokenReceived();
	}
	realtimeSessions(): Array<{ path: string; participants: number }> {
		return this.participantCtl.realtimeSessions();
	}
	realtimeActiveFile(): { path: string; participants: number } | null {
		return this.participantCtl.realtimeActiveFile();
	}
	getFileRealtimeParticipants(path: string): Promise<string[] | null> {
		return this.participantCtl.getFileRealtimeParticipants(path);
	}
	listRealtimeFiles(): Promise<Array<{ path: string; memberIds: string[]; memberNames?: Record<string, string> }>> {
		return this.participantCtl.listRealtimeFiles();
	}
	setSharedReadOnly(on: boolean): Promise<void> {
		return this.participantCtl.setSharedReadOnly(on);
	}
	setFileRealtimeParticipants(path: string, memberIds: string[] | null): Promise<void> {
		return this.participantCtl.setFileRealtimeParticipants(path, memberIds);
	}

	/** PanelHost: 구성원별 실시간 허용/차단(교사). 차단=토큰 미발급·shares realtime:false → 파일 동기화만. */
	async setMemberRealtime(memberId: string, allowed: boolean): Promise<void> {
		const s = this.settings;
		if (s.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		const m = s.members.find((x) => x.memberId === memberId);
		if (!m) return;
		m.realtimeBlocked = !allowed;
		await this.realtimeCtl.mintMirror(m); // 차단이면 mirror 토큰 삭제, 허용이면 재발급
		await this.saveSettings();
		if (m.provisioned && s.couchdbUrl && s.username && this.couchPassword()) {
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
			await this.writeMemberSync(admin, m); // 갱신된 shares를 학생 mirror에 기록 → 학생이 자동 반영
		}
		this.logger.ok(
			(allowed ? t("realtime.member_allowed", { name: m.memberName || memberId }) : t("realtime.member_blocked", { name: m.memberName || memberId })),
			true,
		);
	}

	/** SettingsHost: 공유 공간 하나를 학급 공동 공간으로 지정/해제(교사 전용). */
	setHomeroomSpace(space: SharedSpace, on: boolean): Promise<void> {
		return this.deploymentCtl.setHomeroomSpace(space, on);
	}

	/** SettingsHost: 내 볼트 개인 동기화 켜기/끄기(교사 전용). 켜면 개인 DB를 프로비저닝하고 모드 재시작. */
	setPersonalSync(on: boolean): Promise<void> {
		return this.deploymentCtl.setPersonalSync(on);
	}

	/** SettingsHost: 교사 온보딩 마법사(모달) 실행. */
	openSetupWizard(): void {
		new SetupWizardModal(this.app, this).open();
	}


	// --- 학급 운영(대시보드): ClassroomController에 위임 ---
	newNotice(): Promise<boolean> {
		return this.classroomCtl.newNotice();
	}
	createLesson(title: string, weekKey?: string): Promise<string | null> {
		return this.classroomCtl.createLesson(title, weekKey);
	}
	deleteNotice(notice: NoticeDoc): Promise<void> {
		return this.classroomCtl.deleteNotice(notice);
	}
	setNoticePublished(notice: NoticeDoc, published: boolean): Promise<void> {
		return this.classroomCtl.setNoticePublished(notice, published);
	}
	createTemplateFile(kind: "notice" | "lesson" | "assignment"): Promise<void> {
		return this.classroomCtl.createTemplateFile(kind);
	}
	cleanupClassroomDocs(): Promise<{ duplicates: number; orphans: number; danglingLinks: number; orphanAssignments: number }> {
		return this.classroomCtl.cleanupClassroomDocs();
	}
	/** 명령용: 로그 패널을 열고 중복/고아 학급 문서 정리 실행(결과는 로그에 표시). */
	private async runCleanupClassroom(): Promise<void> {
		await this.openLog();
		await this.cleanupClassroomDocs();
	}
	openLesson(uid: string): Promise<void> {
		return this.classroomCtl.openLesson(uid);
	}
	assignmentDefs(): AssignmentDoc[] {
		return this.classroomCtl.assignmentDefs();
	}
	createAssignment(input: Parameters<ClassroomController["createAssignment"]>[0]): Promise<boolean> {
		return this.classroomCtl.createAssignment(input);
	}
	updateAssignment(uid: string, input: Parameters<ClassroomController["updateAssignment"]>[1]): Promise<boolean> {
		return this.classroomCtl.updateAssignment(uid, input);
	}
	deleteAssignment(uid: string): Promise<boolean> {
		return this.classroomCtl.deleteAssignment(uid);
	}
	listMyAssignments(): Promise<AssignmentStateDoc[]> {
		return this.classroomCtl.listMyAssignments();
	}
	listAssignmentStates(uid: string): Promise<AssignmentStateDoc[]> {
		return this.classroomCtl.listAssignmentStates(uid);
	}
	listAllAssignmentStates(): Promise<AssignmentStateDoc[]> {
		return this.classroomCtl.listAllAssignmentStates();
	}
	submitAssignment(state: AssignmentStateDoc): Promise<boolean> {
		return this.classroomCtl.submitAssignment(state);
	}
	unsubmitAssignment(state: AssignmentStateDoc): Promise<boolean> {
		return this.classroomCtl.unsubmitAssignment(state);
	}
	openVaultPath(path: string): Promise<void> {
		return this.classroomCtl.openVaultPath(path);
	}
	returnAssignment(uid: string, memberId: string, grade: AssignmentGrade): Promise<boolean> {
		return this.classroomCtl.returnAssignment(uid, memberId, grade);
	}
	listRoutines(): Promise<RoutineDoc[]> {
		return this.classroomCtl.listRoutines();
	}
	reorderRoutines(orderedUids: string[]): Promise<void> {
		return this.classroomCtl.reorderRoutines(orderedUids);
	}
	createRoutine(input: Parameters<ClassroomController["createRoutine"]>[0]): Promise<boolean> {
		return this.classroomCtl.createRoutine(input);
	}
	updateRoutine(uid: string, input: Parameters<ClassroomController["updateRoutine"]>[1]): Promise<boolean> {
		return this.classroomCtl.updateRoutine(uid, input);
	}
	deleteRoutine(uid: string): Promise<void> {
		return this.classroomCtl.deleteRoutine(uid);
	}
	myRoutineState(uid: string, day: string): Promise<RoutineStateDoc | null> {
		return this.classroomCtl.myRoutineState(uid, day);
	}
	toggleRoutineItem(uid: string, day: string, itemId: string, checked: boolean): Promise<boolean> {
		return this.classroomCtl.toggleRoutineItem(uid, day, itemId, checked);
	}
	myRoutineDays(uid: string): Promise<RoutineStateDoc[]> {
		return this.classroomCtl.myRoutineDays(uid);
	}
	listRoutineStates(uid: string, day: string): Promise<RoutineStateDoc[]> {
		return this.classroomCtl.listRoutineStates(uid, day);
	}
	listAllRoutineStates(): Promise<RoutineStateDoc[]> {
		return this.classroomCtl.listAllRoutineStates();
	}
	postPrivateResponse(doc: ResponseDoc): Promise<boolean> {
		return this.classroomCtl.postPrivateResponse(doc);
	}
	postPrivateResponseTo(remoteDb: string, doc: ResponseDoc): Promise<boolean> {
		return this.classroomCtl.postPrivateResponseTo(remoteDb, doc);
	}
	listPrivateResponses(): Promise<ResponseDoc[]> {
		return this.classroomCtl.listPrivateResponses();
	}
	sendMessage(channel: string, body: string, replyTo?: string): Promise<boolean> {
		return this.classroomCtl.sendMessage(channel, body, replyTo);
	}
	listMessages(channel: string): Promise<MessageDoc[]> {
		return this.classroomCtl.listMessages(channel);
	}
	deleteMessage(channel: string, doc: MessageDoc): Promise<void> {
		return this.classroomCtl.deleteMessage(channel, doc);
	}
	attachFileToChannel(channel: string, srcPath: string): Promise<string | null> {
		return this.classroomCtl.attachFileToChannel(channel, srcPath);
	}
	listChatGroups(): Promise<Array<{ channel: string; groupId: string; name: string; memberIds: string[]; memberNames?: Record<string, string>; temp?: boolean }>> {
		return this.classroomCtl.listChatGroups();
	}
	/** PanelHost: 노트의 피드백 목록(대화 피드백 참조 picker용). */
	async listFeedback(path: string): Promise<Array<{ uid: string; label: string; path: string }>> {
		const docs = await this.feedback.listFor(path);
		return docs.map((d) => ({ uid: d._id.split(":").pop() ?? d._id, label: (d.content || "").replace(/\s+/g, " ").trim().slice(0, 40) || path.split("/").pop() || path, path }));
	}
	/** PanelHost: 피드백 참조 클릭 → 앵커 위치로 이동. */
	async openFeedback(path: string, uid: string): Promise<void> {
		const docs = await this.feedback.listFor(path);
		const doc = docs.find((d) => (d._id.split(":").pop() ?? "") === uid);
		if (!doc) {
			new Notice(t("chat.feedback_not_found"));
			return;
		}
		await jumpToFeedback(this.app, doc, path);
	}
	/** 명명 그룹 목록(관리 UI). */
	listGroups(): GroupConfig[] {
		return this.settings.groups;
	}
	/** 그룹 생성/수정(교사). settings.groups upsert + homeroom 그룹 문서(대화방) 동기화. */
	async saveGroup(group: GroupConfig): Promise<void> {
		if (this.settings.role !== "manager") return;
		const i = this.settings.groups.findIndex((g) => g.id === group.id);
		if (i >= 0) this.settings.groups[i] = group;
		else this.settings.groups.push(group);
		await this.saveSettings();
		const names: Record<string, string> = {};
		for (const id of group.memberIds) {
			const m = this.settings.members.find((x) => x.memberId === id);
			if (m?.memberName) names[id] = m.memberName;
		}
		await this.classroomCtl.syncGroupDoc(group, names);
	}
	/** 그룹 삭제(교사). settings.groups 제거 + 그룹 대화방 삭제. 그룹 공간(신청-승인)이 있으면 공간도 해제. */
	async deleteGroup(id: string): Promise<void> {
		if (this.settings.role !== "manager") return;
		const g = this.settings.groups.find((x) => x.id === id);
		this.settings.groups = this.settings.groups.filter((x) => x.id !== id);
		await this.saveSettings();
		await this.classroomCtl.deleteGroupDoc(id);
		// 그룹 공간 해제: 서버 DB 삭제 → 설정 제거 → 전 구성원 shares 재전파 → 모드 재구성.
		// 각자 로컬 폴더의 파일은 남는다(데이터 보존 — 동기화·실시간만 끊긴다).
		const space = g?.spaceId ? this.settings.sharedSpaces.find((sp) => sp.id === g.spaceId) : undefined;
		if (space) {
			await this.serverResetCtl.deleteSharedServer(space); // stopMode 포함
			this.settings.sharedSpaces = this.settings.sharedSpaces.filter((sp) => sp.id !== space.id);
			await this.saveSettings();
			await this.refreshMemberShares();
			await this.restartMode();
		}
	}
	/** 라이브 세션에 그룹 적용: 그 파일의 참여자를 그룹 구성원으로 설정(교사). */
	async applyGroupToFile(filePath: string, groupId: string): Promise<void> {
		const g = this.settings.groups.find((x) => x.id === groupId);
		if (!g) return;
		await this.participantCtl.setFileRealtimeParticipants(filePath, g.memberIds);
	}
	/** 그룹 대화방 열기(대화 탭). */
	async openGroupChat(groupId: string): Promise<void> {
		const ch = this.classroomCtl.groupChannelFor(groupId);
		if (ch) await this.openChat(ch);
	}
	/**
	 * 세션 참여자 명단으로 그룹 대화 열기(교사). 구성원이 정확히 일치하는 기존 그룹(명명·임시)이 있으면
	 * 재사용하고, 없으면 임시 그룹을 만들어 연다. 임시 그룹은 대화방 목록에서 삭제할 수 있다.
	 */
	async openSessionGroupChat(memberIds: string[]): Promise<void> {
		if (this.settings.role !== "manager" || !memberIds.length) return;
		const want = new Set(memberIds);
		let g = this.settings.groups.find((x) => x.memberIds.length === want.size && x.memberIds.every((id) => want.has(id)));
		if (!g) {
			const names = memberIds.map((id) => this.settings.members.find((m) => m.memberId === id)?.memberName || id);
			g = {
				id: `tmp${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
				name: names.join(", "),
				memberIds: [...memberIds],
				temp: true,
			};
			await this.saveGroup(g);
		}
		await this.openGroupChat(g.id);
	}
	/** PanelHost: 구성원 자율 그룹 신청-승인(GroupRequestController 위임). */
	requestGroup(input: { name: string; folder: string; memberIds: string[] }): Promise<boolean> {
		return this.groupRequestCtl.requestGroup(input);
	}
	listMyGroupRequests(): Promise<GroupRequestDoc[]> {
		return this.groupRequestCtl.listMyRequests();
	}
	cancelGroupRequest(req: GroupRequestDoc): Promise<void> {
		return this.groupRequestCtl.cancelRequest(req);
	}
	listPendingGroupRequests(): Promise<GroupRequestDoc[]> {
		return this.groupRequestCtl.listPendingRequests();
	}
	approveGroupRequest(req: GroupRequestDoc): Promise<boolean> {
		return this.groupRequestCtl.approveRequest(req);
	}
	rejectGroupRequest(req: GroupRequestDoc, reason?: string): Promise<void> {
		return this.groupRequestCtl.rejectRequest(req, reason);
	}
	rosterMembers(): Promise<Array<{ memberId: string; name: string }>> {
		return this.groupRequestCtl.rosterMembers();
	}
	/** 대화 탭을 특정 채널로 연다. ChatSection이 render 시 consumePendingChatChannel로 받는다. */
	async openChat(channel: string): Promise<void> {
		this.pendingChatChannel = channel;
		await this.activatePanel("chat");
	}
	/** 보류 중 초기 대화 채널을 반환하고 비운다(ChatSection 전용). */
	consumePendingChatChannel(): string | null {
		const c = this.pendingChatChannel ?? null;
		this.pendingChatChannel = null;
		return c;
	}
	/** 시스템 탭을 특정 서브뷰(동기화/복구/이력/로그)로 연다. */
	async openSystemView(view: SystemView): Promise<void> {
		this.pendingSystemView = view;
		await this.activatePanel("system");
	}
	/** 보류 중 초기 시스템 서브뷰를 반환하고 비운다(SystemSection 전용). */
	consumePendingSystemView(): SystemView | null {
		const v = this.pendingSystemView ?? null;
		this.pendingSystemView = null;
		return v;
	}
	/** 로그 패널 열기(시스템 탭 → 로그 서브뷰). 진단·동기화 출력 표시용. */
	openLog(): Promise<void> {
		return this.openSystemView("log");
	}

	/**
	 * 모든 실시간 서명 토큰을 재발급/회수(교사). 전역 실시간(realtimeEnabled) + 시크릿이 있으면 모든 공유 공간과
	 * 모든 구성원 개인 mirror에 발급하고, 꺼져 있거나 시크릿이 없으면 모두 비운다(stale 재배포 방지).
	 * (유출 시 해당 공간 room만 접근 가능 — 학급 전체 아님.) 시크릿은 Secret Storage에서 읽는다.
	 */
	private mintRealtimeTokens(): Promise<void> {
		return this.realtimeCtl.mintAll();
	}

	/** 한 학생의 shares + rtconfig 문서 기록(공유 공간 멤버십 + 개인 mirror 실시간 공간). */
	private writeMemberSync(admin: CouchAdmin, st: MemberConfig): Promise<void> {
		return this.memberCtl.writeMemberSync(admin, st);
	}

	/**
	 * 현재 설정 기준으로 모든 프로비저닝된 구성원의 shares 문서를 다시 기록(교사). 공동 공간 삭제 시,
	 * 구성원이 더 이상 존재하지 않는 공유 DB를 계속 동기화하지 않도록 shares에서 제거한다.
	 */
	refreshMemberShares(): Promise<void> {
		return this.memberCtl.refreshMemberShares();
	}

	/**
	 * 실시간 토글(학생 개인 폴더/공유 공간/전체) 적용. 토큰 재발급 + 프로비저닝된 모든 학생의 shares/rtconfig
	 * 재기록 + 모드 재시작. 공유 공간을 재배포(재프로비저닝)하지 않고 실시간 설정만 전파한다.
	 */
	redeployRealtime(): Promise<void> {
		return this.deploymentCtl.redeployRealtime();
	}

	// --- 학생 온보딩: 초대 코드/딥링크로 자동 설정 ---
	ingestInvite(input: string): Promise<void> {
		return this.onboardingCtl.ingestInvite(input);
	}

	/**
	 * 초대 적용 전 확인(평가 H-3). 대상 서버·계정을 보여주고, 이미 설정된 기기는 역할·자격증명이
	 * 덮어써짐을(운영자는 더 강하게) 경고한다. 닫기만 해도 취소로 처리해 설정을 건드리지 않는다.
	 */
	private confirmInvite(payload: InvitePayload): Promise<boolean> {
		const lines = [
			t("command.invite_confirm_member_line", { name: payload.memberName || payload.memberId, id: payload.username }),
			t("command.invite_confirm_server_line", { url: payload.couchdbUrl }),
		];
		if (payload.couchdbUrl.startsWith("http://")) lines.push(t("command.invite_confirm_http_warning"));
		const configured = this.settings.setupComplete;
		if (configured) {
			const role = this.settings.role === "manager" ? t("common.manager") : t("common.member");
			lines.push(t("command.invite_confirm_overwrite_warning", { role }));
		}
		return new Promise((resolve) => {
			new ConfirmModal(this.app, {
				title: t("command.invite_confirm_title"),
				message: lines.join("\n"),
				confirmText: t("common.apply"),
				warning: configured,
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
			}).open();
		});
	}

	// --- 연결 테스트 (설정 버튼) — 항상 최신 설정으로, 역할별 DB 전체 검사 ---
	async testConnection(): Promise<void> {
		await this.openLog();
		const s = this.settings;
		// 관리자: 구성원 DB가 없어도 먼저 프로비저닝 권한(_users)을 검증한다(첫 구성원 추가 전에도 의미 있는 결과).
		if (s.role === "manager") {
			// 빈 설정에서 누르면 잘못된 요청/예외가 나므로 URL/계정/비밀번호 필수값을 먼저 확인한다.
			if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
				this.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
				return;
			}
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
			const chk = await admin.checkAdmin();
			if (chk.ok) this.logger.ok(t("command.admin_provisioning_access_ok"), true);
			else this.logger.error(chk.error ?? t("command.admin_provisioning_access_failed"), true);
		}
		const dbs =
			s.role === "manager" ? s.members.map((m) => m.remoteDb).filter((d) => d) : [s.remoteDb];
		if (dbs.length === 0) {
			this.logger.warn(t("command.no_mirror_db_to_test_manager"), true);
			return;
		}
		for (const db of dbs) await testConnection(this.core, db);
	}

	/** 종합 진단: 서버 도달 + 활성 링크별 읽기/쓰기 권한 + 실시간 상태. */
	async runDiagnostics(): Promise<void> {
		await this.openLog();
		const targets = (this.mode?.getSyncs() ?? []).map((s) => ({ db: s.remoteDb, label: s.label }));
		await runDiagnostics(this.core, targets);
		this.realtime.diagnose();
	}

	// --- 충돌 해소 (ConflictHost) → RecoveryController 위임 ---
	listConflicts(): Promise<ConflictRow[]> {
		return this.recoveryCtl.listConflicts();
	}
	resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		return this.recoveryCtl.resolveConflict(row, choice);
	}
	openConflictFiles(row: ConflictRow): Promise<void> {
		return this.recoveryCtl.openConflictFiles(row);
	}

	// --- 설정 내보내기/가져오기 (기술문서 §22.4) ---
	exportSettingsJson(): string {
		return exportSettings(this.settings);
	}

	async importSettingsJson(json: string): Promise<{ ok: boolean; error?: string }> {
		const res = importSettings(this.settings, json);
		if (!res.ok) {
			this.logger.error(t("command.failed_to_import_settings", { err: res.error }), true);
			return { ok: false, error: res.error };
		}
		this.settings = res.settings;
		this.core.settings = this.settings;
		await this.saveSettings();
		if (this.settings.setupComplete) await this.restartMode();
		this.logger.ok(t("command.settings_imported_and_applied_re_enter"), true);
		return { ok: true };
	}

	/**
	 * 서버 데이터 초기화(교사 전용, 파괴적). 모든 학생/공유 CouchDB DB를 삭제하고(선택 시 계정도),
	 * 로컬 캐시·프로비저닝 상태를 비운다. 학급 구성(목록)은 유지 → 재초대·재배포로 복구.
	 * Yjs 실시간 데이터는 플러그인이 못 지우므로 수동 안내만 표시한다.
	 */
	deleteMemberServer(member: MemberConfig): Promise<void> {
		return this.serverResetCtl.deleteMemberServer(member);
	}

	deleteSharedServer(space: SharedSpace): Promise<void> {
		return this.serverResetCtl.deleteSharedServer(space);
	}

	resetServerData(deleteAccounts: boolean): Promise<void> {
		return this.serverResetCtl.resetServerData(deleteAccounts);
	}

	/** 언어 변경 시 로케일 재초기화 + 열린 패널 새로고침(설정 탭은 호출 측에서 display). */
	refreshUiLanguage(): void {
		initI18n(this.settings.language);
		for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
			if (leaf.view instanceof CoVaultPanelView) leaf.view.refresh();
		}
	}

	/** 교사 온보딩 완료 표시(마법사 자동 노출 중단). */
	async completeOnboarding(): Promise<void> {
		this.settings.managerOnboardingDone = true;
		await this.saveSettings();
	}

	/** 플러그인 설정 탭 열기(대시보드 조치 카드 CTA용). */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	/** 설정 탭에서 초기화 모달 실행(교사 전용). */
	openResetModal(): void {
		if (this.settings.role !== "manager") {
			new Notice(t("command.covault_available_in_manager_mode"));
			return;
		}
		const dbCount =
			this.settings.members.filter((st) => st.remoteDb).length +
			this.settings.sharedSpaces.filter((sp) => sp.remoteDb).length;
		new ResetModal(this.app, dbCount, (deleteAccounts) => this.resetServerData(deleteAccounts)).open();
	}

	/** 연결/경로 설정 변경을 실행 중 엔진에 반영(재시작). */
	async restartMode(): Promise<void> {
		if (!this.settings.setupComplete) return;
		await this.mode?.stop();
		await this.startMode();
		this.logger.ok(t("command.applied_settings_and_restarted_sync"), true);
	}

	/**
	 * 구조 변경(연결·학생·공유)을 자동 적용. 잦은 변경을 모아 한 번만 재시작(타이핑 중 재연결 방지).
	 * 별도 '적용' 버튼 없이 설정 변경이 곧바로 반영되게 한다.
	 */
	requestApply(): void {
		if (!this.settings.setupComplete) return;
		if (this.applyTimer) window.clearTimeout(this.applyTimer);
		this.applyTimer = window.setTimeout(() => {
			this.applyTimer = null;
			void this.restartMode();
		}, 500);
	}

	// --- 명령 등록 (패널 버튼과 동일 메서드를 호출) ---
	private registerCommands(): void {
		registerCovaultCommands(this, {
			openPanel: () => void this.activatePanel(),
			openTab: (tab) => void this.activatePanel(tab),
			openSystemView: (view) => void this.openSystemView(view),
			cleanupClassroom: () => this.runCleanupClassroom(),
			testConnection: () => void this.testConnection(),
			runDiagnostics: () => void this.runDiagnostics(),
			fullSync: (dir) => void this.fullSync(dir),
			toggleAutoSync: () => void this.toggleAutoSync(),
			resetLocalCache: () => void this.resetLocalCache(),
			openConflicts: () => this.openConflictModal(),
			realtimeStatus: () => void this.realtimeStatus(),
			refreshShares: () => void this.refreshShares(),
			addFeedback: () => promptAddFeedback(this.app, this.feedback),
			versionHistoryPath: () => {
				const file = this.app.workspace.getActiveFile();
				return file && file.extension === "md" && this.syncForLocalPath(file.path) ? file.path : null;
			},
			openVersionHistory: (path) => new VersionHistoryModal(this.app, this, path).open(),
		});
	}

	// --- 버전 히스토리 → RecoveryController 위임 ---
	versionHistoryFor(localPath: string): Promise<VersionDoc[]> {
		return this.recoveryCtl.versionHistoryFor(localPath);
	}
	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing"> {
		return this.recoveryCtl.restoreVersion(localPath, versionDocId, opts);
	}

	// --- 패널 버튼/명령 공용 동작 (PanelHost) ---

	/** 전체/업로드/다운로드 수동 동기화. */
	async fullSync(dir: "both" | "up" | "down"): Promise<void> {
		await this.openLog();
		await this.mode?.fullSync(dir);
	}

	/** 실시간 세션 점검 + 진단 로그. */
	realtimeStatus(): Promise<void> {
		return this.realtimeCtl.realtimeStatus();
	}

	/** 공유 공간 새로고침(학생=shares 재조회, 교사=재시작). */
	async refreshShares(): Promise<void> {
		await this.openLog();
		if (this.settings.role === "member" && this.mode?.refreshShares) await this.mode.refreshShares();
		else await this.restartMode();
	}

	// --- 교사 편의: 경로(파일/폴더)를 학생에게 복사 (기술문서 §12.5 / §20). 배포 탭에서 호출. ---
	async bulkCopy(
		sourcePath: string,
		opts: CopyOptions,
		memberIds: string[],
	): Promise<CopyResult & { error?: string }> {
		const r = this.resolveCopy(sourcePath, opts, memberIds);
		if ("error" in r) return { written: 0, skipped: 0, details: [], error: r.error };
		try {
			return r.src instanceof TFolder
				? await r.bulk.copyFolder(r.src, r.targets, r.opts)
				: await r.bulk.copyFile(r.src, r.targets, r.opts);
		} catch (e) {
			return { written: 0, skipped: 0, details: [], error: errMessage(e) };
		}
	}

	/** 배포 미리보기(dry-run) — 아무것도 쓰지 않고 학생별 대상/동작 예상. 배포 탭에서 호출. */
	async bulkCopyPreview(
		sourcePath: string,
		opts: CopyOptions,
		memberIds: string[],
	): Promise<CopyPlan & { error?: string }> {
		const r = this.resolveCopy(sourcePath, opts, memberIds);
		if ("error" in r) return { members: [], error: r.error };
		try {
			return await r.bulk.preview(r.src, r.targets, r.opts);
		} catch (e) {
			return { members: [], error: errMessage(e) };
		}
	}

	/** 복사/미리보기 공통: 경로·대상 학생 해석 + 파일일 때 빈 대상경로 보정. */
	private resolveCopy(
		sourcePath: string,
		opts: CopyOptions,
		memberIds: string[],
	): { src: TFile | TFolder; targets: MemberConfig[]; bulk: BulkCopy; opts: CopyOptions } | { error: string } {
		if (this.settings.role !== "manager") return { error: t("command.available_in_manager_mode_only") };
		const src = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(src instanceof TFile) && !(src instanceof TFolder))
			return { error: t("deploy.path_not_found", { path: sourcePath }) };
		const targets = this.settings.members.filter((st) => memberIds.includes(st.memberId));
		if (targets.length === 0) return { error: t("deploy.no_target_members") };
		// 파일: 대상 경로가 비어 있으면 원본 파일명으로.
		const finalOpts = src instanceof TFile && !opts.destPath ? { ...opts, destPath: src.name } : opts;
		return { src, targets, bulk: new BulkCopy(this.app, this.settings), opts: finalOpts };
	}

	// --- 동기화 상태 · 복구 (PanelHost) → RecoveryController 위임 ---
	getDashboardRows(): Promise<DashboardRow[]> {
		return this.recoveryCtl.getDashboardRows();
	}
	openConflictModal(): void {
		new ConflictModal(this.app, this).open();
	}
	listDeletedFiles(): Promise<DeletedItem[]> {
		return this.recoveryCtl.listDeletedFiles();
	}
	restoreDeleted(remoteDb: string, dbPath: string, opts?: RestoreOptions): Promise<RestoreResult> {
		return this.recoveryCtl.restoreDeleted(remoteDb, dbPath, opts);
	}
	purgeDeleted(remoteDb: string, dbPath: string): Promise<"purged" | "skipped"> {
		return this.recoveryCtl.purgeDeleted(remoteDb, dbPath);
	}
	listDeleteModify(): Promise<DeleteModifyRow[]> {
		return this.recoveryCtl.listDeleteModify();
	}
	resolveDeleteModify(remoteDb: string, dbPath: string, choice: DeleteModifyChoice): Promise<void> {
		return this.recoveryCtl.resolveDeleteModify(remoteDb, dbPath, choice);
	}
	listRecentPurges(): Promise<PurgeRow[]> {
		return this.recoveryCtl.listRecentPurges();
	}
	undoPurge(remoteDb: string, id: string): Promise<RestoreResult> {
		return this.recoveryCtl.undoPurge(remoteDb, id);
	}
	clearPurge(remoteDb: string, id: string): Promise<void> {
		return this.recoveryCtl.clearPurge(remoteDb, id);
	}

	/** 통합 패널 활성화(우측 사이드바). tab을 주면 해당 탭으로 전환. */
	async activatePanel(tab?: PanelTab): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: PANEL_VIEW_TYPE, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		// Deferred views: revealLeaf가 로드를 트리거하지만 view가 즉시 CoVaultPanelView로
		// 바뀌지 않을 수 있다(차가운 리프). 탭 전환이 필요할 때만 명시적으로 로드를 보장한다.
		if (tab) {
			await leaf.loadIfDeferred?.();
			if (leaf.view instanceof CoVaultPanelView) leaf.view.setTab(tab);
		}
	}

	/** 로컬 경로를 담당하는 동기화 링크(피드백 저장/조회 + 실시간 스냅샷 대상). 없으면 undefined. */
	private syncForLocalPath(localPath: string): MirrorSync | undefined {
		return this.mode?.findSyncOwning(localPath);
	}

	/** autoSync 토글 — 모드를 재시작해 감시/구독을 켜거나 끈다. */
	async toggleAutoSync(): Promise<void> {
		this.settings.autoSync = !this.settings.autoSync;
		await this.saveSettings();
		this.logger.info(t("panel.auto_sync", { state: this.settings.autoSync ? t("common.on") : t("common.off") }), true);
		if (this.settings.setupComplete) {
			await this.mode?.stop();
			await this.startMode();
		}
	}

	// --- 백그라운드 동기화 일시정지 (모바일 배터리/네트워크 절감) ---
	private onVisibilityChange(): void {
		if (!this.settings.pauseWhenHidden) return;
		const hidden = document.hidden;
		for (const sync of this.mode?.getSyncs() ?? []) {
			if (hidden) sync.pauseReplication();
			else sync.resumeReplication();
		}
	}

	// --- 실시간 상태바 ---
	private onWorkspaceChange(): void {
		this.realtime?.syncOpenEditors();
		this.updateRtStatus();
	}

	private updateRtStatus(): void {
		if (!this.rtStatus) return;
		const file = this.app.workspace.getActiveFile();
		const n = file ? this.realtime.presenceFor(file.path) : 0;
		this.rtStatus.setText(n > 0 ? t("command.realtime", { n }) : "");
	}
}
