import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { registerCommands as registerCovaultCommands } from "./commands";
import { CoVaultSettings, DEFAULT_SETTINGS, Role, MemberConfig, SharedSpace, GroupConfig } from "./settings/types";
import { localizeDefaultFolders } from "./settings/localizeDefaults";
import { CoVaultSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { CoVaultMode } from "./modes/CoVaultMode";
import { MemberMode } from "./modes/member/MemberMode";
import { ManagerMode } from "./modes/manager/ManagerMode";
import { TFile } from "obsidian";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { VersionHistoryModal } from "./ui/VersionHistoryModal";
import { SetupWizardModal } from "./ui/SetupWizardModal";
import { RealtimeManager } from "./core/realtime/RealtimeManager";
import { getCouchPassword, migratePlaintextTokens } from "./core/secret";
import { realtimeEditorExtension } from "./core/realtime/editorBinding";
import { FeedbackStore } from "./core/feedback/FeedbackStore";
import { ClassroomStore } from "./core/classroom/ClassroomStore";
import { ClassroomControllers, buildClassroomControllers } from "./modes/classroom";
import { PluginDeployController } from "./modes/PluginDeployController";
import { confirmPluginInstall } from "./ui/PluginInstallModal";
import { RealtimeController } from "./modes/RealtimeController";
import { MemberController } from "./modes/MemberController";
import { GroupRequestController } from "./modes/GroupRequestController";
import { RecoveryController } from "./modes/RecoveryController";
import { ParticipantController } from "./modes/ParticipantController";
import { DeploymentController } from "./modes/DeploymentController";
import { ServerResetController } from "./modes/ServerResetController";
import { RepairController } from "./modes/RepairController";
import { OnboardingController } from "./modes/OnboardingController";
import { PouchService } from "./core/couch/PouchService";
import { promptAddFeedback } from "./ui/FeedbackView";
import { CoVaultPanelView, PANEL_VIEW_TYPE } from "./ui/PanelView";
import { PanelNavigator, buildPanelHost } from "./panelHost";
import { PanelHost } from "./ui/panel/PanelSection";
import { MirrorSync } from "./core/sync/MirrorSync";
import { testConnection } from "./core/sync/connectionTest";
import { runDiagnostics } from "./core/sync/diagnostics";
import { CouchAdmin } from "./core/couch/CouchAdmin";
import { INVITE_ACTION } from "./core/invite/invite";
import { confirm } from "./ui/ConfirmModal";
import { exportSettings, importSettings } from "./settings/portable";
import { ResetModal } from "./ui/ResetModal";
import { currentLocale, initI18n, t } from "./i18n";

/**
 * CoVault for Obsidian — 플러그인 진입점.
 *
 * 역할은 최초 1회 선택 후 잠긴다(기술문서 §5.4 보강). 실행 시 저장된 last_seq부터 증분 재개하고,
 * 전체 동기화는 최초 1회와 수동 명령에서만 수행한다.
 */
export default class CoVaultPlugin extends Plugin implements SettingsHost {
	settings!: CoVaultSettings;
	logger = new Logger();
	private core!: CoreServices;
	private mode: CoVaultMode | null = null;
	private realtime!: RealtimeManager;
	private rtStatus!: HTMLElement;
	private feedback!: FeedbackStore;
	private classroom!: ClassroomStore;
	private classroomCtls!: ClassroomControllers; // 학급 운영 도메인 컨트롤러 4종(평가 P2-3 분할)
	private nav!: PanelNavigator; // 패널 활성화 + 보류 채널/서브뷰 상태(panelHost.ts)
	private panelHost!: PanelHost; // 컨트롤러들로 조립된 PanelHost(buildPanelHost) — 뷰/마법사에 주입
	private realtimeCtl!: RealtimeController;
	private memberCtl!: MemberController;
	private recoveryCtl!: RecoveryController;
	private participantCtl!: ParticipantController;
	private deploymentCtl!: DeploymentController;
	private groupRequestCtl!: GroupRequestController;
	private pluginDeployCtl!: PluginDeployController;
	private groupRequestTimer: number | null = null; // grouprequest 변경 → 교사 처리 debounce
	private serverResetCtl!: ServerResetController;
	private repairCtl!: RepairController;
	private onboardingCtl!: OnboardingController;
	private applyTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		initI18n(this.settings.language); // 모든 t() 이전에 로케일 확정

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);
		this.nav = new PanelNavigator(this.app); // 컨트롤러 deps(openLog 등)가 참조 — 최상단에서 생성

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
			openLog: () => this.nav.openLog(),
		});
		this.memberCtl = new MemberController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			couchPassword: () => this.couchPassword(),
			saveSettings: () => this.saveSettings(),
			requestApply: () => this.requestApply(),
			openLog: () => this.nav.openLog(),
			mintMirror: (m) => this.realtimeCtl.mintMirror(m),
			mintMemberToken: (sp, memberId) => this.realtimeCtl.mintMemberToken(sp, memberId),
			redeployValidate: (opts) => this.deploymentCtl.redeployValidate(opts),
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
		this.classroomCtls = buildClassroomControllers({
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
			openLog: () => this.nav.openLog(),
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
			openLog: () => this.nav.openLog(),
			openDashboard: () => this.nav.activatePanel("dashboard"),
			writeMemberSync: (admin, m) => this.writeMemberSync(admin, m),
			mintRealtimeTokens: () => this.mintRealtimeTokens(),
			refreshMemberShares: () => this.refreshMemberShares(),
			testDb: (db) => testConnection(this.core, db),
		});
		this.groupRequestCtl = new GroupRequestController({
			logger: this.logger,
			classroom: this.classroom,
			settings: () => this.settings,
			homeroomReady: () => this.homeroomReady(),
			saveSettings: () => this.saveSettings(),
			deployShared: (space, opts) => this.deploymentCtl.deployShared(space, opts),
			syncGroupDoc: (g, names) => this.classroomCtls.messageCtl.syncGroupDoc(g, names),
			deleteGroupDoc: (id) => this.classroomCtls.messageCtl.deleteGroupDoc(id),
			groupChannelFor: (id) => this.classroomCtls.messageCtl.groupChannelFor(id),
			openChat: (ch) => this.nav.openChat(ch),
			deleteSharedServer: (space) => this.serverResetCtl.deleteSharedServer(space),
			refreshMemberShares: () => this.refreshMemberShares(),
			restartMode: () => this.restartMode(),
		});
		this.pluginDeployCtl = new PluginDeployController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			classroom: this.classroom,
			confirmInstall: (doc) => confirmPluginInstall(this.app, doc),
		});
		this.serverResetCtl = new ServerResetController({
			logger: this.logger,
			settings: () => this.settings,
			couchPassword: () => this.couchPassword(),
			saveSettings: () => this.saveSettings(),
			openLog: () => this.nav.openLog(),
			stopMode: async () => {
				await this.mode?.stop();
				this.mode = null;
			},
			startMode: () => this.startMode(),
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
		this.repairCtl = new RepairController({
			app: this.app,
			logger: this.logger,
			settings: () => this.settings,
			getSyncs: () => this.mode?.getSyncs() ?? [],
			openLog: () => this.nav.openLog(),
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
			destroyLocalCaches: () => this.serverResetCtl.destroyAllLocalCaches(),
			openLog: () => this.nav.openLog(),
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
			confirm: (opts) => confirm(this.app, opts),
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
		// 함께 쓰는 플러그인 배포 수신(구성원) → 설치 안내. 교사는 배포 패널이 폴링으로 갱신.
		this.core.onPluginDeployChange = () => {
			if (this.settings.role === "member") void this.pluginDeployCtl.handleIncoming();
		};
		// 알림장·수업은 편집창 + 프론트매터로 작성한다 — 파일 프론트매터 변경/삭제/이름변경을 게시 메타에 반영(교사).
		this.registerEvent(this.app.metadataCache.on("changed", (file) => { if (file instanceof TFile) void this.classroomCtls.noticeCtl.syncNoticeFromFile(file); }));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile)) return;
			void this.classroomCtls.noticeCtl.onNoticeFileDeleted(file.path);
			void this.participantCtl.onFileDeleted(file.path); // 실시간 지정 문서 정리
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			void this.classroomCtls.noticeCtl.onNoticeFileRenamed(file, oldPath);
			void this.participantCtl.onFileRenamed(oldPath, file.path); // 실시간 지정 문서 이전
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onWorkspaceChange()));
		this.rtStatus = this.addStatusBarItem();
		this.registerInterval(window.setInterval(() => this.updateRtStatus(), 2000));

		// 백그라운드(앱/창 비활성) 시 원격 동기화 일시정지 → 배터리/네트워크 절감(기술문서 §24.6)
		this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());

		// PanelHost 조립(M-12) — 워크스페이스 복원이 onload 직후 뷰를 만들 수 있으므로 registerView보다 먼저.
		this.panelHost = buildPanelHost({
			app: this.app,
			logger: this.logger,
			nav: this.nav,
			feedback: this.feedback,
			classroom: this.classroom,
			settings: () => this.settings,
			...this.classroomCtls, // noticeCtl·assignmentCtl·routineCtl·messageCtl (PanelHostDeps와 1:1)
			participantCtl: this.participantCtl,
			recoveryCtl: this.recoveryCtl,
			groupRequestCtl: this.groupRequestCtl,
			deploymentCtl: this.deploymentCtl,
			realtimeCtl: this.realtimeCtl,
			serverResetCtl: this.serverResetCtl,
			memberCtl: this.memberCtl,
			pluginDeployCtl: this.pluginDeployCtl,
			homeroomReady: () => this.homeroomReady(),
			homeroomConfigured: () => this.homeroomConfigured(),
			// 공동 공간 폴더만(개인 mirror 제외 — 교사 측 mirror는 folder가 멤버 localRoot라 빈문자 필터로 못 거름). 대화 위키링크 후보 제한.
			sharedFolders: () => this.core.sharedSpaces.filter((sp) => sp.kind !== "mirror" && sp.folder !== "").map((sp) => sp.folder),
			saveSettings: () => this.saveSettings(),
			openSettings: () => this.openSettings(),
			completeOnboarding: () => this.completeOnboarding(),
			fullSync: (dir) => this.fullSync(dir),
			toggleAutoSync: () => this.toggleAutoSync(),
			refreshShares: () => this.refreshShares(),
			runDiagnostics: () => this.runDiagnostics(),
			openResetModal: () => this.openResetModal(),
			repairSharedConsistency: () => this.repairCtl.repairSharedConsistency(),
		});
		this.registerView(PANEL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CoVaultPanelView(leaf, this.panelHost));
		this.addSettingTab(new CoVaultSettingTab(this.app, this));
		// 아이콘은 학급 전용(학사모)이 아닌 제품 정체성(공유 금고) 기준 — 볼트 공유·동기화·실시간 편집 전반에 쓰인다.
		this.addRibbonIcon("vault", t("command.open_covault_panel"), () => this.nav.activatePanel());
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
		// data.json에 평문으로 남은 실시간 베어러 토큰을 Secret Storage로 1회 이전(평가 S-1).
		if (migratePlaintextTokens(this.app, this.settings)) await this.saveSettings();
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
		void this.classroomCtls.messageCtl.cleanupLegacyGroups(); // 0.100.x 파일별 그룹 문서 정리(드롭다운 유령 제거)
		if (this.settings.role === "member") void this.pluginDeployCtl.handleIncoming(); // 시작 시 미처리 플러그인 배포 안내
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

	inviteDevice(member: MemberConfig): Promise<boolean> {
		return this.memberCtl.inviteDevice(member);
	}

	revokeDevice(member: MemberConfig, username: string): Promise<boolean> {
		return this.memberCtl.revokeDevice(member, username);
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
		return h ? this.mode?.findSyncByDb(h.remoteDb)?.ctx.pouch : undefined;
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
		return this.settings.role === "manager" ? this.settings.sharedSpaces.some((sp) => sp.kind === "homeroom") : !!this.core.homeroom;
	}

	// --- 실시간 참여 게이트/파일별 참여자/읽기전용 → ParticipantController 위임 ---
	realtimeTokenReceived(): boolean {
		return this.participantCtl.realtimeTokenReceived();
	}
	setSharedReadOnly(on: boolean): Promise<void> {
		return this.participantCtl.setSharedReadOnly(on);
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
		new SetupWizardModal(this.app, this.panelHost).open();
	}
	createTemplateFile(kind: "notice" | "lesson" | "assignment"): Promise<void> {
		return this.classroomCtls.noticeCtl.createTemplateFile(kind);
	}
	cleanupClassroomDocs(): Promise<{ duplicates: number; orphans: number; danglingLinks: number; orphanAssignments: number }> {
		return this.classroomCtls.noticeCtl.cleanupClassroomDocs();
	}
	/** 명령용: 로그 패널을 열고 중복/고아 학급 문서 정리 실행(결과는 로그에 표시). */
	private async runCleanupClassroom(): Promise<void> {
		await this.nav.openLog();
		await this.cleanupClassroomDocs();
	}
	saveGroup(group: GroupConfig): Promise<void> {
		return this.groupRequestCtl.saveGroup(group);
	}
	deleteGroup(id: string): Promise<void> {
		return this.groupRequestCtl.deleteGroup(id);
	}
	openGroupChat(groupId: string): Promise<void> {
		return this.groupRequestCtl.openGroupChat(groupId);
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
	ingestInvite(input: string): Promise<void> { return this.onboardingCtl.ingestInvite(input); }

	// --- 연결 테스트 (설정 버튼) → DeploymentController 위임 ---
	testConnection(): Promise<void> { return this.deploymentCtl.testConnection(); }

	/** 종합 진단: 서버 도달 + 활성 링크별 읽기/쓰기 권한 + 실시간 상태. */
	async runDiagnostics(): Promise<void> {
		await this.nav.openLog();
		const targets = (this.mode?.getSyncs() ?? []).map((s) => ({ db: s.remoteDb, label: s.label }));
		await runDiagnostics(this.core, targets);
		this.realtime.diagnose();
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
	deleteMemberServer(member: MemberConfig): Promise<void> { return this.serverResetCtl.deleteMemberServer(member); }
	deleteSharedServer(space: SharedSpace): Promise<void> { return this.serverResetCtl.deleteSharedServer(space); }
	resetServerData(deleteAccounts: boolean): Promise<void> { return this.serverResetCtl.resetServerData(deleteAccounts); }

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
			openPanel: () => void this.nav.activatePanel(),
			openTab: (tab) => void this.nav.activatePanel(tab),
			openSystemView: (view) => void this.nav.openSystemView(view),
			cleanupClassroom: () => this.runCleanupClassroom(),
			testConnection: () => void this.testConnection(),
			runDiagnostics: () => void this.runDiagnostics(),
			fullSync: (dir) => void this.fullSync(dir),
			toggleAutoSync: () => void this.toggleAutoSync(),
			resetLocalCache: () => void this.panelHost.resetLocalCache(),
			repairSharedConsistency: () => void this.repairCtl.repairSharedConsistency(),
			openConflicts: () => this.panelHost.openConflictModal(),
			realtimeStatus: () => void this.realtimeStatus(),
			refreshShares: () => void this.refreshShares(),
			addFeedback: () => promptAddFeedback(this.app, this.feedback),
			versionHistoryPath: () => {
				const file = this.app.workspace.getActiveFile();
				return file && file.extension === "md" && this.syncForLocalPath(file.path) ? file.path : null;
			},
			openVersionHistory: (path) => new VersionHistoryModal(this.app, this.recoveryCtl, path).open(),
		});
	}

	// --- 패널 버튼/명령 공용 동작 (PanelHost) ---

	/** 전체/업로드/다운로드 수동 동기화. */
	async fullSync(dir: "both" | "up" | "down"): Promise<void> {
		await this.nav.openLog();
		await this.mode?.fullSync(dir);
	}

	/** 실시간 세션 점검 + 진단 로그. */
	realtimeStatus(): Promise<void> {
		return this.realtimeCtl.realtimeStatus();
	}

	/** 공유 공간 새로고침(학생=shares 재조회, 교사=재시작). */
	async refreshShares(): Promise<void> {
		await this.nav.openLog();
		if (this.settings.role === "member" && this.mode?.refreshShares) await this.mode.refreshShares();
		else await this.restartMode();
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
		if (!hidden) this.mode?.onVisibility?.(false); // 감지 연결을 먼저 재시작(이후 캐치업이 공백 흡수)
		for (const sync of this.mode?.getSyncs() ?? []) {
			if (hidden) sync.pauseReplication();
			else sync.resumeReplication();
		}
		if (hidden) this.mode?.onVisibility?.(true);
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
