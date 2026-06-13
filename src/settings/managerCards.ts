import { Setting, SettingGroup } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace } from "./types";
import { ConfirmModal } from "../ui/ConfirmModal";
import { DeviceAccountsModal } from "../ui/DeviceAccountsModal";
import { MemberSelectModal } from "../ui/MemberSelectModal";
import { sharedSpaceStatus } from "./sharedSpaceStatus";
import { noAutoCorrect } from "./settingsUi";
import type { ManagerCtx } from "./managerSection";
import { t } from "../i18n";

/**
 * 매니저 설정의 공유 공간·구성원 카드 렌더(평가 P2-3 — managerSection에서 더 분리해 파일 크기 캡 이하 유지).
 * ManagerCtx를 주입받아 거동 보존. renderManager가 호출한다.
 */
export function renderSharedCard(c: ManagerCtx, group: SettingGroup, sp: SharedSpace, index: number): void {
	const s = c.host.settings;
	const card = group.listEl.createDiv({ cls: "covault-member-card" });

	new Setting(card)
		.setName(sp.name || t("settings.shared_space", { n: index + 1 }))
		.setHeading()
		.addButton((b) =>
			b
				.setButtonText(sp.provisioned ? t("common.redeploy") : t("common.deploy"))
				.setCta()
				.onClick(() => c.runAsync(b, async () => { await c.host.deployShared(sp); c.display(); })),
		)
		.addButton((b) =>
			b
				.setButtonText(t("common.delete"))
				.setWarning()
				.onClick(() =>
					new ConfirmModal(c.host.app, {
						title: t("panel.delete_shared_space", { name: sp.name || sp.id }),
						message: t("panel.removes_this_shared_space_from_the",
						),
						warning: true,
						checkbox: sp.provisioned
							? { label: t("settings.also_delete_server_data"), desc: t("settings.also_delete_shared_server_desc") }
							: undefined,
						onConfirm: async (alsoServer) => {
							if (alsoServer) await c.host.deleteSharedServer(sp);
							s.sharedSpaces.splice(index, 1);
							await c.host.saveSettings();
							// 구성원 shares에서 이 공간을 제거 → 구성원이 더 이상 동기화하지 않음.
							await c.host.refreshMemberShares();
							await c.host.restartMode();
							c.display();
						},
					}).open(),
				),
		);

	new Setting(card).setName(t("settings.name")).addText((txt) => {
		txt.setPlaceholder(t("settings.group_1")).setValue(sp.name).onChange(async (v) => {
			sp.name = v.trim();
			if (!sp.folder) sp.folder = v.trim();
			await c.host.saveSettings();
		});
		noAutoCorrect(txt.inputEl);
		c.applyOnBlur(txt.inputEl);
	});
	new Setting(card).setName(t("settings.folder")).addText((txt) => {
		txt.setPlaceholder(t("settings.group_1")).setValue(sp.folder).onChange(async (v) => {
			const v2 = v.trim();
			if (!c.okFolder(v2)) return;
			sp.folder = v2;
			await c.host.saveSettings();
		});
		noAutoCorrect(txt.inputEl);
		c.applyOnBlur(txt.inputEl);
	});

	// 학급 공동 공간 지정 — 알림장·수업안내·과제(공유) 등 학급 운영 기능이 이 공간의 폴더/DB를 기준으로 동작.
	new Setting(card)
		.setName(t("settings.homeroom_space"))
		.setDesc(t("settings.homeroom_space_desc"))
		.addToggle((tg) =>
			tg.setValue(sp.kind === "homeroom").onChange(async (v) => {
				await c.host.setHomeroomSpace(sp, v);
				c.display();
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
					await c.host.saveSettings();
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
					await c.host.saveSettings();
				});
			});
	}

	// 구성원 선택 — 카드마다 다중선택 모달 버튼 하나로(평가 P2-2). 과거엔 공간×구성원 토글 그리드가
	// O(M×N)으로 늘어 한 토글 변경마다 전체 재렌더했다. 이제 버튼이 현재 선택 수만 표시하고,
	// 모달에서 스크롤 목록 + 전체/해제로 고른 뒤 저장 시에만 갱신한다.
	const membersWithId = s.members.filter((st) => st.memberId).map((st) => ({ memberId: st.memberId, memberName: st.memberName || st.memberId }));
	new Setting(card)
		.setName(t("panel.members"))
		.setDesc(t("settings.members_selected", { n: sp.members.length }))
		.addButton((b) =>
			b.setButtonText(t("settings.select_members")).onClick(() => {
				new MemberSelectModal(c.app, t("settings.select_members"), membersWithId, sp.members, async (ids) => {
					sp.members = ids;
					await c.host.saveSettings();
					c.display(); // 선택 수·배지(재배포 필요) 갱신
				}).open();
			}),
		);

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

