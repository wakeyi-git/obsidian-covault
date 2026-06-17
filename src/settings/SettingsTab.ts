import { App, Notice, Plugin, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace, GroupConfig } from "./types";
import { ExportModal, ImportModal } from "../ui/BackupModal";
import { validateFolderName, foldersOverlap } from "../core/path/path";
import { validateSettings, SettingsIssue } from "./validateSettings";
import { hasSecretStorage, getYjsSecret } from "../core/secret";
import { renderManager as renderManagerSection, ManagerCtx } from "./managerSection";
import { noAutoCorrect, renderMaxAttachmentSetting, commitOnBlur } from "./settingsUi";
import { t } from "../i18n";

// SettingGroup.listEl은 Obsidian 런타임에 1.11.0부터 존재하지만(공식 @since 1.11.0),
// minAppVersion에 맞춰 고정한 obsidian@1.11.4 d.ts 패키지에서 누락되어 있다(타입 갭).
// 누락된 멤버를 모듈 보강으로 메운다 — 런타임 동작은 1.11.4에서도 정상.
declare module "obsidian" {
	interface SettingGroup {
		/** 그룹의 항목 리스트 컨테이너(@since 1.11.0). 카드 마크업을 직접 삽입할 때 사용. */
		listEl: HTMLElement;
	}
}

/** 검증 이슈 코드 → 사용자 메시지(i18n). validateSettings는 순수(코드만), 문구는 여기서. */
function issueMessage(i: SettingsIssue): string {
	switch (i.code) {
		case "dup-memberId":
			return t("panel.duplicate_member_id", { value: String(i.params?.value) });
		case "dup-username":
			return t("panel.duplicate_account_username", { value: String(i.params?.value) });
		case "dup-remoteDb":
			return t("panel.duplicate_mirror_db_name", { value: String(i.params?.value) });
		case "bad-memberId":
			return t("panel.invalid_member_id", { value: String(i.params?.value) });
		case "bad-username":
			return t("panel.invalid_username", { value: String(i.params?.value) });
		case "bad-remoteDb":
			return t("panel.invalid_mirror_db_name", { value: String(i.params?.value) });
		case "bad-shareDb":
			return t("panel.invalid_share_db_name", { value: String(i.params?.value) });
		case "bad-shareId":
			return t("panel.invalid_share_id_mirror_prefix", { value: String(i.params?.value) });
		case "folder-overlap":
			return t("panel.folder_overlap_and_double_sync_confusion", { a: String(i.params?.a), b: String(i.params?.b) });
		case "couch-url":
			return t("panel.couchdb_url_must_start_with_http");
		case "yjs-wss":
			return t("panel.yjs_server_url_should_use_wss");
		case "rt-no-url":
			return t("panel.realtime_is_on_but_the_yjs");
		case "rt-no-token":
			return t("panel.realtime_is_on_but_the_token");
	}
}

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: CoVaultSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	restartMode(): Promise<void>;
	requestApply(): void;
	resetSetup(): Promise<void>;
	inviteMember(member: MemberConfig): Promise<boolean>;
	/** 프로비저닝되지 않은 모든 구성원을 일괄 초대. 프로비저닝된 수를 반환. */
	inviteAllMembers(): Promise<number>;
	rotateMemberPassword(member: MemberConfig): Promise<void>;
	/** 기기 추가 초대(전용 계정 발급 — 평가 S-2). */
	inviteDevice(member: MemberConfig): Promise<boolean>;
	/** 기기 계정 회수(계정 삭제 + 접근 제거). */
	revokeDevice(member: MemberConfig, username: string): Promise<boolean>;
	ingestInvite(code: string): Promise<void>;
	deployShared(space: SharedSpace): Promise<void>;
	/** 구성원 서버 데이터(미러 DB + 계정) 삭제. */
	deleteMemberServer(member: MemberConfig): Promise<void>;
	/** 공동 공간 서버 데이터(공유 DB) 삭제. */
	deleteSharedServer(space: SharedSpace): Promise<void>;
	/** 모든 구성원의 shares 문서 재기록(공동 공간 삭제 후 구성원이 사라진 DB를 동기화하지 않도록). */
	refreshMemberShares(): Promise<void>;
	/** 공유 공간 하나를 학급 공동 공간으로 지정/해제. */
	setHomeroomSpace(space: SharedSpace, on: boolean): Promise<void>;
	/** 유형별 기본 콘텐츠 템플릿 파일 생성 + 설정 경로 저장 후 편집창에서 열기. */
	createTemplateFile(kind: "notice" | "lesson" | "assignment"): Promise<void>;
	/** 내 볼트 개인 동기화 켜기/끄기(켜면 개인 DB 프로비저닝). */
	setPersonalSync(on: boolean): Promise<void>;
	/** 실시간 공간 토큰을 하나라도 수신했는지(구성원: shares로 자동 전달). */
	realtimeTokenReceived(): boolean;
	/** 실시간 연결 상태 진단(로그 패널에 출력). */
	realtimeStatus(): Promise<void>;
	/** 공유 파일 읽기 전용 정책 토글(교사). 실시간 탭과 공유. */
	setSharedReadOnly(on: boolean): Promise<void>;
	redeployRealtime(): Promise<void>;
	/** 명명 그룹 생성/수정(교사). */
	saveGroup(group: GroupConfig): Promise<void>;
	/** 명명 그룹 삭제(교사). 그룹 대화방도 삭제. */
	deleteGroup(id: string): Promise<void>;
	/** 그룹 대화방을 대화 탭에서 연다. */
	openGroupChat(groupId: string): Promise<void>;
	exportSettingsJson(): string;
	importSettingsJson(json: string): Promise<{ ok: boolean; error?: string }>;
	openResetModal(): void;
	refreshUiLanguage(): void;
	/** 교사 온보딩 마법사(모달) 실행. */
	openSetupWizard(): void;
}

