import { App, Notice, Plugin, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace } from "./types";
import { ExportModal, ImportModal } from "../ui/BackupModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import { MemberBulkImportModal } from "../ui/MemberBulkImportModal";
import { PathSuggest } from "../ui/PathSuggest";
import { validateFolderName, foldersOverlap } from "../core/path/path";
import { validateSettings, SettingsIssue } from "./validateSettings";
import { sharedSpaceStatus } from "./sharedSpaceStatus";
import { getSecretValue, setSecretValue, hasSecretStorage, YJS_SECRET_ID, COUCH_PASSWORD_ID } from "../core/secret";
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
	redeployRealtime(): Promise<void>;
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
		// 실시간 자격증명은 marker가 아니라 실제 Secret Storage 값으로 판단(지워진 비밀값을 marker가 가리지 않게).
		const realtimeCredPresent = !!getSecretValue(this.app, YJS_SECRET_ID, s.yjsSecret);
		const issues = validateSettings(s, { realtimeCredPresent });
		if (issues.length === 0) return;
		const box = this.containerEl.createDiv({ cls: "covault-issues" });
		box.createDiv({ cls: "covault-issues-title", text: t("panel.settings_need_attention", { n: issues.length }) });
		for (const i of issues) {
			const row = box.createDiv({ cls: `covault-issue is-${i.level}` });
			row.setText((i.level === "error" ? "⛔ " : "⚠ ") + issueMessage(i));
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
		const klass = this.group(t("settings.workspace"));
		klass.addSetting((set) =>
			set
				.setName(t("settings.setup_wizard"))
				.setDesc(t("settings.setup_wizard_desc"))
				.addButton((b) => b.setButtonText(t("settings.run_setup_wizard")).setCta().onClick(() => this.host.openSetupWizard())),
		);
		this.textSetting(klass, t("settings.workspace_id"), "workspaceId", "ws_2026_1");

		const admin = this.group(t("settings.admin_account"), t("settings.credentials_for_creating_member_accounts_dbs"));
		this.textSetting(admin, t("settings.display_name"), "displayName", t("common.manager"));
		this.textSetting(admin, "CouchDB URL", "couchdbUrl", "https://nas.example.com", { applyOnBlur: true });
		this.textSetting(admin, t("settings.admin_username"), "username", "admin", { applyOnBlur: true });
		this.passwordSetting(admin);
		admin.addSetting((set) =>
			set
				.setName(t("settings.connection_test"))
				.setDesc(t("settings.checks_access_and_permissions_for_every"))
				.addButton((b) =>
					b.setButtonText(t("common.run_test")).setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);
		admin.addSetting((set) =>
			set
				.setName(t("settings.invite_expiry_days"))
				.setDesc(t("settings.invite_expiry_days_desc"))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.inviteTtlDays ?? 0));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
						const n = Number(v);
						s.inviteTtlDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
						await this.host.saveSettings();
					});
				}),
		);

		// 학생 목록 (카드)
		const members = this.group(
			t("settings.individual_spaces"),
			s.members.length === 0 ? t("settings.add_your_first_member_with_add") : undefined,
		);
		s.members.forEach((st, i) => this.renderMemberCard(members, st, i));
		const pending = s.members.filter((st) => st.memberId && !st.provisioned).length;
		members.addSetting((set) => {
			set
				.setClass("covault-add-row")
				.addButton((b) =>
					b
						.setButtonText(t("settings.add_member"))
						.setCta()
						.onClick(async () => {
							s.members.push({ memberId: "", memberName: "", remoteDb: "", localRoot: "", username: "" });
							await this.host.saveSettings();
							this.display();
						}),
				)
				.addButton((b) =>
					b.setButtonText(t("settings.paste_roster")).onClick(() =>
						new MemberBulkImportModal(
							this.host.app,
							s.members.map((st) => st.memberId).filter((id) => id),
							async (added) => {
								s.members.push(...added);
								await this.host.saveSettings();
								this.host.requestApply();
								this.display();
							},
						).open(),
					),
				);
			if (pending > 0) {
				set.addButton((b) =>
					b
						.setButtonText(t("settings.invite_all"))
						.setTooltip(t("settings.invite_all_pending", { n: pending }))
						.onClick(() => this.runAsync(b, async () => { await this.host.inviteAllMembers(); this.display(); })),
				);
			}
		});

		// 공유 공간 (모둠/학급)
		const shared = this.group(t("settings.shared_spaces_group_workspace"), t("settings.pick_members_and_deploy_to_create"));
		s.sharedSpaces.forEach((sp, i) => this.renderSharedCard(shared, sp, i));
		shared.addSetting((set) =>
			set.setClass("covault-add-row").addButton((b) =>
				b
					.setButtonText(t("settings.add_shared_space"))
					.setCta()
					.onClick(async () => {
						const id = `g${Date.now().toString(36)}`;
						s.sharedSpaces.push({ id, name: "", remoteDb: `share_${id}`, folder: "", members: [] });
						await this.host.saveSettings();
						this.display();
					}),
			),
		);

		// 콘텐츠 템플릿 (알림장·수업·과제)
		const tpl = this.group(t("settings.content_templates"), t("settings.content_templates_desc"));
		this.templateRow(tpl, t("settings.notice_template"), "noticeTemplate", "notice");
		this.templateRow(tpl, t("settings.lesson_template"), "lessonTemplate", "lesson");
		this.templateRow(tpl, t("settings.assignment_template"), "assignmentTemplate", "assignment");

		// 실시간 공동 편집 (Yjs)
		const rt = this.group(
			t("settings.realtime_co_editing_yjs"),
			t("settings.edit_shared_folder_documents_character_by"),
		);
		rt.addSetting((set) =>
			set
				.setName(t("settings.enable_realtime_editing"))
				.setDesc(t("settings.enable_realtime_editing_desc"))
				.addToggle((tg) =>
					tg.setValue(s.realtimeEnabled).onChange(async (v) => {
						s.realtimeEnabled = v;
						await this.host.saveSettings();
						// 전역 토글이 모든 개인 폴더·공동 공간에 적용 — 토큰 재발급 + 전파.
						await this.host.redeployRealtime();
					}),
				),
		);
		this.textSetting(rt, t("settings.yjs_server_url"), "yjsServerUrl", "wss://yjs.example.com");
		// 레거시 전역 Yjs 토큰 입력은 제거됨 — 실시간 인증은 공간별 HMAC 토큰(아래 시크릿으로 발급)만 사용.
		rt.addSetting((set) =>
			set
				.setName(t("settings.yjs_space_secret_hmac_recommended"))
				.setDesc(t("settings.when_set_issues_a_signed_token"))
				.addText((txt) => {
					txt.setPlaceholder(t("settings.same_as_server_yjs_secret")).setValue(getSecretValue(this.host.app, YJS_SECRET_ID, s.yjsSecret)).onChange(async (v) => {
						const val = v.trim();
						setSecretValue(this.host.app, YJS_SECRET_ID, val);
						s.yjsSecretSet = !!val;
						s.yjsSecret = undefined; // 평문 제거(secretStorage로 이전)
						await this.host.saveSettings();
					});
					txt.inputEl.type = "password";
					noAutoCorrect(txt.inputEl);
				}),
		);
		rt.addSetting((set) =>
			set
				.setName(t("settings.space_token_expiry_days"))
				.setDesc(t("settings.0_no_expiry_set_a_value"))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.yjsTokenTtlDays ?? 0));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
						const n = Number(v);
						s.yjsTokenTtlDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
						await this.host.saveSettings();
					});
				}),
		);
		rt.addSetting((set) =>
			set
				.setName(t("settings.in_session_snapshot_interval_sec"))
				.setDesc(t("settings.periodically_saves_content_to_couchdb_during"))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
						const n = Number(v);
						s.realtimeSnapshotSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
						await this.host.saveSettings();
					});
				}),
		);

	}

	private renderSharedCard(group: SettingGroup, sp: SharedSpace, index: number): void {
		const s = this.host.settings;
		const card = group.listEl.createDiv({ cls: "covault-member-card" });

		new Setting(card)
			.setName(sp.name || t("settings.shared_space", { n: index + 1 }))
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(sp.provisioned ? t("common.redeploy") : t("common.deploy"))
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.deployShared(sp); this.display(); })),
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.delete"))
					.setWarning()
					.onClick(() =>
						new ConfirmModal(this.host.app, {
							title: t("panel.delete_shared_space", { name: sp.name || sp.id }),
							message: t("panel.removes_this_shared_space_from_the",
							),
							warning: true,
							checkbox: sp.provisioned
								? { label: t("settings.also_delete_server_data"), desc: t("settings.also_delete_shared_server_desc") }
								: undefined,
							onConfirm: async (alsoServer) => {
								if (alsoServer) await this.host.deleteSharedServer(sp);
								s.sharedSpaces.splice(index, 1);
								await this.host.saveSettings();
								// 구성원 shares에서 이 공간을 제거 → 구성원이 더 이상 동기화하지 않음.
								await this.host.refreshMemberShares();
								await this.host.restartMode();
								this.display();
							},
						}).open(),
					),
			);

		new Setting(card).setName(t("settings.name")).addText((txt) => {
			txt.setPlaceholder(t("settings.group_1")).setValue(sp.name).onChange(async (v) => {
				sp.name = v.trim();
				if (!sp.folder) sp.folder = v.trim();
				await this.host.saveSettings();
			});
			noAutoCorrect(txt.inputEl);
			this.applyOnBlur(txt.inputEl);
		});
		new Setting(card).setName(t("settings.folder")).addText((txt) => {
			txt.setPlaceholder(t("settings.group_1")).setValue(sp.folder).onChange(async (v) => {
				const v2 = v.trim();
				if (!this.okFolder(v2)) return;
				sp.folder = v2;
				await this.host.saveSettings();
			});
			noAutoCorrect(txt.inputEl);
			this.applyOnBlur(txt.inputEl);
		});

		// 학급 공동 공간 지정 — 알림장·수업안내·과제(공유) 등 학급 운영 기능이 이 공간의 폴더/DB를 기준으로 동작.
		new Setting(card)
			.setName(t("settings.homeroom_space"))
			.setDesc(t("settings.homeroom_space_desc"))
			.addToggle((tg) =>
				tg.setValue(sp.kind === "homeroom").onChange(async (v) => {
					await this.host.setHomeroomSpace(sp, v);
					this.display();
				}),
			);

		// 학급 공동 공간일 때만: 학급 운영 특화 기능(모듈) 활성화 토글.
		if (sp.kind === "homeroom") {
			card.createDiv({ cls: "covault-dash-label", text: t("settings.classroom_modules") });
			const modules: Array<[keyof NonNullable<CoVaultSettings["classroomModules"]>, string]> = [
				["notices", t("dashboard.notices")],
				["lessons", t("dashboard.lessons")],
				["assignments", t("dashboard.assignments")],
				["routines", t("dashboard.routines")],
				["gradebook", t("dashboard.gradebook")],
			];
			for (const [key, label] of modules) {
				new Setting(card).setName(label).addToggle((tg) =>
					tg.setValue(s.classroomModules?.[key] !== false).onChange(async (v) => {
						s.classroomModules = { ...(s.classroomModules ?? {}), [key]: v };
						await this.host.saveSettings();
					}),
				);
			}
			new Setting(card)
				.setName(t("settings.dashboard_page_size"))
				.setDesc(t("settings.dashboard_page_size_desc"))
				.addText((txt) => {
					txt.setPlaceholder("10").setValue(String(s.dashboardPageSize ?? 10));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.dashboardPageSize = Number.isFinite(n) && n > 0 ? n : 10;
						await this.host.saveSettings();
					});
				});
		}

		const memberHead = new Setting(card).setName(t("panel.members"));
		const membersWithId = s.members.filter((st) => st.memberId);
		memberHead.addButton((b) =>
			b.setButtonText(t("deploy.select_all")).onClick(async () => {
				sp.members = membersWithId.map((st) => st.memberId);
				await this.host.saveSettings();
				this.display();
			}),
		);
		memberHead.addButton((b) =>
			b.setButtonText(t("deploy.none")).onClick(async () => {
				sp.members = [];
				await this.host.saveSettings();
				this.display();
			}),
		);
		for (const st of membersWithId) {
			new Setting(card).setName(st.memberName || st.memberId).addToggle((tg) =>
				tg.setValue(sp.members.includes(st.memberId)).onChange(async (v) => {
					if (v && !sp.members.includes(st.memberId)) sp.members.push(st.memberId);
					else if (!v) sp.members = sp.members.filter((m) => m !== st.memberId);
					await this.host.saveSettings();
					this.display(); // 배지(재배포 필요) 갱신
				}),
			);
		}

		const status = sharedSpaceStatus(sp);
		const badge =
			status === "unprovisioned"
				? t("panel.not_deployed")
				: status === "needs-redeploy"
					? t("panel.members_changed_redeploy_needed")
					: t("panel.deployed");
		const statusEl = card.createEl("div", {
			cls: "covault-member-status",
			text: t("panel.db", { db: sp.remoteDb, badge }),
		});
		if (status === "needs-redeploy") statusEl.addClass("covault-dash-conflict");
	}

	private renderMemberCard(group: SettingGroup, st: MemberConfig, index: number): void {
		const card = group.listEl.createDiv({ cls: "covault-member-card" });

		const head = new Setting(card)
			.setName(st.memberName || st.memberId || t("settings.member", { n: index + 1 }))
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(st.provisioned ? t("settings.reissue_invite") : t("settings.invite"))
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.inviteMember(st); this.display(); })),
			);
		if (st.provisioned) {
			head.addButton((b) =>
				b
					.setButtonText(t("invite.reissue_password"))
					.setTooltip(t("invite.replaces_the_password_with_a_new"))
					.onClick(() => this.runAsync(b, async () => { await this.host.rotateMemberPassword(st); this.display(); })),
			);
		}
		head
			.addButton((b) =>
				b
					.setButtonText(t("common.delete"))
					.setWarning()
					.onClick(() =>
						new ConfirmModal(this.host.app, {
							title: t("panel.delete_member", { name: st.memberName || st.memberId || t("common.member") }),
							message: t("panel.removes_this_member_from_the_list",
							),
							warning: true,
							checkbox: st.provisioned
								? { label: t("settings.also_delete_server_data"), desc: t("settings.also_delete_member_server_desc") }
								: undefined,
							onConfirm: async (alsoServer) => {
								if (alsoServer) await this.host.deleteMemberServer(st);
								this.host.settings.members.splice(index, 1);
								await this.host.saveSettings();
								await this.host.restartMode();
								this.display();
							},
						}).open(),
					),
			);

		this.memberField(card, t("settings.name"), st, "memberName", t("common.member_a"));
		this.memberField(card, t("settings.member_id"), st, "memberId", "member_a");
		// 비우면 초대 시점에 학생 ID로 자동 채움 (계정=ID, DB=mirror_<ID>, 폴더=이름/ID)
		this.memberField(card, t("settings.mirror_db_auto_if_empty"), st, "remoteDb", t("settings.mirror_memberid"));
		this.memberField(card, t("settings.folder_auto_if_empty"), st, "localRoot", t("settings.name_or_memberid"));

		card.createEl("div", {
			cls: "covault-member-status",
			text: st.provisioned ? t("settings.status_provisioned") : t("settings.status_not_provisioned_pressing_invite_creates"),
		});
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

		g.addSetting((set) =>
			set
				.setName(t("settings.max_attachment_size_mb"))
				.setDesc(t("settings.attachments_larger_than_this_are_not"))
				.addText((txt) =>
					txt.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.maxAttachmentMB = Number.isFinite(n) && n >= 0 ? n : 20;
						await this.host.saveSettings();
					}),
				),
		);

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
					txt.setValue(String(s.mobileDebounceMs)).onChange(async (v) => {
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
					txt.onChange(async (v) => {
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
					txt.onChange(async (v) => {
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
					txt.onChange(async (v) => {
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
					txt.setPlaceholder(t("settings.deleted")).setValue(s.archiveFolder).onChange(async (v) => {
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
					txt.setPlaceholder(t("settings.conflict")).setValue(s.conflictFolder).onChange(async (v) => {
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
					txt.setValue(s.excludeFolders.join(", ")).onChange(async (v) => {
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

	/** 폴더 경로 입력 검증: 비었으면 통과(기본값 대체), 잘못된 경로면 Notice 후 false. */
	private okFolder(value: string): boolean {
		if (!value) return true;
		if (!validateFolderName(value)) {
			new Notice(t("settings.invalid_folder_path_no_absolute_paths", { path: value }));
			return false;
		}
		return true;
	}

	private memberField(card: HTMLElement, name: string, st: MemberConfig, key: keyof MemberConfig, placeholder: string): void {
		new Setting(card).setName(name).addText((t) => {
			t.setPlaceholder(placeholder)
				.setValue(String(st[key] ?? ""))
				.onChange(async (v) => {
					const v2 = v.trim();
					if (key === "localRoot" && !this.okFolder(v2)) return; // 잘못된 폴더 경로는 저장하지 않음
					(st[key] as unknown as string) = v2;
					await this.host.saveSettings();
				});
			noAutoCorrect(t.inputEl);
			this.applyOnBlur(t.inputEl); // 칸을 벗어나면 자동 적용
		});
	}

	/** 콘텐츠 템플릿 경로 입력 + "기본 템플릿 만들기" 버튼 한 줄. */
	private templateRow(group: SettingGroup, name: string, key: keyof CoVaultSettings, kind: "notice" | "lesson" | "assignment"): void {
		const s = this.host.settings;
		group.addSetting((set) => {
			set.setName(name)
				.setDesc(t("settings.template_path_optional_desc"))
				.addText((txt) => {
					txt.setPlaceholder(t("settings.blank_uses_built_in")).setValue(String(s[key] ?? "")).onChange(async (v) => {
						(s[key] as unknown as string) = v.trim();
						await this.host.saveSettings();
					});
					new PathSuggest(this.host.app, txt.inputEl, { extensions: ["md"] });
					noAutoCorrect(txt.inputEl);
					this.applyOnBlur(txt.inputEl);
				})
				.addButton((b) =>
					b
						.setButtonText(t("settings.create_default_template"))
						.setTooltip(t("settings.create_default_template_desc"))
						.onClick(() => this.runAsync(b, async () => { await this.host.createTemplateFile(kind); this.display(); })),
				);
		});
	}

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
				t.setPlaceholder(placeholder)
					.setValue(String(s[key] ?? ""))
					.onChange(async (v) => {
						(s[key] as unknown as string) = v.trim();
						await this.host.saveSettings();
					});
				noAutoCorrect(t.inputEl);
				if (opts?.applyOnBlur) this.applyOnBlur(t.inputEl);
			}),
		);
	}

	private passwordSetting(group: SettingGroup): void {
		const s = this.host.settings;
		group.addSetting((set) =>
			set.setName(t("settings.admin_password")).addText((txt) => {
				// Secret Storage 우선 저장(평문 data.json 회피), 미지원 환경만 평문 폴백.
				txt.setPlaceholder("********").setValue(getSecretValue(this.host.app, COUCH_PASSWORD_ID, s.password)).onChange(async (v) => {
					const val = v.trim();
					if (setSecretValue(this.host.app, COUCH_PASSWORD_ID, val)) {
						s.passwordSet = true;
						s.password = "";
					} else {
						s.password = val;
					}
					await this.host.saveSettings();
				});
				txt.inputEl.type = "password";
				noAutoCorrect(txt.inputEl);
				this.applyOnBlur(txt.inputEl); // 연결 자격증명: 칸을 벗어나면 자동 적용
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

/** 모바일에서 자격증명/ID가 자동 대문자화·자동완성으로 망가지는 것을 방지. */
function noAutoCorrect(el: HTMLInputElement): void {
	el.setAttribute("autocapitalize", "none");
	el.setAttribute("autocorrect", "off");
	el.setAttribute("autocomplete", "off");
	el.spellcheck = false;
}