export function renderMemberCard(c: ManagerCtx, group: SettingGroup, st: MemberConfig, index: number): void {
	const card = group.listEl.createDiv({ cls: "covault-member-card" });

	const head = new Setting(card)
		.setName(st.memberName || st.memberId || t("settings.member", { n: index + 1 }))
		.setHeading()
		.addButton((b) =>
			b
				.setButtonText(st.provisioned ? t("settings.reissue_invite") : t("settings.invite"))
				.setCta()
				.onClick(() => c.runAsync(b, async () => { await c.host.inviteMember(st); c.display(); })),
		);
	if (st.provisioned) {
		head.addButton((b) =>
			b
				.setButtonText(t("invite.reissue_password"))
				.setTooltip(t("invite.replaces_the_password_with_a_new"))
				.onClick(() => c.runAsync(b, async () => { await c.host.rotateMemberPassword(st); c.display(); })),
		);
		head.addButton((b) =>
			b
				.setButtonText(t("device.manage_button", { n: (st.deviceAccounts ?? []).length }))
				.setTooltip(t("device.manage_tooltip"))
				.onClick(() => new DeviceAccountsModal(c.host, st).open()),
		);
	}
	head
		.addButton((b) =>
			b
				.setButtonText(t("common.delete"))
				.setWarning()
				.onClick(() =>
					new ConfirmModal(c.host.app, {
						title: t("panel.delete_member", { name: st.memberName || st.memberId || t("common.member") }),
						message: t("panel.removes_this_member_from_the_list",
						),
						warning: true,
						checkbox: st.provisioned
							? { label: t("settings.also_delete_server_data"), desc: t("settings.also_delete_member_server_desc") }
							: undefined,
						onConfirm: async (alsoServer) => {
							if (alsoServer) await c.host.deleteMemberServer(st);
							c.host.settings.members.splice(index, 1);
							await c.host.saveSettings();
							await c.host.restartMode();
							c.display();
						},
					}).open(),
				),
		);

	memberField(c, card, t("settings.name"), st, "memberName", t("common.member_a"));
	memberField(c, card, t("settings.member_id"), st, "memberId", "member_a");
	// 비우면 초대 시점에 학생 ID로 자동 채움 (계정=ID, DB=mirror_<ID>, 폴더=이름/ID)
	memberField(c, card, t("settings.mirror_db_auto_if_empty"), st, "remoteDb", t("settings.mirror_memberid"));
	memberField(c, card, t("settings.folder_auto_if_empty"), st, "localRoot", t("settings.name_or_memberid"));

	card.createEl("div", {
		cls: "covault-member-status",
		text: st.provisioned ? t("settings.status_provisioned") : t("settings.status_not_provisioned_pressing_invite_creates"),
	});
}

function memberField(c: ManagerCtx, card: HTMLElement, name: string, st: MemberConfig, key: keyof MemberConfig, placeholder: string): void {
	new Setting(card).setName(name).addText((tx) => {
		tx.setPlaceholder(placeholder)
			.setValue(String(st[key] ?? ""))
			.onChange(async (v) => {
				const v2 = v.trim();
				if (key === "localRoot" && !c.okFolder(v2)) return; // 잘못된 폴더 경로는 저장하지 않음
				(st[key] as unknown as string) = v2;
				await c.host.saveSettings();
			});
		noAutoCorrect(tx.inputEl);
		c.applyOnBlur(tx.inputEl); // 칸을 벗어나면 자동 적용
	});
}
