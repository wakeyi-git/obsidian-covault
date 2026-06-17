import { App, Setting, SettingGroup } from "obsidian";
import { CoVaultSettings, GroupConfig } from "./types";
import type { SettingsHost } from "./SettingsTab";
import { ConfirmModal } from "../ui/ConfirmModal";
import { GroupEditModal } from "../ui/GroupEditModal";
import { MemberBulkImportModal } from "../ui/MemberBulkImportModal";
import { PathSuggest } from "../ui/PathSuggest";
import { resolveMemberNames } from "../core/classroom/people";
import { renderSharedCard, renderMemberCard } from "./managerCards";
import { setSecretValue, getYjsSecret, getCouchPassword, persistCouchPassword, YJS_SECRET_ID, RT_SERVICE_PASSWORD_ID } from "../core/secret";
import { noAutoCorrect, commitOnBlur } from "./settingsUi";
import { t } from "../i18n";

/**
 * 매니저(교사) 설정 섹션 렌더링(평가 P2-3 — SettingsTab 갓 클래스 분할). SettingsTab의 공용 헬퍼·수명주기는
 * ManagerCtx로 주입받고, 매니저 전용 렌더(공유 공간·구성원 카드·그룹·템플릿 등)는 이 모듈이 담당한다.
 * 거동은 분할 전 SettingsTab.renderManager와 동일 — `this.X`를 `c.X`로, 매니저 전용 헬퍼는 모듈 함수로 옮겼을 뿐.
 */
export interface ManagerCtx {
	app: App;
	host: SettingsHost;
	display(): void;
	group(heading: string, desc?: string): SettingGroup;
	collapsible(group: SettingGroup, summary: string): HTMLElement;
	textSetting(group: SettingGroup, name: string, key: keyof CoVaultSettings, placeholder: string, opts?: { applyOnBlur?: boolean }): void;
	readonlySetting(group: SettingGroup, name: string, value: string): void;
	runAsync(b: { setDisabled(v: boolean): unknown }, fn: () => Promise<void>): Promise<void>;
	okFolder(value: string): boolean;
	applyOnBlur(input: HTMLInputElement): void;
}

