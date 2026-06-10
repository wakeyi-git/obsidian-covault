import { setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton, iconButton } from "./PanelSection";
import { GroupEditModal } from "../GroupEditModal";
import { ConfirmModal } from "../ConfirmModal";
import { resolveMemberNames } from "../../core/classroom/people";
import { GroupConfig } from "../../settings/types";
import { t } from "../../i18n";

/** 그룹 탭 — 교사는 명명 그룹 관리(생성/수정/삭제), 구성원은 자신이 속한 그룹 보기 + 대화방 열기. */
export class GroupsSection implements PanelSection {
	private root: HTMLElement | null = null;

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	render(container: HTMLElement): void {
		this.root = container;
		container.addClass("covault-panel-section");
		if (this.manager) this.draw();
		else void this.drawMember();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		c.empty();
		c.createDiv({ cls: "covault-dash-label", text: t("group.groups") });
		c.createDiv({ cls: "covault-cr-muted", text: t("group.manage_hint") });

		const actions = c.createDiv({ cls: "covault-panel-actions" });
		panelButton(actions, t("group.new"), () => this.edit(null), { cta: true });

		const groups = this.host.listGroups().filter((g) => !g.temp); // 임시 그룹은 대화방 목록에서 관리
		if (groups.length === 0) {
			c.createDiv({ cls: "covault-cr-muted", text: t("group.none") });
			return;
		}
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const g of groups) {
			const card = list.createDiv({ cls: "covault-cr-card" });
			const head = card.createDiv({ cls: "covault-cr-card-head" });
			head.createSpan({ cls: "covault-cr-card-title", text: g.name });
			const chat = head.createEl("button", { cls: "clickable-icon covault-rt-groupbtn" });
			setIcon(chat, "messages-square");
			chat.setAttr("aria-label", t("group.open_chat"));
			chat.title = t("group.open_chat");
			chat.onclick = () => void this.host.openGroupChat(g.id);
			iconButton(head, "pencil", t("dashboard.edit"), () => this.edit(g));
			iconButton(head, "trash-2", t("common.delete"), () => this.confirmDelete(g));

			const names = resolveMemberNames(g.memberIds, this.host.settings.members);
			card.createDiv({ cls: "covault-cr-muted", text: `${t("group.n_members", { n: g.memberIds.length })} · ${names.join(", ") || "—"}` });
		}
	}

	/** 구성원 보기 — 동기화로 받은 내 소속 그룹 대화방 목록(관리 기능 없음). */
	private async drawMember(): Promise<void> {
		const c = this.root;
		if (!c) return;
		const groups = await this.host.listChatGroups().catch(() => []);
		if (this.root !== c) return; // 비동기 대기 중 dispose되었으면 중단
		c.empty();
		c.createDiv({ cls: "covault-dash-label", text: t("group.groups") });
		c.createDiv({ cls: "covault-cr-muted", text: t("group.member_hint") });
		if (groups.length === 0) {
			c.createDiv({ cls: "covault-cr-muted", text: t("group.none_member") });
			return;
		}
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const g of groups) {
			const card = list.createDiv({ cls: "covault-cr-card" });
			const head = card.createDiv({ cls: "covault-cr-card-head" });
			head.createSpan({ cls: "covault-cr-card-title", text: g.temp ? `${g.name} ${t("group.temp_suffix")}` : g.name });
			const chat = head.createEl("button", { cls: "clickable-icon covault-rt-groupbtn" });
			setIcon(chat, "messages-square");
			chat.setAttr("aria-label", t("group.open_chat"));
			chat.title = t("group.open_chat");
			chat.onclick = () => void this.host.openChat(g.channel);

			// 구성원 기기에는 동료 명단이 없어 그룹 문서에 담긴 이름을 사용.
			const names = g.memberIds.map((id) => g.memberNames?.[id] || id);
			card.createDiv({ cls: "covault-cr-muted", text: `${t("group.n_members", { n: g.memberIds.length })} · ${names.join(", ") || "—"}` });
		}
	}

	private edit(group: GroupConfig | null): void {
		const members = this.host.settings.members
			.filter((m) => m.memberId)
			.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
		new GroupEditModal(this.host.app, members, group, async (g) => {
			await this.host.saveGroup(g);
			this.draw();
		}).open();
	}

	private confirmDelete(g: GroupConfig): void {
		new ConfirmModal(this.host.app, {
			title: t("common.delete"),
			message: t("group.delete_confirm", { name: g.name }),
			confirmText: t("common.delete"),
			warning: true,
			onConfirm: async () => {
				await this.host.deleteGroup(g.id);
				this.draw();
			},
		}).open();
	}

	dispose(): void {
		this.root = null;
	}
}