/**
 * 설정 탭. 섹션을 SettingGroup(.setting-group)으로 묶어 최신 Obsidian 설정 UI 가이드를 따른다.
 * 일반(역할)은 상단에 헤딩 없이 두고, 이후 섹션부터 그룹 헤딩을 붙인다.
 */
export class CoVaultSettingTab extends PluginSettingTab {
	constructor(app: App, private host: SettingsHost) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;

		// 항목 추가 등으로 display()를 다시 호출하면 containerEl.empty()가 콘텐츠를 비워
		// 스크롤이 상단으로 튄다. 재렌더 전 스크롤 위치를 저장했다가 복원한다.
		const scroller = this.scrollContainer();
		const scrollTop = scroller?.scrollTop ?? 0;

		containerEl.empty();

		// 탭 제목이 이미 플러그인 이름을 표시하므로 상단 제목/그룹 헤딩은 두지 않는다(Obsidian 가이드).
		this.renderRole(s);
		this.renderLanguage(s);
		this.renderSecretWarning();
		this.renderIssues(s);

		if (s.role === "manager") this.renderManager(s);
		else this.renderMember(s);

		this.renderSyncOptions(s);
		this.renderBackup();
		this.renderApplyAndReset(s);

		if (scroller && scrollTop > 0) {
			scroller.scrollTop = scrollTop;
			// 재렌더 직후 레이아웃이 늦게 확정되는 경우를 대비해 다음 프레임에 한 번 더 복원한다.
			window.requestAnimationFrame(() => {
				scroller.scrollTop = scrollTop;
			});
		}
	}

	/** containerEl을 감싸는 스크롤 가능한 조상 요소(설정 패널 본문). 없으면 null. */
	private scrollContainer(): HTMLElement | null {
		let el: HTMLElement | null = this.containerEl;
		while (el) {
			if (el.scrollHeight > el.clientHeight) {
				const overflowY = getComputedStyle(el).overflowY;
				if (overflowY === "auto" || overflowY === "scroll") return el;
			}
			el = el.parentElement;
		}
		return null;
	}

	// --- 설정 검증 경고(상단 지속 표시) ---
	/** 보안 저장소(Secret Storage) 미지원 환경 경고 — 비밀번호·토큰이 data.json에 평문 저장됨. */
	private renderSecretWarning(): void {
		if (hasSecretStorage(this.app)) return;
		const box = this.containerEl.createDiv({ cls: "covault-issues" });
		box.createDiv({ cls: "covault-issues-title", text: t("settings.plaintext_secret_title") });
		box.createDiv({ cls: "covault-issue is-warn", text: t("settings.plaintext_secret_desc") });
	}

	private renderIssues(s: CoVaultSettings): void {
		// 실시간 자격증명 판단: 운영자는 공간 시크릿(HMAC 키)을, 구성원은 shares로 받은 공간 토큰을 본다.
		// (구성원은 시크릿을 갖지 않으며, 토큰은 개인 mirror DB로 자동 전달된다.)
		const realtimeCredPresent =
			s.role === "manager" ? !!getYjsSecret(this.app, s.yjsSecret) : this.host.realtimeTokenReceived();
		const issues = validateSettings(s, { realtimeCredPresent });
		if (issues.length === 0) return;
		const box = this.containerEl.createDiv({ cls: "covault-issues" });
		box.createDiv({ cls: "covault-issues-title", text: t("panel.settings_need_attention", { n: issues.length }) });
		for (const i of issues) {
			const row = box.createDiv({ cls: `covault-issue is-${i.level}` });
			// 구성원에게는 시크릿 대신 "토큰 미수신 → 교사 재배포" 안내로 바꾼다(구성원이 할 수 있는 조치).
			const text = i.code === "rt-no-token" && s.role === "member" ? t("panel.realtime_member_no_token") : issueMessage(i);
			row.setText((i.level === "error" ? "⛔ " : "⚠ ") + text);
		}
	}

	// --- 언어 ---
	private renderLanguage(s: CoVaultSettings): void {
		new Setting(this.containerEl)
			.setName(t("settings.language"))
			.setDesc(t("settings.ui_language_auto_follows_the_obsidian"))
			.addDropdown((d) => {
				d.addOption("auto", t("settings.auto_follow_obsidian"));
				d.addOption("ko", "한국어");
				d.addOption("en", "English");
				d.setValue(s.language).onChange(async (v) => {
					s.language = v as CoVaultSettings["language"];
					await this.host.saveSettings();
					this.host.refreshUiLanguage();
					this.display();
				});
			});
	}

	// --- 역할 (상단 일반 설정, 헤딩 없음) ---
	private renderRole(s: CoVaultSettings): void {
		const roleLabel = s.role === "manager" ? t("settings.manager_mode_manager") : t("settings.member_mode_member");
		new Setting(this.containerEl)
			.setName(t("settings.role"))
			.setDesc(
				s.setupComplete
					? t("settings.locked_after_the_one_time_setup")
					: t("settings.no_role_has_been_set_yet"),
			)
			.addText((txt) => txt.setValue(s.setupComplete ? roleLabel : t("settings.not_set")).setDisabled(true));
	}

	// --- Manager Mode ---
	private renderManager(s: CoVaultSettings): void {
		renderManagerSection(this.managerCtx(), s); // 매니저 섹션 렌더는 managerSection.ts로 분할(평가 P2-3)
	}

	/** 매니저 섹션 모듈에 넘길 컨텍스트 — 공용 헬퍼·수명주기를 private 유지한 채 노출(거동 동일). */
	private managerCtx(): ManagerCtx {
		return {
			app: this.app,
			host: this.host,
			display: () => this.display(),
			group: (h, d) => this.group(h, d),
			collapsible: (g, sm) => this.collapsible(g, sm),
			textSetting: (g, n, k, ph, o) => this.textSetting(g, n, k, ph, o),
			readonlySetting: (g, n, v) => this.readonlySetting(g, n, v),
			runAsync: (b, fn) => this.runAsync(b, fn),
			okFolder: (v) => this.okFolder(v),
			applyOnBlur: (el) => this.applyOnBlur(el),
		};
	}

	// --- Member Mode ---
	private renderMember(s: CoVaultSettings): void {
		const invite = this.group(t("settings.connect_via_invite"), t("settings.scan_the_qr_from_your_manager"));
		let codeValue = "";
		invite.addSetting((set) =>
			set
				.setName(t("settings.invite_code"))
				.addText((txt) => {
					txt.setPlaceholder(t("settings.paste_the_invite_code_from_your")).onChange((v) => (codeValue = v));
					noAutoCorrect(txt.inputEl);
				})
				.addButton((b) =>
					b
						.setButtonText(t("common.apply"))
						.setCta()
						.onClick(() => this.runAsync(b, async () => { await this.host.ingestInvite(codeValue); this.display(); })),
				),
		);

		// 친화적 요약(내부 용어 최소화). 자세한 실시간 상태는 패널 ‘동기화 상태’ 탭에서.
		const info = this.group(t("panel.my_connection"), t("panel.see_detailed_sync_status_in_the"));
		this.readonlySetting(info, t("settings.name"), s.displayName || t("settings.not_set"));
		this.readonlySetting(info, t("settings.workspace_id"), s.workspaceId || t("settings.not_set"));
		info.addSetting((set) =>
			set
				.setName(t("panel.check_connection"))
				.setDesc(t("panel.checks_that_you_re_properly_connected"))
				.addButton((b) =>
					b.setButtonText(t("common.run_test")).setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);

		// 고급(문제 해결용) — 내부 식별자는 여기로 접어 둔다.
		const adv = this.group(t("panel.advanced_info"), t("panel.for_troubleshooting_usually_no_need_to"));
		this.readonlySetting(adv, "CouchDB URL", s.couchdbUrl || t("settings.not_set"));
		this.readonlySetting(adv, "Mirror DB", s.remoteDb || t("settings.not_set"));
		this.readonlySetting(adv, t("settings.account"), s.username || t("settings.not_set"));
		// 실시간 상태(구성원): 토큰은 교사가 공동 공간을 배포하면 개인 mirror로 자동 전달된다.
		this.readonlySetting(adv, t("settings.realtime_status"), s.realtimeEnabled ? t("common.on") : t("common.off"));
		if (s.realtimeEnabled) {
			this.readonlySetting(adv, t("settings.yjs_server_url"), s.yjsServerUrl || t("settings.not_set"));
			this.readonlySetting(adv, t("settings.realtime_token"), this.host.realtimeTokenReceived() ? t("common.set") : t("common.none"));
			adv.addSetting((set) =>
				set
					.setName(t("panel.check_realtime_status"))
					.setDesc(t("settings.realtime_token_member_hint"))
					.addButton((b) => b.setButtonText(t("common.run_test")).onClick(() => this.runAsync(b, () => this.host.realtimeStatus()))),
			);
		}
	}

	// --- 공통: 동기화 옵션 ---
	private renderSyncOptions(s: CoVaultSettings): void {
		const g = this.group(t("settings.sync"));

		g.addSetting((set) =>
			set
				.setName(t("settings.auto_sync"))
				.setDesc(t("settings.when_off_only_manual_sync_runs"))
				.addToggle((tg) =>
					tg.setValue(s.autoSync).onChange(async (v) => {
						s.autoSync = v;
						await this.host.saveSettings();
						this.host.requestApply();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.sync_attachments"))
				.setDesc(t("settings.also_syncs_non_markdown_files_such"))
				.addToggle((tg) =>
					tg.setValue(s.syncAssets).onChange(async (v) => {
						s.syncAssets = v;
						await this.host.saveSettings();
					}),
				),
		);

		renderMaxAttachmentSetting(g, s, () => this.host.saveSettings());

		g.addSetting((set) =>
			set
				.setName(t("settings.pause_sync_in_background"))
				.setDesc(t("settings.pauses_remote_sync_when_the_app"))
				.addToggle((tg) =>
					tg.setValue(s.pauseWhenHidden).onChange(async (v) => {
						s.pauseWhenHidden = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.mobile_upload_delay_ms"))
				.setDesc(t("settings.delay_from_edit_to_upload_on"))
				.addText((txt) =>
					commitOnBlur(txt.setValue(String(s.mobileDebounceMs)), async (v) => {
						const n = parseInt(v, 10);
						s.mobileDebounceMs = Number.isFinite(n) && n >= 0 ? n : 4000;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.delete_policy"))
				.setDesc(t("settings.decides_how_the_old_file_in"))
				.addDropdown((dd) =>
					dd
						.addOption("archive", t("settings.move_to_archive_folder"))
						.addOption("propagate-delete", t("settings.delete_immediately"))
						.addOption("ignore-delete", t("settings.ignore_deletion"))
						.setValue(s.deletePolicy)
						.onChange(async (v) => {
							s.deletePolicy = v as CoVaultSettings["deletePolicy"];
							await this.host.saveSettings();
						}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("sync.max_delete_reconcile"))
				.setDesc(t("sync.max_files_to_auto_propagate_as"))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.deleteReconcileMax ?? 0));
					txt.inputEl.type = "number";
					commitOnBlur(txt, async (v) => {
						const n = parseInt(v, 10);
						s.deleteReconcileMax = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.host.saveSettings();
					});
				}),
		);

		g.addSetting((set) =>
			set
				.setName(t("version.version_history"))
				.setDesc(t("version.snapshots_markdown_content_on_edit_delete"))
				.addToggle((tg) =>
					tg.setValue(s.versionHistory !== false).onChange(async (v) => {
						s.versionHistory = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("version.versions_to_keep"))
				.setDesc(t("version.max_versions_kept_per_file_default"))
				.addText((txt) => {
					txt.setPlaceholder("10").setValue(String(s.versionMaxCount ?? 10));
					txt.inputEl.type = "number";
					commitOnBlur(txt, async (v) => {
						const n = parseInt(v, 10);
						s.versionMaxCount = Number.isFinite(n) && n > 0 ? n : 10;
						await this.host.saveSettings();
					});
				}),
		);

		g.addSetting((set) =>
			set
				.setName(t("version.days_to_keep_versions"))
				.setDesc(t("version.versions_within_this_period_are_kept"))
				.addText((txt) => {
					txt.setPlaceholder("30").setValue(String(s.versionMaxAgeDays ?? 30));
					txt.inputEl.type = "number";
					commitOnBlur(txt, async (v) => {
						const n = parseInt(v, 10);
						s.versionMaxAgeDays = Number.isFinite(n) && n > 0 ? n : 30;
						await this.host.saveSettings();
					});
				}),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.archive_folder"))
				.setDesc(t("settings.deleted_files_collect_here_under_the"))
				.addText((txt) =>
					commitOnBlur(txt.setPlaceholder(t("settings.deleted")).setValue(s.archiveFolder), async (v) => {
						const v2 = v.trim();
						if (!this.okFolder(v2)) return;
						if (v2 && foldersOverlap(v2, s.conflictFolder)) {
							new Notice(t("settings.archive_and_conflict_folders_overlap_use"));
							return;
						}
						s.archiveFolder = v2 || "_삭제됨";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.conflict_folder"))
				.setDesc(t("settings.folder_where_the_remote_version_is"))
				.addText((txt) =>
					commitOnBlur(txt.setPlaceholder(t("settings.conflict")).setValue(s.conflictFolder), async (v) => {
						const v2 = v.trim();
						if (!this.okFolder(v2)) return;
						if (v2 && foldersOverlap(v2, s.archiveFolder)) {
							new Notice(t("settings.archive_and_conflict_folders_overlap_use"));
							return;
						}
						s.conflictFolder = v2 || "_충돌";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("settings.excluded_folders"))
				.setDesc(t("settings.enter_folders_to_exclude_from_sync"))
				.addText((txt) =>
					commitOnBlur(txt.setValue(s.excludeFolders.join(", ")), async (v) => {
						const folders = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
						const bad = folders.find((f) => !validateFolderName(f));
						if (bad) {
							new Notice(t("settings.invalid_folder_path_no_absolute_paths", { path: bad }));
							return;
						}
						s.excludeFolders = folders;
						await this.host.saveSettings();
					}),
				),
		);
	}

	// --- 설정 백업/이전 + 적용/초기화 ---
	private renderBackup(): void {
		const g = this.group(t("settings.backup_device_transfer"));
		g.addSetting((set) =>
			set
				.setName(t("settings.export_import_settings"))
				.setDesc(t("settings.back_up_members_shared_spaces_and"))
				.addButton((b) =>
					b.setButtonText(t("common.export")).onClick(() => new ExportModal(this.app, this.host.exportSettingsJson()).open()),
				)
				.addButton((b) =>
					b.setButtonText(t("common.import")).onClick(() =>
						new ImportModal(this.app, async (json) => {
							await this.host.importSettingsJson(json);
							this.display();
						}).open(),
					),
				),
		);
	}

	private renderApplyAndReset(s: CoVaultSettings): void {
		const g = this.group(t("common.reset_2"));

		// 서버 데이터 초기화 — 교사 전용, 파괴적. 백엔드를 처음 상태로.
		if (s.role === "manager") {
			g.addSetting((set) =>
				set
					.setName(t("settings.reset_server_data"))
					.setDesc(t("settings.deletes_all_member_and_shared_databases"))
					.addButton((b) => b.setButtonText(t("settings.reset")).setWarning().onClick(() => this.host.openResetModal())),
			);
		}

		// ③ 역할 재설정 — 로컬만 초기화하고 역할 재선택(서버·vault는 유지).
		if (s.setupComplete) {
			g.addSetting((set) =>
				set
					.setName(t("settings.reset_role_local_reset"))
					.setDesc(t("settings.for_switching_between_manager_and_member"))
					.addButton((b) =>
						b.setButtonText(t("common.reset")).setWarning().onClick(async () => {
							await this.host.resetSetup();
							this.display();
						}),
					),
			);
		}
	}

	// --- 헬퍼 ---
	/** 섹션 그룹 생성(.setting-group). 선택적 설명은 그룹 상단 설명 행으로 추가. */
	private group(heading: string, desc?: string): SettingGroup {
		const g = new SettingGroup(this.containerEl).setHeading(heading);
		if (desc) g.addSetting((set) => set.setDesc(desc));
		return g;
	}

	/**
	 * 그룹 안에 접이(details) 하위 영역을 만들어 본문 컨테이너를 반환(평가 P2-2 — 고급 항목 정보구조 정리).
	 * 자주 안 만지는 항목(실시간 시크릿·서비스 계정 등)을 기본 접힘으로 숨겨 설정 탭 첫 화면을 가볍게 한다.
	 * 본문에 `new Setting(body)`로 항목을 추가한다.
	 */
	private collapsible(group: SettingGroup, summary: string): HTMLElement {
		const det = group.listEl.createEl("details", { cls: "covault-advanced" });
		det.createEl("summary", { text: summary });
		return det.createDiv({ cls: "covault-advanced-body" });
	}

	/** 명명 그룹 생성/수정 모달. */
	/** 폴더 경로 입력 검증: 비었으면 통과(기본값 대체), 잘못된 경로면 Notice 후 false. */
	private okFolder(value: string): boolean {
		if (!value) return true;
		if (!validateFolderName(value)) {
			new Notice(t("settings.invalid_folder_path_no_absolute_paths", { path: value }));
			return false;
		}
		return true;
	}

	/** 콘텐츠 템플릿 경로 입력 + "기본 템플릿 만들기" 버튼 한 줄. */
	private textSetting(
		group: SettingGroup,
		name: string,
		key: keyof CoVaultSettings,
		placeholder: string,
		opts?: { applyOnBlur?: boolean },
	): void {
		const s = this.host.settings;
		group.addSetting((set) =>
			set.setName(name).addText((t) => {
				commitOnBlur(t.setPlaceholder(placeholder).setValue(String(s[key] ?? "")), async (v) => {
					(s[key] as unknown as string) = v.trim();
					await this.host.saveSettings();
				});
				noAutoCorrect(t.inputEl);
				if (opts?.applyOnBlur) this.applyOnBlur(t.inputEl);
			}),
		);
	}

	/** 구조 필드(연결·학생·공유): 타이핑 중엔 적용하지 않고, 포커스가 빠질 때 값이 바뀌었으면 자동 적용. */
	private applyOnBlur(input: HTMLInputElement): void {
		let focusVal = input.value;
		input.addEventListener("focus", () => {
			focusVal = input.value;
		});
		input.addEventListener("blur", () => {
			if (input.value !== focusVal) {
				focusVal = input.value;
				this.host.requestApply();
			}
		});
	}

	private readonlySetting(group: SettingGroup, name: string, value: string): void {
		group.addSetting((set) => set.setName(name).addText((t) => t.setValue(value).setDisabled(true)));
	}

	private async runAsync(b: { setDisabled(v: boolean): unknown }, fn: () => Promise<void>): Promise<void> {
		b.setDisabled(true);
		try {
			await fn();
		} finally {
			b.setDisabled(false);
		}
	}
}