export function renderManager(c: ManagerCtx, s: CoVaultSettings): void {
	const klass = c.group(t("settings.workspace"));
	klass.addSetting((set) =>
		set
			.setName(t("settings.setup_wizard"))
			.setDesc(t("settings.setup_wizard_desc"))
			.addButton((b) => b.setButtonText(t("settings.run_setup_wizard")).setCta().onClick(() => c.host.openSetupWizard())),
	);
	c.textSetting(klass, t("settings.workspace_id"), "workspaceId", "ws_2026_1");

	const admin = c.group(t("settings.admin_account"), t("settings.credentials_for_creating_member_accounts_dbs"));
	c.textSetting(admin, t("settings.display_name"), "displayName", t("common.manager"));
	c.textSetting(admin, "CouchDB URL", "couchdbUrl", "https://nas.example.com", { applyOnBlur: true });
	c.textSetting(admin, t("settings.admin_username"), "username", "admin", { applyOnBlur: true });
	passwordSetting(c, admin);
	admin.addSetting((set) =>
		set
			.setName(t("settings.connection_test"))
			.setDesc(t("settings.checks_access_and_permissions_for_every"))
			.addButton((b) =>
				b.setButtonText(t("common.run_test")).setCta().onClick(() => c.runAsync(b, () => c.host.testConnection())),
			),
	);
	admin.addSetting((set) =>
		set
			.setName(t("settings.invite_expiry_days"))
			.setDesc(t("settings.invite_expiry_days_desc"))
			.addText((txt) => {
				txt.setPlaceholder("0").setValue(String(s.inviteTtlDays ?? 0));
				txt.inputEl.type = "number";
				commitOnBlur(txt, async (v) => {
					const n = Number(v);
					s.inviteTtlDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
					await c.host.saveSettings();
				});
			}),
	);

	// 학생 목록 (카드)
	const members = c.group(
		t("settings.individual_spaces"),
		s.members.length === 0 ? t("settings.add_your_first_member_with_add") : undefined,
	);
	s.members.forEach((st, i) => renderMemberCard(c, members, st, i));
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
						await c.host.saveSettings();
						c.display();
					}),
			)
			.addButton((b) =>
				b.setButtonText(t("settings.paste_roster")).onClick(() =>
					new MemberBulkImportModal(
						c.host.app,
						s.members.map((st) => st.memberId).filter((id) => id),
						async (added) => {
							s.members.push(...added);
							await c.host.saveSettings();
							c.host.requestApply();
							c.display();
						},
					).open(),
				),
			);
		if (pending > 0) {
			set.addButton((b) =>
				b
					.setButtonText(t("settings.invite_all"))
					.setTooltip(t("settings.invite_all_pending", { n: pending }))
					.onClick(() => c.runAsync(b, async () => { await c.host.inviteAllMembers(); c.display(); })),
			);
		}
	});

	// 공유 공간 (모둠/학급)
	const shared = c.group(t("settings.shared_spaces_group_workspace"), t("settings.pick_members_and_deploy_to_create"));
	// 공유 파일 읽기 전용 정책(전 공동 공간 공통) — 실시간 탭에도 동일 토글.
	shared.addSetting((set) =>
		set
			.setName(t("realtime.shared_readonly"))
			.setDesc(t("realtime.shared_readonly_desc"))
			.addToggle((tg) =>
				tg.setValue(!!s.sharedReadOnly).onChange(async (v) => {
					await c.host.setSharedReadOnly(v);
				}),
			),
	);
	s.sharedSpaces.forEach((sp, i) => renderSharedCard(c, shared, sp, i));
	shared.addSetting((set) =>
		set.setClass("covault-add-row").addButton((b) =>
			b
				.setButtonText(t("settings.add_shared_space"))
				.setCta()
				.onClick(async () => {
					const id = `g${Date.now().toString(36)}`;
					s.sharedSpaces.push({ id, name: "", remoteDb: `share_${id}`, folder: "", members: [] });
					await c.host.saveSettings();
					c.display();
				}),
		),
	);

	// 명명 그룹 (대화방 + 라이브 세션 참여자 지정). 임시 그룹은 대화방 목록에서 관리하므로 제외.
	const grp = c.group(t("group.groups"), t("group.manage_hint"));
	const namedGroups = s.groups.filter((g) => !g.temp);
	if (namedGroups.length === 0) grp.addSetting((set) => set.setName(t("group.none")).setDisabled(true));
	for (const g of namedGroups) {
		grp.addSetting((set) => {
			set.setName(g.name).setDesc(resolveMemberNames(g.memberIds, s.members).join(", ") || "—");
			set.addExtraButton((b) => b.setIcon("messages-square").setTooltip(t("group.open_chat")).onClick(() => void c.host.openGroupChat(g.id)));
			set.addExtraButton((b) => b.setIcon("pencil").setTooltip(t("dashboard.edit")).onClick(() => editGroup(c, g)));
			set.addExtraButton((b) => b.setIcon("trash-2").setTooltip(t("common.delete")).onClick(() => confirmDeleteGroup(c, g)));
		});
	}
	grp.addSetting((set) =>
		set.setClass("covault-add-row").addButton((b) => b.setButtonText(t("group.new")).setCta().onClick(() => editGroup(c, null))),
	);
	// 구성원 자율 그룹(신청-승인) 정책.
	grp.addSetting((set) =>
		set
			.setName(t("group.auto_approve"))
			.setDesc(t("group.auto_approve_desc"))
			.addToggle((tg) =>
				tg.setValue(!!s.groupAutoApprove).onChange(async (v) => {
					s.groupAutoApprove = v;
					await c.host.saveSettings();
				}),
			),
	);
	grp.addSetting((set) =>
		set
			.setName(t("group.max_per_member"))
			.setDesc(t("group.max_per_member_desc"))
			.addText((tx) =>
				commitOnBlur(tx.setValue(String(s.groupMaxPerMember ?? 3)), async (v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n >= 0) {
						s.groupMaxPerMember = n;
						await c.host.saveSettings();
					}
				}),
			),
	);

	// 콘텐츠 템플릿 (알림장·수업·과제)
	const tpl = c.group(t("settings.content_templates"), t("settings.content_templates_desc"));
	templateRow(c, tpl, t("settings.notice_template"), "noticeTemplate", "notice");
	templateRow(c, tpl, t("settings.lesson_template"), "lessonTemplate", "lesson");
	templateRow(c, tpl, t("settings.assignment_template"), "assignmentTemplate", "assignment");

	// 내 볼트 개인 동기화(개별/공동 공간 제외)
	// 통합 변경 감지(H-6, 실험적) — 변경 시 모드 재시작으로 즉시 적용.
	shared.addSetting((set) =>
		set
			.setName(t("settings.db_updates_transport"))
			.setDesc(t("settings.db_updates_transport_desc"))
			.addToggle((tg) =>
				tg.setValue(s.managerSyncTransport === "db-updates").onChange((v) =>
					c.runAsync(tg, async () => {
						s.managerSyncTransport = v ? "db-updates" : "live";
						await c.host.saveSettings();
						await c.host.restartMode();
					}),
				),
			),
	);

	const personal = c.group(t("settings.personal_sync"), t("settings.personal_sync_desc"));
	personal.addSetting((set) =>
		set
			.setName(t("settings.personal_sync_enable"))
			.setDesc(t("settings.personal_sync_enable_desc"))
			.addToggle((tg) =>
				tg.setValue(!!s.personalSyncEnabled).onChange((v) => c.runAsync(tg, async () => { await c.host.setPersonalSync(v); c.display(); })),
			),
	);
	if (s.personalSyncEnabled && s.personalRemoteDb) {
		c.readonlySetting(personal, t("settings.personal_sync_db"), s.personalRemoteDb);
	}

	// 실시간 공동 편집 (Yjs)
	const rt = c.group(
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
					await c.host.saveSettings();
					// 전역 토글이 모든 개인 폴더·공동 공간에 적용 — 토큰 재발급 + 전파.
					await c.host.redeployRealtime();
				}),
			),
	);
	c.textSetting(rt, t("settings.yjs_server_url"), "yjsServerUrl", "wss://yjs.example.com");
	// 고급(보안 시크릿·서비스 계정)은 기본 접힘 — 자주 안 만지므로 첫 화면을 가볍게(평가 P2-2).
	// 레거시 전역 Yjs 토큰 입력은 제거됨 — 실시간 인증은 공간별 HMAC 토큰(아래 시크릿으로 발급)만 사용.
	const rtAdv = c.collapsible(rt, t("settings.realtime_advanced"));
	new Setting(rtAdv)
		.setName(t("settings.yjs_space_secret_hmac_recommended"))
		.setDesc(t("settings.when_set_issues_a_signed_token"))
		.addText((txt) => {
			commitOnBlur(txt.setPlaceholder(t("settings.same_as_server_yjs_secret")).setValue(getYjsSecret(c.host.app, s.yjsSecret)), async (v) => {
				const val = v.trim();
				setSecretValue(c.host.app, YJS_SECRET_ID, val);
				s.yjsSecretSet = !!val;
				s.yjsSecret = undefined; // 평문 제거(secretStorage로 이전)
				await c.host.saveSettings();
			});
			txt.inputEl.type = "password";
			noAutoCorrect(txt.inputEl);
		});
	new Setting(rtAdv)
		.setName(t("settings.space_token_expiry_days"))
		.setDesc(t("settings.0_no_expiry_set_a_value"))
		.addText((txt) => {
			txt.setPlaceholder("0").setValue(String(s.yjsTokenTtlDays ?? 0));
			txt.inputEl.type = "number";
			commitOnBlur(txt, async (v) => {
				const n = Number(v);
				s.yjsTokenTtlDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
				await c.host.saveSettings();
			});
		});
	// 세션 중 CouchDB 스냅샷은 Hocuspocus 서버(onStoreDocument 디바운스)가 담당한다 — 주기 설정 UI 제거.
	// 서버가 CouchDB에 접근할 전용 계정(권장). 배포 시 계정을 만들고 share/mirror DB 권한을 부여한다.
	new Setting(rtAdv)
		.setName(t("settings.rt_service_account"))
		.setDesc(t("settings.rt_service_account_desc"))
		.addText((txt) => {
			txt.setPlaceholder("covault-rt").setValue(s.rtServiceUsername ?? "");
			noAutoCorrect(txt.inputEl);
			commitOnBlur(txt, async (v) => {
				s.rtServiceUsername = v.trim() || undefined;
				await c.host.saveSettings();
			});
		});
	new Setting(rtAdv)
		.setName(t("settings.rt_service_password"))
		.setDesc(t("settings.rt_service_password_desc"))
		.addText((txt) => {
			commitOnBlur(txt.setPlaceholder(s.rtServicePasswordSet ? t("common.set") : ""), async (v) => {
				const val = v.trim();
				setSecretValue(c.host.app, RT_SERVICE_PASSWORD_ID, val);
				s.rtServicePasswordSet = !!val;
				await c.host.saveSettings();
			});
			txt.inputEl.type = "password";
			noAutoCorrect(txt.inputEl);
		});
}

