import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CoVaultSettings, DEFAULT_SETTINGS, Role, MemberConfig, SharedSpace } from "./settings/types";
import { SHARES_DOC_ID, RTCONFIG_DOC_ID, VersionDoc, SharesDoc, NoticeDoc, noticeId, ResponseDoc, responseId } from "./core/model/types";
import { AssignmentDoc, AssignmentStateDoc, AssignmentGrade, assignmentId, assignmentStateId, ASSIGNMENT_STATE_ID_PREFIX } from "./core/model/types";
import { RoutineDoc, RoutineStateDoc, routineId, routinePrefix, routineStateId, routineStatePrefix } from "./core/model/types";
import { ensureParentFolders } from "./core/vault/folders";
import { noticeFilePath } from "./core/classroom/notices";
import { assignmentWorkDir, substituteTemplate, slugify } from "./core/classroom/assignments";
import { VersionStore } from "./core/sync/VersionStore";
import { CoVaultSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { CoVaultMode } from "./modes/CoVaultMode";
import { MemberMode } from "./modes/member/MemberMode";
import { ManagerMode } from "./modes/manager/ManagerMode";
import { TFile, TFolder } from "obsidian";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { InviteModal } from "./ui/InviteModal";
import { ConflictModal, ConflictRow, ConflictHost } from "./ui/ConflictModal";
import { VersionHistoryModal } from "./ui/VersionHistoryModal";
import { ResolveChoice } from "./core/sync/ConflictManager";
import { BulkCopy, CopyOptions, CopyResult, CopyPlan } from "./modes/manager/BulkCopy";
import { RealtimeManager } from "./core/realtime/RealtimeManager";
import { mintSpaceToken } from "./core/realtime/spaceToken";
import { isValidCouchName } from "./core/path/path";
import {
	getSecretValue,
	setSecretValue,
	hasSecretStorage,
	YJS_SECRET_ID,
	YJS_TOKEN_ID,
	COUCH_PASSWORD_ID,
	getMemberPassword,
	setMemberPassword,
} from "./core/secret";
import { realtimeEditorExtension } from "./core/realtime/editorBinding";
import { FeedbackStore } from "./core/feedback/FeedbackStore";
import { ClassroomStore } from "./core/classroom/ClassroomStore";
import { ensureHomeroomSpace, HOMEROOM_FOLDER, HOMEROOM_DB } from "./core/classroom/homeroom";
import { PouchService } from "./core/couch/PouchService";
import { promptAddFeedback } from "./ui/FeedbackView";
import { CoVaultPanelView, PANEL_VIEW_TYPE } from "./ui/PanelView";
import { PanelHost, PanelTab, DashboardRow, DeleteModifyRow, PurgeRow } from "./ui/panel/PanelSection";
import { MirrorSync } from "./core/sync/MirrorSync";
import { DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "./core/sync/RestoreManager";
import { testConnection } from "./core/sync/connectionTest";
import { runDiagnostics } from "./core/sync/diagnostics";
import { CouchAdmin } from "./core/couch/CouchAdmin";
import { InvitePayload, INVITE_ACTION, genPassword, parseInvite, isInviteExpired } from "./core/invite/invite";
import { exportSettings, importSettings } from "./settings/portable";
import { ResetModal } from "./ui/ResetModal";
import { initI18n, t } from "./i18n";

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
		this.migrateSecrets(); // 평문 yjsSecret/yjsToken을 Secret Storage로 1회 이전(교사)
		this.migrateCouchPassword(); // 평문 CouchDB 비밀번호(활성 + 학생별)를 Secret Storage로 1회 이전

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);

		// 실시간 공동 편집(Yjs) — 공유 폴더 문서
		this.realtime = new RealtimeManager(
			this.app,
			this.core,
			() => this.core.sharedSpaces,
			(p) => this.syncForLocalPath(p), // 주기적 스냅샷 쓰기 대상
		);
		this.core.isRealtimeActive = (p) => this.realtime.isActive(p);
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
		this.core.onClassroomChange = () => this.classroom.refresh();
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onWorkspaceChange()));
		this.rtStatus = this.addStatusBarItem();
		this.registerInterval(window.setInterval(() => this.updateRtStatus(), 2000));

		// 백그라운드(앱/창 비활성) 시 원격 동기화 일시정지 → 배터리/네트워크 절감(기술문서 §24.6)
		this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());

		this.registerView(PANEL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new CoVaultPanelView(leaf, this));
		this.addSettingTab(new CoVaultSettingTab(this.app, this));
		this.addRibbonIcon("graduation-cap", t("command.open_covault_panel"), () => this.activatePanel());
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
		await this.realtime?.dispose();
		await this.mode?.stop();
		await this.core?.flushPersist();
		this.core?.dispose();
	}

	// --- 설정 ---
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/** 교사의 평문 Yjs 비밀값을 Secret Storage로 1회 이전하고 data.json에서 제거(평문 노출 방지). */
	private migrateSecrets(): void {
		if (this.settings.role !== "manager" || !hasSecretStorage(this.app)) return;
		let changed = false;
		if (this.settings.yjsSecret) {
			setSecretValue(this.app, YJS_SECRET_ID, this.settings.yjsSecret);
			this.settings.yjsSecretSet = true;
			this.settings.yjsSecret = undefined;
			changed = true;
		}
		if (this.settings.yjsToken) {
			setSecretValue(this.app, YJS_TOKEN_ID, this.settings.yjsToken);
			this.settings.yjsTokenSet = true;
			this.settings.yjsToken = "";
			changed = true;
		}
		if (changed) void this.saveSettings();
	}

	/** 평문 CouchDB 비밀번호를 Secret Storage로 1회 이전(교사 admin/학생 본인 + 교사 보유 학생별). data.json 평문 제거. */
	private migrateCouchPassword(): void {
		if (!hasSecretStorage(this.app)) return;
		const s = this.settings;
		let changed = false;
		if (s.password) {
			if (setSecretValue(this.app, COUCH_PASSWORD_ID, s.password)) {
				s.passwordSet = true;
				s.password = "";
				changed = true;
			}
		}
		for (const st of s.members) {
			if (st.password && st.memberId && setMemberPassword(this.app, st.memberId, st.password)) {
				st.password = undefined;
				changed = true;
			}
		}
		if (changed) void this.saveSettings();
	}

	/** 활성 CouchDB 비밀번호(Secret Storage 우선, 평문 폴백). */
	private couchPassword(): string {
		return getSecretValue(this.app, COUCH_PASSWORD_ID, this.settings.password);
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
	}

	/** 최초 실행 역할 선택 모달 → 역할 잠금 + 모드 시작. 학생은 초대 코드로 바로 설정 가능. */
	private promptRoleSetup(): void {
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
				// 교사는 온보딩 마법사를 자동으로 띄운다(이미 완료/닫았으면 생략).
				if (role === "manager" && !this.settings.managerOnboardingDone) await this.activatePanel("setup");
			},
			(code) => void this.ingestInvite(code),
		).open();
	}

	/** 역할 재설정(데이터 초기화). 설정 탭에서 호출. 로컬 캐시까지 비운다. */
	async resetSetup(): Promise<void> {
		await this.mode?.stop();
		this.mode = null;
		await this.destroyLocalCaches();
		this.settings.setupComplete = false;
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		this.logger.warn(t("command.reset_the_role_sync_state_and"), true);
		this.promptRoleSetup();
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
				this.logger.error(t("command.failed_to_delete_local_cache", { db, err: e instanceof Error ? e.message : String(e) }));
			}
		}
	}

	/** 로컬 캐시 초기화 후 서버에서 다시 받기. 명령에서 호출. */
	async resetLocalCache(): Promise<void> {
		await this.activatePanel("log");
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
	async inviteMember(member: MemberConfig): Promise<boolean> {
		await this.activatePanel("log");
		const s = this.settings;
		const adminPw = this.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) {
			this.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return false;
		}
		if (!member.memberId) {
			this.logger.warn(t("command.enter_a_member_id"), true);
			return false;
		}
		// 기본값 보정
		if (!member.username) member.username = member.memberId;
		if (!member.remoteDb) member.remoteDb = `mirror_${member.memberId}`;
		if (!member.localRoot) member.localRoot = member.memberName || member.memberId;
		// CouchDB 이름 규칙 위반은 프로비저닝 HTTP 에러 전에 막는다(보고서 P2).
		if (!isValidCouchName(member.memberId) || !isValidCouchName(member.username) || !isValidCouchName(member.remoteDb)) {
			this.logger.warn(t("command.invalid_id_or_db_name", { id: member.memberId }), true);
			return false;
		}
		// 학생 비밀번호: Secret Storage 우선 → 평문 폴백 → 없으면 생성.
		let memberPw = getMemberPassword(this.app, member.memberId, member.password);
		if (!memberPw) memberPw = genPassword();

		this.logger.info(t("command.provisioning_member", { id: member.memberId, db: member.remoteDb }));
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		const res = await admin.provisionMember({
			username: member.username,
			password: memberPw,
			remoteDb: member.remoteDb,
		});
		if (!res.ok) {
			this.logger.error(t("command.provisioning_failed", { err: res.error ?? "" }), true);
			return false;
		}
		// 성공 → Secret Storage 보관 + 평문 클리어(미지원 환경은 평문 폴백 유지).
		if (setMemberPassword(this.app, member.memberId, memberPw)) member.password = undefined;
		else member.password = memberPw;
		member.provisioned = true;
		// 실시간/공유 설정을 학생 DB에 기록(개인 mirror 실시간 토큰 포함) — 공유 공간 배포 없이도 실시간이 동작.
		await this.mintMirrorToken(member);
		await this.saveSettings();
		await this.writeMemberSync(admin, member);
		this.requestApply(); // 새 학생 링크를 자동으로 동기화에 반영
		this.logger.ok(t("command.provisioning_complete_account_db_permissions", { id: member.memberId }), true);

		const iat = Math.floor(Date.now() / 1000);
		const ttlDays = s.inviteTtlDays ?? 0;
		const payload: InvitePayload = {
			v: 1,
			couchdbUrl: s.couchdbUrl,
			workspaceId: s.workspaceId,
			memberId: member.memberId,
			memberName: member.memberName,
			remoteDb: member.remoteDb,
			username: member.username,
			password: memberPw,
			iat,
			...(ttlDays > 0 ? { exp: iat + ttlDays * 86400 } : {}),
		};
		new InviteModal(this.app, payload).open();
		return true;
	}

	/**
	 * 학생 비밀번호 재발급(회전). 새 비밀번호로 _users를 갱신하므로 **이전 초대 코드는 즉시 무효**가 된다.
	 * 잃어버린/유출된 초대를 폐기하는 용도. 새 초대 코드를 바로 보여준다.
	 *
	 * 서버 갱신이 실패하면 로컬 비밀번호를 이전 값으로 되돌려, 로컬만 새 비밀번호로 바뀐 불일치를 막는다.
	 */
	async rotateMemberPassword(member: MemberConfig): Promise<void> {
		if (this.settings.role !== "manager") return;
		if (!member.memberId) {
			this.logger.warn(t("command.enter_a_member_id"), true);
			return;
		}
		const prev = getMemberPassword(this.app, member.memberId, member.password);
		const next = genPassword();
		// 새 비밀번호를 먼저 보관(inviteMember가 Secret Storage/평문에서 읽으므로) → 재프로비저닝.
		if (!setMemberPassword(this.app, member.memberId, next)) member.password = next;
		this.logger.info(t("invite.reissuing_password_previous_invite_invalidated", { id: member.memberId }), true);
		const ok = await this.inviteMember(member); // 재프로비저닝(_users 갱신) + 새 초대 표시
		if (!ok) {
			// 서버 실패 → 이전 비밀번호로 되돌림(이전 초대 유지).
			if (!setMemberPassword(this.app, member.memberId, prev)) member.password = prev;
			else member.password = undefined;
			this.logger.warn(t("invite.password_reissue_failed_keeping_the_previous"), true);
		}
	}

	// --- 공유 공간 배포 (Manager) ---
	async deployShared(space: SharedSpace): Promise<void> {
		await this.activatePanel("log");
		const s = this.settings;
		if (s.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
			this.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		if (!space.remoteDb) space.remoteDb = `share_${space.id}`;
		if (!space.folder) space.folder = space.name || space.id;
		if (!isValidCouchName(space.remoteDb)) {
			this.logger.warn(t("command.invalid_share_db_name", { db: space.remoteDb }), true);
			return;
		}

		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
		const memberUsers = space.members
			.map((sid) => s.members.find((st) => st.memberId === sid)?.username)
			.filter((u): u is string => !!u);

		this.logger.info(t("command.deploying_shared_space_members", { name: space.name, db: space.remoteDb, count: memberUsers.length }));
		const res = await admin.provisionSharedSpace(space.remoteDb, memberUsers);
		if (!res.ok) {
			this.logger.error(t("command.shared_space_provisioning_failed", { err: res.error ?? "" }), true);
			return;
		}
		space.provisioned = true;
		space.lastDeployedAt = Date.now();
		space.lastMemberSnapshot = [...space.members].sort();

		// 배포 때마다 모든 실시간 토큰을 재발급한다(공유: realtime 플래그, 개인 mirror: member.realtime).
		// 이 배포에서 모든 학생의 shares가 다시 기록되므로, 시크릿/멤버/플래그 변경 시 구 토큰 재유출을 막는다.
		await this.mintRealtimeTokens();
		await this.saveSettings();

		// 모든 학생의 shares + rtconfig 문서 갱신(추가/제거 학생 모두 반영)
		for (const st of s.members) await this.writeMemberSync(admin, st);

		this.logger.ok(t("command.shared_space_deployment_complete", { name: space.name }), true);
		await this.restartMode();
	}

	/**
	 * 학급 공유 공간의 pouch(미프로비저닝/미수신이면 undefined). 고정 DB명(HOMEROOM_DB)으로 현재 모드의
	 * 동기화 링크에서 해석한다 — 교사(설정의 sharedSpaces)·학생(수신한 shares) 양쪽 모두 동작.
	 */
	private homeroomPouch(): PouchService | undefined {
		return (this.mode?.getSyncs() ?? []).find((s) => s.ctx.remoteDb === HOMEROOM_DB)?.ctx.pouch;
	}

	/** PanelHost: 학급 공유 공간이 준비됐는지(배포 + 동기화 링크 존재). */
	homeroomReady(): boolean {
		return !!this.homeroomPouch();
	}

	/** PanelHost: 학급(homeroom) 공유 공간을 만들고(전원 멤버) 배포한다. 교사 전용. */
	async ensureHomeroom(): Promise<void> {
		if (this.settings.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		const memberIds = this.settings.members.filter((m) => m.memberId && m.provisioned).map((m) => m.memberId);
		const { space, spaces } = ensureHomeroomSpace(this.settings.sharedSpaces, memberIds, t("dashboard.homeroom_name"));
		this.settings.sharedSpaces = spaces;
		await this.saveSettings();
		await this.deployShared(space); // 프로비저닝 + 전원 shares 갱신 + 모드 재시작
	}

	/** 게시 본문 파일 + NoticeDoc 생성(교사). 성공 시 uid, 실패 시 null. */
	private async createPost(title: string, body: string, category: "notice" | "lesson"): Promise<string | null> {
		if (this.settings.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return null;
		}
		if (!this.homeroomReady()) {
			this.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return null;
		}
		const ts = Date.now();
		const path = noticeFilePath(HOMEROOM_FOLDER, ts, title, category === "lesson" ? "수업" : "알림장");
		await ensureParentFolders(this.app, path);
		if (this.app.vault.getAbstractFileByPath(path)) {
			this.logger.warn(t("dashboard.notice_file_exists"), true);
			return null;
		}
		await this.app.vault.create(path, `# ${title}\n\n${body}\n`);
		const uid = `${ts.toString(36)}`;
		const doc: NoticeDoc = {
			_id: noticeId(uid),
			type: "notice",
			schemaVersion: 1,
			workspaceId: this.settings.workspaceId,
			uid,
			title,
			filePath: path,
			postedAtMs: ts,
			allowResponses: true,
			category,
			createdBy: this.settings.userId,
			createdByRole: "manager",
		};
		const ok = await this.classroom.put(doc);
		if (!ok) return null;
		this.logger.ok(t("dashboard.notice_posted", { title }), true);
		return uid;
	}

	/** PanelHost: 게시(교사). 본문 마크다운 파일을 학급 폴더에 만들고 NoticeDoc 메타를 학급 공유에 기록. */
	async postNotice(title: string, body: string, category: "notice" | "lesson" = "notice"): Promise<boolean> {
		return (await this.createPost(title, body, category)) != null;
	}

	/** PanelHost: 수업 안내 생성(교사). 성공 시 uid 반환(시간표 칸 연결용). */
	async createLesson(title: string): Promise<string | null> {
		return this.createPost(title, "", "lesson");
	}

	/** PanelHost: 수업 안내(uid) 열기. 본문 파일을 열고, 학생이면 읽음 처리. */
	async openLesson(uid: string): Promise<void> {
		const doc = await this.classroom.get<NoticeDoc>(noticeId(uid));
		if (!doc) return;
		await this.openVaultPath(doc.filePath);
		if (this.settings.role === "member") {
			const now = Date.now();
			const r: ResponseDoc = {
				_id: responseId(doc._id, this.settings.userId, "read"),
				type: "response",
				schemaVersion: 1,
				workspaceId: this.settings.workspaceId,
				targetId: doc._id,
				kind: "read",
				byUser: this.settings.userId,
				byRole: "member",
				createdAtMs: now,
			};
			await this.classroom.put(r);
		}
	}

	// --- 과제(assignments) ---

	/** PanelHost: 교사 과제 정의 목록(설정 보관). */
	assignmentDefs(): AssignmentDoc[] {
		return this.settings.assignments ?? [];
	}

	private memberSyncByRemoteDb(db: string): MirrorSync | undefined {
		return (this.mode?.getSyncs() ?? []).find((s) => s.ctx.remoteDb === db);
	}
	private studentMirrorSync(): MirrorSync | undefined {
		return this.memberSyncByRemoteDb(this.settings.remoteDb);
	}
	private async readVaultText(path: string): Promise<string | null> {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? await this.app.vault.read(f) : null;
	}
	private async writeFileIfAbsent(path: string, body: string): Promise<void> {
		await ensureParentFolders(this.app, path);
		if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, body);
	}

	/** PanelHost: 과제 생성 + 배포(교사). */
	async createAssignment(input: {
		title: string;
		instructions: string;
		dueAt?: number;
		points?: number;
		privacy: "mirror" | "shared";
		targetMembers: string[];
		templatePath?: string;
		rubric?: import("./core/model/types").RubricCriterion[];
	}): Promise<boolean> {
		const s = this.settings;
		if (s.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
			this.logger.warn(t("command.enter_the_admin_account_first"), true);
			return false;
		}
		if (input.privacy === "shared" && !this.homeroomReady()) {
			this.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return false;
		}
		const uid = `${Date.now().toString(36)}`;
		const def: AssignmentDoc = {
			_id: assignmentId(uid),
			type: "assignment",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			uid,
			title: input.title,
			instructions: input.instructions,
			templatePaths: input.templatePath ? [input.templatePath] : [],
			privacy: input.privacy,
			targetMembers: [...input.targetMembers],
			dueAt: input.dueAt,
			points: input.points,
			rubric: input.rubric && input.rubric.length > 0 ? input.rubric : undefined,
			createdBy: s.userId,
			createdAtMs: Date.now(),
		};
		s.assignments = [...(s.assignments ?? []), def];
		await this.saveSettings();
		await this.distributeAssignment(def);
		return true;
	}

	private async distributeAssignment(def: AssignmentDoc): Promise<void> {
		const s = this.settings;
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
		const slug = slugify(def.title);
		const date = new Date().toISOString().slice(0, 10);
		const templateContent = def.templatePaths[0] ? await this.readVaultText(def.templatePaths[0]) : null;
		const templateName = def.templatePaths[0]?.split("/").pop() || "과제.md";
		const fallback = `# ${def.title}\n\n${def.instructions || ""}\n`;

		// 공유 과제: 학급 폴더에 한 번만 작성(전원 공유). 경로가 교사·학생 양측 동일(_학급 고정).
		let sharedWorkPath: string | null = null;
		if (def.privacy === "shared") {
			sharedWorkPath = `${assignmentWorkDir("shared", "", HOMEROOM_FOLDER, slug)}/${templateName}`;
			const body = templateContent != null ? substituteTemplate(templateContent, { memberId: "", memberName: "", workspaceId: s.workspaceId, date }) : fallback;
			await this.writeFileIfAbsent(sharedWorkPath, body);
		}

		let count = 0;
		for (const memberId of def.targetMembers) {
			const member = s.members.find((m) => m.memberId === memberId && m.provisioned);
			if (!member) continue;
			let workPaths: string[];
			if (def.privacy === "shared") {
				workPaths = sharedWorkPath ? [sharedWorkPath] : [];
			} else {
				// 저장은 학생측 경로(dbPath, localRoot 상대), 파일 작성은 교사 vault의 member.localRoot 아래.
				const studentPath = `${assignmentWorkDir("mirror", "", HOMEROOM_FOLDER, slug)}/${templateName}`;
				const teacherPath = `${assignmentWorkDir("mirror", member.localRoot, HOMEROOM_FOLDER, slug)}/${templateName}`;
				const body = templateContent != null ? substituteTemplate(templateContent, { memberId: member.memberId, memberName: member.memberName, workspaceId: s.workspaceId, date }) : fallback;
				await this.writeFileIfAbsent(teacherPath, body);
				workPaths = [studentPath];
			}
			const stateDoc: AssignmentStateDoc = {
				_id: assignmentStateId(def.uid, memberId),
				type: "assignment-state",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				assignmentUid: def.uid,
				memberId,
				title: def.title,
				workPaths,
				dueAt: def.dueAt,
				state: "assigned",
				assignedAtMs: Date.now(),
			};
			const r = await admin.putDoc(member.remoteDb, stateDoc as unknown as { _id: string; [k: string]: unknown });
			if (!r.ok) this.logger.error(t("dashboard.assignment_distribute_failed", { id: memberId, err: r.error ?? "" }));
			else count++;
		}
		this.logger.ok(t("dashboard.assignment_distributed", { title: def.title, count }), true);
		this.requestApply();
	}

	/** PanelHost: 학생 본인 과제 상태 목록(개인 미러). */
	async listMyAssignments(): Promise<AssignmentStateDoc[]> {
		const sync = this.studentMirrorSync();
		if (!sync) return [];
		const docs = await sync.ctx.pouch.allDocsByPrefix<AssignmentStateDoc>(ASSIGNMENT_STATE_ID_PREFIX);
		return docs.filter((d) => !d.deleted);
	}

	/** PanelHost: 한 과제의 학생별 상태(교사, 각 학생 미러에서 수집). */
	async listAssignmentStates(uid: string): Promise<AssignmentStateDoc[]> {
		const def = this.assignmentDefs().find((d) => d.uid === uid);
		if (!def) return [];
		const out: AssignmentStateDoc[] = [];
		for (const memberId of def.targetMembers) {
			const member = this.settings.members.find((m) => m.memberId === memberId);
			if (!member) continue;
			const sync = this.memberSyncByRemoteDb(member.remoteDb);
			if (!sync) continue;
			const doc = await sync.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(uid, memberId));
			if (doc && !doc.deleted) out.push(doc);
		}
		return out;
	}

	/** PanelHost: 학생 제출(스냅샷 + 상태=submitted). */
	async submitAssignment(stateDoc: AssignmentStateDoc): Promise<boolean> {
		const sync = this.studentMirrorSync();
		if (!sync) return false;
		const vs = new VersionStore(sync.ctx);
		for (const p of stateDoc.workPaths) {
			const dbPath = sync.ctx.toDbPath(p);
			const content = await this.readVaultText(p);
			if (dbPath && content != null) await vs.snapshot(dbPath, content, "submit", 0);
		}
		const current = (await sync.ctx.pouch.get<AssignmentStateDoc>(stateDoc._id)) ?? stateDoc;
		await sync.ctx.pouch.put({ ...current, state: "submitted", submittedAtMs: Date.now() });
		this.logger.ok(t("dashboard.assignment_submitted", { title: stateDoc.title }), true);
		return true;
	}

	/** PanelHost: 제출 취소(반환 전, 상태=assigned). */
	async unsubmitAssignment(stateDoc: AssignmentStateDoc): Promise<boolean> {
		const sync = this.studentMirrorSync();
		if (!sync) return false;
		const current = await sync.ctx.pouch.get<AssignmentStateDoc>(stateDoc._id);
		if (!current || current.state === "returned") return false;
		await sync.ctx.pouch.put({ ...current, state: "assigned", submittedAtMs: undefined });
		return true;
	}

	/** PanelHost: vault 파일 열기(작업 파일). */
	async openVaultPath(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f, { active: true });
	}

	/** PanelHost: 채점 반환(교사). 학생 미러의 상태 문서에 grade + state=returned 기록 → 학생 수신. */
	async returnAssignment(uid: string, memberId: string, grade: AssignmentGrade): Promise<boolean> {
		if (this.settings.role !== "manager") return false;
		const member = this.settings.members.find((m) => m.memberId === memberId);
		if (!member) return false;
		const sync = this.memberSyncByRemoteDb(member.remoteDb);
		if (!sync) return false;
		const cur = await sync.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(uid, memberId));
		if (!cur) return false;
		await sync.ctx.pouch.put({ ...cur, grade, state: "returned", returnedAtMs: Date.now() });
		this.requestApply();
		this.logger.ok(t("dashboard.assignment_returned", { name: member.memberName || memberId }), true);
		return true;
	}

	// --- 루틴(체크리스트) ---

	/** PanelHost: 루틴 정의 목록(학급 공유). */
	async listRoutines(): Promise<RoutineDoc[]> {
		const docs = await this.classroom.listByPrefix<RoutineDoc>(routinePrefix());
		return docs.filter((d) => !d.deleted).sort((a, b) => a.createdAtMs - b.createdAtMs);
	}

	/** PanelHost: 루틴 생성(교사, 학급 공유에 기록). 반복은 항목별. */
	async createRoutine(input: {
		title: string;
		items: Array<{ label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }>;
	}): Promise<boolean> {
		const s = this.settings;
		if (s.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		if (!this.homeroomReady()) {
			this.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return false;
		}
		const uid = `${Date.now().toString(36)}`;
		const doc: RoutineDoc = {
			_id: routineId(uid),
			type: "routine",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			uid,
			title: input.title,
			items: input.items.map((it, i) => ({
				id: `i${i}`,
				label: it.label,
				recurrence: it.recurrence,
				weekdays: it.recurrence === "weekly" ? it.weekdays : undefined,
			})),
			createdBy: s.userId,
			createdAtMs: Date.now(),
		};
		return this.classroom.put(doc);
	}

	/** PanelHost: 루틴 편집(교사). 제목·항목 갱신. 기존 항목 id는 보존(체크 상태 연속성). */
	async updateRoutine(
		uid: string,
		input: { title: string; items: Array<{ id?: string; label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }> },
	): Promise<boolean> {
		if (this.settings.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		const existing = await this.classroom.get<RoutineDoc>(routineId(uid));
		if (!existing) return false;
		const used = new Set<string>();
		const items = input.items.map((it, idx) => {
			const id = it.id && !used.has(it.id) ? it.id : `g${Date.now().toString(36)}${idx}`;
			used.add(id);
			return {
				id,
				label: it.label,
				recurrence: it.recurrence,
				weekdays: it.recurrence === "weekly" ? it.weekdays : undefined,
			};
		});
		return this.classroom.put({ ...existing, title: input.title, items });
	}

	/** PanelHost: 루틴 삭제(교사, soft delete). */
	async deleteRoutine(uid: string): Promise<void> {
		const doc = await this.classroom.get<RoutineDoc>(routineId(uid));
		if (doc) await this.classroom.softDelete(doc);
	}

	/** PanelHost: 학생 본인의 해당 날짜 루틴 상태. */
	async myRoutineState(uid: string, day: string): Promise<RoutineStateDoc | null> {
		const sync = this.studentMirrorSync();
		if (!sync) return null;
		return sync.ctx.pouch.get<RoutineStateDoc>(routineStateId(uid, this.settings.userId, day));
	}

	/** PanelHost: 학생 루틴 항목 체크 토글(개인 미러에 기록). */
	async toggleRoutineItem(uid: string, day: string, itemId: string, checked: boolean): Promise<boolean> {
		const sync = this.studentMirrorSync();
		if (!sync) return false;
		const id = routineStateId(uid, this.settings.userId, day);
		const cur = await sync.ctx.pouch.get<RoutineStateDoc>(id);
		const set = new Set(cur?.checked ?? []);
		if (checked) set.add(itemId);
		else set.delete(itemId);
		const doc: RoutineStateDoc = {
			_id: id,
			_rev: cur?._rev,
			type: "routine-state",
			schemaVersion: 1,
			workspaceId: this.settings.workspaceId,
			routineUid: uid,
			memberId: this.settings.userId,
			day,
			checked: [...set],
			updatedAtMs: Date.now(),
		};
		await sync.ctx.pouch.put(doc);
		return true;
	}

	/** PanelHost: 학생 본인의 한 루틴 전체 날짜 상태(streak 계산용). */
	async myRoutineDays(uid: string): Promise<RoutineStateDoc[]> {
		const sync = this.studentMirrorSync();
		if (!sync) return [];
		return sync.ctx.pouch.allDocsByPrefix<RoutineStateDoc>(routineStatePrefix(uid, this.settings.userId));
	}

	/** PanelHost: 한 루틴의 학생별 상태(교사, 각 학생 미러에서 수집). */
	async listRoutineStates(uid: string, day: string): Promise<RoutineStateDoc[]> {
		const out: RoutineStateDoc[] = [];
		for (const m of this.settings.members) {
			if (!m.memberId) continue;
			const sync = this.memberSyncByRemoteDb(m.remoteDb);
			if (!sync) continue;
			const doc = await sync.ctx.pouch.get<RoutineStateDoc>(routineStateId(uid, m.memberId, day));
			if (doc) out.push(doc);
		}
		return out;
	}

	/**
	 * 모든 실시간 서명 토큰을 재발급/회수(교사). 공유 공간은 realtime!==false일 때만, 개인 mirror는
	 * member.realtime일 때만 발급한다. 시크릿이 없으면(legacy/제거 중) 모두 비워 stale 재배포를 막는다.
	 * (유출 시 해당 공간 room만 접근 가능 — 학급 전체 아님.) 시크릿은 Secret Storage에서 읽는다.
	 */
	private async mintRealtimeTokens(): Promise<void> {
		const s = this.settings;
		const yjsSecret = getSecretValue(this.app, YJS_SECRET_ID, s.yjsSecret);
		const ttl =
			s.yjsTokenTtlDays && s.yjsTokenTtlDays > 0
				? Math.floor(Date.now() / 1000) + s.yjsTokenTtlDays * 86400
				: undefined;
		for (const sp of s.sharedSpaces) {
			if (yjsSecret && sp.realtime !== false) {
				sp.token = await mintSpaceToken(yjsSecret, { workspaceId: s.workspaceId, spaceId: sp.id, exp: ttl });
			} else {
				delete sp.token;
			}
		}
		for (const st of s.members) await this.mintMirrorToken(st);
	}

	/**
	 * 개인 mirror 실시간 토큰 발급/회수(교사). realtime 허용 + yjsSecret 있을 때만 발급, 아니면 비운다.
	 * spaceId=mirror-<memberId>이라 서버의 share 룸 prefix(<workspaceId>/share/<spaceId>/) 검증을 그대로 통과한다.
	 */
	private async mintMirrorToken(member: MemberConfig): Promise<void> {
		const s = this.settings;
		const yjsSecret = getSecretValue(this.app, YJS_SECRET_ID, s.yjsSecret);
		if (member.realtime && yjsSecret) {
			const ttl =
				s.yjsTokenTtlDays && s.yjsTokenTtlDays > 0
					? Math.floor(Date.now() / 1000) + s.yjsTokenTtlDays * 86400
					: undefined;
			member.realtimeToken = await mintSpaceToken(yjsSecret, {
				workspaceId: s.workspaceId,
				spaceId: `mirror-${member.memberId}`,
				exp: ttl,
			});
		} else {
			delete member.realtimeToken;
		}
	}

	/** 한 학생의 shares + rtconfig 문서 기록(공유 공간 멤버십 + 개인 mirror 실시간 공간). */
	private async writeMemberSync(admin: CouchAdmin, st: MemberConfig): Promise<void> {
		const s = this.settings;
		const spaces: SharesDoc["spaces"] = s.sharedSpaces
			.filter((sp) => sp.members.includes(st.memberId))
			.map((sp) => ({ id: sp.id, name: sp.name, remoteDb: sp.remoteDb, folder: sp.folder, token: sp.token, kind: "share", realtime: sp.realtime !== false }));
		// 개인 mirror 1:1 실시간(folder=""=학생 vault 전체). 동기화 링크는 안 만들고 room/token 용도로만.
		if (st.realtime && st.realtimeToken) {
			spaces.push({ id: `mirror-${st.memberId}`, name: st.memberName, remoteDb: st.remoteDb, folder: "", token: st.realtimeToken, kind: "mirror", realtime: true });
		}
		const r = await admin.putDoc(st.remoteDb, { _id: SHARES_DOC_ID, type: "shares", spaces });
		if (!r.ok) this.logger.error(t("command.failed_to_write_shares", { id: st.memberId, err: r.error ?? "" }));
		const rc = await admin.putDoc(st.remoteDb, {
			_id: RTCONFIG_DOC_ID,
			type: "rtconfig",
			enabled: s.realtimeEnabled,
			url: s.yjsServerUrl,
			token: getSecretValue(this.app, YJS_TOKEN_ID, s.yjsToken),
			snapshotSec: s.realtimeSnapshotSec,
		});
		if (!rc.ok) this.logger.error(t("command.failed_to_write_rtconfig", { id: st.memberId, err: rc.error ?? "" }));
	}

	/**
	 * 실시간 토글(학생 개인 폴더/공유 공간/전체) 적용. 토큰 재발급 + 프로비저닝된 모든 학생의 shares/rtconfig
	 * 재기록 + 모드 재시작. 공유 공간을 재배포(재프로비저닝)하지 않고 실시간 설정만 전파한다.
	 */
	async redeployRealtime(): Promise<void> {
		if (this.settings.role !== "manager") return;
		const s = this.settings;
		const adminPw = this.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) {
			this.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return;
		}
		const wantsRealtime = s.members.some((st) => st.realtime) || s.sharedSpaces.some((sp) => sp.realtime !== false && sp.members.length > 0);
		if (s.realtimeEnabled && wantsRealtime && !getSecretValue(this.app, YJS_SECRET_ID, s.yjsSecret)) {
			this.logger.warn(t("command.realtime_needs_yjs_secret"), true);
		}
		await this.mintRealtimeTokens();
		await this.saveSettings();
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		for (const st of s.members) {
			if (st.provisioned && st.remoteDb) await this.writeMemberSync(admin, st);
		}
		this.logger.ok(t("command.realtime_settings_applied"), true);
		await this.restartMode();
	}

	// --- 학생 온보딩: 초대 코드/딥링크로 자동 설정 ---
	async ingestInvite(input: string): Promise<void> {
		const payload = parseInvite(input);
		if (!payload) {
			new Notice(t("command.covault_could_not_parse_the"));
			this.logger.error(t("command.failed_to_parse_invite_code"));
			return;
		}
		// 만료된 초대는 적용하지 않는다 — 새 초대를 요청하도록 안내(설정을 건드리지 않음).
		if (isInviteExpired(payload, Math.floor(Date.now() / 1000))) {
			new Notice(t("command.invite_expired_request_new"));
			this.logger.error(t("command.invite_expired_request_new"));
			return;
		}
		await this.mode?.stop();
		this.mode = null;

		const s = this.settings;
		s.role = "member";
		s.setupComplete = true;
		s.couchdbUrl = payload.couchdbUrl;
		s.workspaceId = payload.workspaceId;
		s.userId = payload.memberId;
		s.displayName = payload.memberName;
		s.username = payload.username;
		// 받은 학생 비밀번호는 Secret Storage에 보관(data.json 평문 회피). 미지원 환경만 평문 폴백.
		if (setSecretValue(this.app, COUCH_PASSWORD_ID, payload.password)) {
			s.passwordSet = true;
			s.password = "";
		} else {
			s.password = payload.password;
		}
		s.remoteDb = payload.remoteDb;
		s.localRoot = ""; // 학생 vault 전체
		s.lastSeqByDb = {};
		await this.saveSettings();

		await this.activatePanel("log");
		this.logger.ok(t("command.invite_applied_starting_sync", { name: payload.memberName, db: payload.remoteDb }), true);

		// 파싱 성공 ≠ 인증 성공. 즉시 인증을 확인해 옛/무효 초대를 명확히 안내한다(네트워크 실패는 startMode가 재시도).
		try {
			const probe = this.core.createPouch(s.remoteDb);
			try {
				const info = await probe.rawInfo();
				if (info.status === 401) {
					new Notice(t("panel.covault_invite_auth_failed_your"));
					this.logger.error(t("panel.invite_auth_failed_401_your_manager"), true);
				} else if (info.status === 403) {
					this.logger.warn(t("panel.invite_permission_error_403_check_this"), true);
				}
			} finally {
				await probe.close();
			}
		} catch {
			/* 서버 도달 실패 → startMode 재시도에 맡긴다 */
		}

		await this.startMode();
	}

	// --- 연결 테스트 (설정 버튼) — 항상 최신 설정으로, 역할별 DB 전체 검사 ---
	async testConnection(): Promise<void> {
		await this.activatePanel("log");
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
		await this.activatePanel("log");
		const targets = (this.mode?.getSyncs() ?? []).map((s) => ({ db: s.remoteDb, label: s.label }));
		await runDiagnostics(this.core, targets);
		this.realtime.diagnose();
	}

	// --- 충돌 해소 (ConflictHost) ---
	async listConflicts(): Promise<ConflictRow[]> {
		const rows: ConflictRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				const infos = await sync.listConflicts();
				for (const info of infos) rows.push({ sync, info });
			} catch (e) {
				this.logger.error(t("command.failed_to_fetch_conflict_list", { label: sync.label, err: e instanceof Error ? e.message : String(e) }));
			}
		}
		return rows;
	}

	async resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		await this.activatePanel("log");
		await row.sync.resolveConflict(row.info.dbPath, choice);
	}

	async openConflictFiles(row: ConflictRow): Promise<void> {
		const local = this.app.vault.getAbstractFileByPath(row.info.localPath);
		const conflict = this.app.vault.getAbstractFileByPath(row.info.conflictPath);
		if (local instanceof TFile) await this.app.workspace.getLeaf(false).openFile(local);
		if (conflict instanceof TFile) await this.app.workspace.getLeaf("split").openFile(conflict);
		else this.logger.warn(t("command.remote_copy_file_not_found", { path: row.info.conflictPath }), true);
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
	/** 한 구성원의 서버 데이터(미러 DB + 계정) 삭제. 교사 전용. 실패해도 가능한 만큼 진행. */
	async deleteMemberServer(member: MemberConfig): Promise<void> {
		const s = this.settings;
		if (s.role !== "manager") return;
		await this.activatePanel("log");
		if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
			this.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		// 삭제 대상 DB로의 replication을 멈춘다(삭제 직후 재생성 방지). 호출측이 restartMode로 재구성.
		await this.mode?.stop();
		this.mode = null;
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
		if (member.remoteDb) {
			const r = await admin.deleteDatabase(member.remoteDb);
			if (r.ok) this.logger.ok(t("command.db_deleted", { db: member.remoteDb }), true);
			else this.logger.error(t("command.failed_to_delete_db", { db: member.remoteDb, err: r.error ?? "" }), true);
			try {
				const p = this.core.createPouch(member.remoteDb);
				await p.destroyLocal();
				await p.close();
			} catch {
				/* 캐시 없음 등 무시 */
			}
		}
		if (member.username) {
			const r = await admin.deleteUser(member.username);
			if (r.ok) this.logger.ok(t("command.account_deleted", { user: member.username }), true);
			else this.logger.error(t("command.failed_to_delete_account", { user: member.username, err: r.error ?? "" }), true);
		}
	}

	/** 한 공동 공간의 서버 데이터(공유 DB) 삭제. 교사 전용. */
	async deleteSharedServer(space: SharedSpace): Promise<void> {
		const s = this.settings;
		if (s.role !== "manager") return;
		await this.activatePanel("log");
		if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
			this.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		await this.mode?.stop();
		this.mode = null;
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
		if (space.remoteDb) {
			const r = await admin.deleteDatabase(space.remoteDb);
			if (r.ok) this.logger.ok(t("command.db_deleted", { db: space.remoteDb }), true);
			else this.logger.error(t("command.failed_to_delete_db", { db: space.remoteDb, err: r.error ?? "" }), true);
			try {
				const p = this.core.createPouch(space.remoteDb);
				await p.destroyLocal();
				await p.close();
			} catch {
				/* 캐시 없음 등 무시 */
			}
		}
	}

	async resetServerData(deleteAccounts: boolean): Promise<void> {
		await this.activatePanel("log");
		const s = this.settings;
		if (s.role !== "manager") {
			this.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		if (!s.couchdbUrl || !s.username || !this.couchPassword()) {
			this.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.couchPassword());
		const chk = await admin.checkAdmin();
		if (!chk.ok) {
			this.logger.error(t("command.admin_authentication_failed", { err: chk.error ?? "" }), true);
			return;
		}

		// 실행 중 엔진 정지(삭제할 DB로의 replication 차단). 대기 중 자동-적용도 취소.
		if (this.applyTimer) {
			window.clearTimeout(this.applyTimer);
			this.applyTimer = null;
		}
		await this.mode?.stop();
		this.mode = null;

		const dbs = [
			...s.members.map((st) => st.remoteDb).filter((d) => d),
			...s.sharedSpaces.map((sp) => sp.remoteDb).filter((d) => d),
		];
		this.logger.info(t("command.starting_server_data_reset_db_s", { count: dbs.length, accounts: deleteAccounts ? t("command.member_accounts") : "" }), true);

		for (const db of dbs) {
			const r = await admin.deleteDatabase(db);
			if (r.ok) this.logger.ok(t("command.db_deleted", { db }));
			else this.logger.error(t("command.failed_to_delete_db", { db, err: r.error ?? "" }));
			// 로컬 PouchDB 캐시도 제거
			try {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
			} catch {
				/* 캐시 없음 등 무시 */
			}
		}

		if (deleteAccounts) {
			for (const st of s.members) {
				if (!st.username) continue;
				const r = await admin.deleteUser(st.username);
				if (r.ok) this.logger.ok(t("command.account_deleted", { user: st.username }));
				else this.logger.error(t("command.failed_to_delete_account", { user: st.username, err: r.error ?? "" }));
			}
		}

		// 로컬 상태 초기화
		if (deleteAccounts) {
			// 계정까지 삭제 → 학급 명단(학생·공유 공간)도 완전 비움(처음부터 다시 구성)
			s.members = [];
			s.sharedSpaces = [];
			this.core.sharedSpaces = [];
		} else {
			// DB만 삭제 → 명단 유지, 프로비저닝 상태만 리셋(재초대로 복구)
			for (const st of s.members) st.provisioned = false;
			for (const sp of s.sharedSpaces) sp.provisioned = false;
		}
		s.lastSeqByDb = {};
		await this.saveSettings();

		this.logger.warn(
			t("command.reset_yjs_realtime_data_manually_restart"),
			true,
		);
		this.logger.ok(
			deleteAccounts
				? t("command.server_data_and_accounts_reset_the")
				: t("command.server_data_reset_complete_invite_members"),
			true,
		);
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
		this.addCommand({ id: "covault-open-panel", name: t("command.open_panel"), callback: () => this.activatePanel() });
		this.addCommand({ id: "covault-open-dashboard", name: t("command.open_dashboard"), callback: () => this.activatePanel("dashboard") });
		this.addCommand({ id: "covault-open-log", name: t("command.open_log_panel"), callback: () => this.activatePanel("log") });
		this.addCommand({
			id: "covault-test-connection",
			name: t("panel.test_connection_permissions"),
			callback: () => this.testConnection(),
		});
		this.addCommand({
			id: "covault-diagnostics",
			name: t("command.run_full_diagnostics_server_read_write"),
			callback: () => this.runDiagnostics(),
		});
		this.addCommand({ id: "covault-full-sync", name: t("panel.full_sync"), callback: () => this.fullSync("both") });
		this.addCommand({ id: "covault-upload-only", name: t("command.upload_only"), callback: () => this.fullSync("up") });
		this.addCommand({ id: "covault-download-only", name: t("command.download_only"), callback: () => this.fullSync("down") });
		this.addCommand({
			id: "covault-toggle-autosync",
			name: t("command.toggle_auto_sync"),
			callback: () => this.toggleAutoSync(),
		});
		this.addCommand({
			id: "covault-reset-local",
			name: t("command.reset_local_cache_re_fetch_from"),
			callback: () => this.resetLocalCache(),
		});
		this.addCommand({
			id: "covault-conflicts",
			name: t("command.open_conflict_list"),
			callback: () => this.openConflictModal(),
		});
		this.addCommand({
			id: "covault-dashboard",
			name: t("command.open_sync_status"),
			callback: () => this.activatePanel("sync"),
		});
		this.addCommand({
			id: "covault-deploy",
			name: t("deploy.copy_to_members_open_deploy_tab"),
			callback: () => this.activatePanel("deploy"),
		});
		this.addCommand({
			id: "covault-realtime-status",
			name: t("panel.check_realtime_status"),
			callback: () => this.realtimeStatus(),
		});
		this.addCommand({
			id: "covault-add-feedback",
			name: t("command.add_feedback_selection"),
			callback: () => promptAddFeedback(this.app, this.feedback),
		});
		this.addCommand({
			id: "covault-open-feedback",
			name: t("command.open_feedback_panel"),
			callback: () => this.activatePanel("feedback"),
		});
		this.addCommand({
			id: "covault-refresh-shares",
			name: t("panel.refresh_shared_spaces"),
			callback: () => this.refreshShares(),
		});
		this.addCommand({
			id: "covault-version-history",
			name: t("version.open_version_history"),
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				const ok = !!file && file.extension === "md" && !!this.syncForLocalPath(file.path);
				if (ok && !checking) new VersionHistoryModal(this.app, this, file!.path).open();
				return ok;
			},
		});
	}

	// --- 버전 히스토리 (보고서 §1 P1) ---
	async versionHistoryFor(localPath: string): Promise<VersionDoc[]> {
		const sync = this.syncForLocalPath(localPath);
		if (!sync) return [];
		const dbPath = sync.ctx.toDbPath(localPath);
		return dbPath ? sync.listVersions(dbPath) : [];
	}

	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing"> {
		const sync = this.syncForLocalPath(localPath);
		return sync ? sync.restoreVersion(versionDocId, opts) : Promise.resolve("missing");
	}

	// --- 패널 버튼/명령 공용 동작 (PanelHost) ---

	/** 전체/업로드/다운로드 수동 동기화. */
	async fullSync(dir: "both" | "up" | "down"): Promise<void> {
		await this.activatePanel("log");
		await this.mode?.fullSync(dir);
	}

	/** 실시간 세션 점검 + 진단 로그. */
	async realtimeStatus(): Promise<void> {
		await this.activatePanel("log");
		this.realtime.syncOpenEditors();
		this.realtime.diagnose();
	}

	/** 공유 공간 새로고침(학생=shares 재조회, 교사=재시작). */
	async refreshShares(): Promise<void> {
		await this.activatePanel("log");
		const m = this.mode as unknown as { refreshShares?: () => Promise<void> } | null;
		if (this.settings.role === "member" && m?.refreshShares) await m.refreshShares();
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
			return { written: 0, skipped: 0, details: [], error: e instanceof Error ? e.message : String(e) };
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
			return { members: [], error: e instanceof Error ? e.message : String(e) };
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

	// --- 동기화 상태 (PanelHost) ---
	async getDashboardRows(): Promise<DashboardRow[]> {
		const rows: DashboardRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			let conflicts = 0;
			try {
				conflicts = (await sync.listConflicts()).length;
			} catch {
				/* 조회 실패는 0으로 */
			}
			rows.push({
				memberName: sync.memberName,
				memberId: sync.memberId,
				remoteDb: sync.remoteDb,
				localRoot: sync.localRoot,
				conflicts,
				...sync.status,
			});
		}
		return rows;
	}

	openConflictModal(): void {
		new ConflictModal(this.app, this).open();
	}

	// --- 삭제 파일 복구 (보고서 §2 P1) ---
	async listDeletedFiles(): Promise<DeletedItem[]> {
		const out: DeletedItem[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				out.push(...(await sync.listDeleted()));
			} catch {
				/* 조회 실패한 링크는 건너뜀 */
			}
		}
		return out;
	}

	restoreDeleted(remoteDb: string, dbPath: string, opts?: RestoreOptions): Promise<RestoreResult> {
		const sync = (this.mode?.getSyncs() ?? []).find((s) => s.remoteDb === remoteDb);
		if (!sync) return Promise.resolve("unrecoverable" as RestoreResult);
		return sync.restoreDeleted(dbPath, opts);
	}

	purgeDeleted(remoteDb: string, dbPath: string): Promise<"purged" | "skipped"> {
		const sync = (this.mode?.getSyncs() ?? []).find((s) => s.remoteDb === remoteDb);
		if (!sync) return Promise.resolve("skipped");
		return sync.purgeDeleted(dbPath);
	}

	async listDeleteModify(): Promise<DeleteModifyRow[]> {
		const out: DeleteModifyRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				for (const it of await sync.listDeleteModify()) {
					out.push({ ...it, remoteDb: sync.remoteDb, memberName: sync.memberName });
				}
			} catch {
				/* 조회 실패 링크 건너뜀 */
			}
		}
		return out;
	}

	resolveDeleteModify(remoteDb: string, dbPath: string, choice: DeleteModifyChoice): Promise<void> {
		const sync = (this.mode?.getSyncs() ?? []).find((s) => s.remoteDb === remoteDb);
		return sync ? sync.resolveDeleteModify(dbPath, choice) : Promise.resolve();
	}

	async listRecentPurges(): Promise<PurgeRow[]> {
		const out: PurgeRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				for (const p of await sync.listRecentPurges()) {
					out.push({ ...p, remoteDb: sync.remoteDb, memberName: sync.memberName });
				}
			} catch {
				/* 조회 실패 링크 건너뜀 */
			}
		}
		return out;
	}

	undoPurge(remoteDb: string, id: string): Promise<RestoreResult> {
		const sync = (this.mode?.getSyncs() ?? []).find((s) => s.remoteDb === remoteDb);
		return sync ? sync.undoPurge(id) : Promise.resolve("unrecoverable" as RestoreResult);
	}

	clearPurge(remoteDb: string, id: string): Promise<void> {
		const sync = (this.mode?.getSyncs() ?? []).find((s) => s.remoteDb === remoteDb);
		return sync ? sync.clearPurge(id) : Promise.resolve();
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
		for (const sync of this.mode?.getSyncs() ?? []) {
			if (sync.owns(localPath)) return sync;
		}
		return undefined;
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