/** 명명 그룹 생성/수정 모달. */
function editGroup(c: ManagerCtx, group: GroupConfig | null): void {
	const members = c.host.settings.members
		.filter((m) => m.memberId)
		.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
	new GroupEditModal(c.app, members, group, async (g) => {
		await c.host.saveGroup(g);
		c.display();
	}).open();
}

function confirmDeleteGroup(c: ManagerCtx, g: GroupConfig): void {
	new ConfirmModal(c.app, {
		title: t("common.delete"),
		message: t("group.delete_confirm", { name: g.name }),
		confirmText: t("common.delete"),
		warning: true,
		onConfirm: async () => {
			await c.host.deleteGroup(g.id);
			c.display();
		},
	}).open();
}

/** 콘텐츠 템플릿 경로 입력 + "기본 템플릿 만들기" 버튼 한 줄. */
function templateRow(c: ManagerCtx, group: SettingGroup, name: string, key: keyof CoVaultSettings, kind: "notice" | "lesson" | "assignment"): void {
	const s = c.host.settings;
	group.addSetting((set) => {
		set.setName(name)
			.setDesc(t("settings.template_path_optional_desc"))
			.addText((txt) => {
				commitOnBlur(txt.setPlaceholder(t("settings.blank_uses_built_in")).setValue(String(s[key] ?? "")), async (v) => {
					(s[key] as unknown as string) = v.trim();
					await c.host.saveSettings();
				});
				new PathSuggest(c.host.app, txt.inputEl, { extensions: ["md"] });
				noAutoCorrect(txt.inputEl);
				c.applyOnBlur(txt.inputEl);
			})
			.addButton((b) =>
				b
					.setButtonText(t("settings.create_default_template"))
					.setTooltip(t("settings.create_default_template_desc"))
					.onClick(() => c.runAsync(b, async () => { await c.host.createTemplateFile(kind); c.display(); })),
			);
	});
}

function passwordSetting(c: ManagerCtx, group: SettingGroup): void {
	const s = c.host.settings;
	group.addSetting((set) =>
		set.setName(t("settings.admin_password")).addText((txt) => {
			// Secret Storage 우선 저장(평문 data.json 회피), 미지원 환경만 평문 폴백.
			commitOnBlur(txt.setPlaceholder("********").setValue(getCouchPassword(c.host.app, s.password)), async (v) => {
				persistCouchPassword(c.host.app, s, v.trim());
				await c.host.saveSettings();
			});
			txt.inputEl.type = "password";
			noAutoCorrect(txt.inputEl);
			c.applyOnBlur(txt.inputEl); // 연결 자격증명: 칸을 벗어나면 자동 적용
		}),
	);
}
