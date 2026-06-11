import { setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton, iconButton } from "./PanelSection";
import { GroupEditModal } from "../GroupEditModal";
import { GroupRequestModal } from "../GroupRequestModal";
import { ConfirmModal } from "../ConfirmModal";
import { resolveMemberNames } from "../../core/classroom/people";
import { GroupConfig } from "../../settings/types";
import { GroupRequestDoc } from "../../core/model/types";
import { t, formatDate } from "../../i18n";

/**
 * 그룹 탭 — 교사: 명명 그룹 관리(생성/수정/삭제) + 구성원 신청 승인/거절.
 * 구성원: 소속 그룹 보기 + 그룹 만들기 신청(승인되면 그룹 대화 + 그룹 폴더 실시간 공간이 생긴다).
 */
export class GroupsSection implements PanelSection {
	private root: HTMLElement | null = null;
	private timer: number | null = null;
	private sig = ""; // 데이터 시그니처 — 변화 없으면 재구성 생략(폴링이 클릭/모달을 끊지 않게)

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	render(container: HTMLElement): void {
		this.root = container;
		container.addClass("covault-panel-section");
		// 신청/승인 상태는 동기화로 변하므로 탭이 열린 동안 가볍게 폴링.
		this.timer = window.setInterval(() => void this.redraw(), 4000);
		void this.redraw();
	}

	private redraw(): Promise<void> {
		return this.manager ? this.draw() : this.drawMember();
	}

	private async draw(): Promise<void> {
		const c = this.root;
		if (!c) return;
		const pending = await this.host.listPendingGroupRequests().catch(() => []);
		if (this.root !== c) return;
		const groupsSig = this.host
			.listGroups()
			.map((g) => `${g.id}:${g.name}:${g.memberIds.join(",")}:${g.spaceId ?? ""}`)
			.join("|");
		const sig = `m|${pending.map((r) => `${r._id}:${r._rev ?? ""}`).join("|")}#${groupsSig}`;
		if (sig === this.sig && c.childElementCount > 0) return;
		this.sig = sig;
		c.empty();
		c.createDiv({ cls: "covault-cr-muted", text: t("group.manage_hint") });

		const actions = c.createDiv({ cls: "covault-panel-actions" });
		panelButton(actions, t("group.new"), () => this.edit(null), { cta: true });

		// 구성원 신청 대기 목록(승인/거절). 자동 승인이 꺼져 있을 때 여기서 처리한다.
		if (pending.length > 0) {
			c.createDiv({ cls: "covault-dash-label", text: t("group.pending_requests", { n: pending.length }) });
			const list = c.createDiv({ cls: "covault-dash-list" });
			for (const req of pending) this.requestCard(list, req);
		}

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
			// 신청-승인으로 만든 그룹: 그룹 공간 폴더 표시.
			const space = g.spaceId ? this.host.settings.sharedSpaces.find((sp) => sp.id === g.spaceId) : undefined;
			if (space) card.createDiv({ cls: "covault-cr-muted", text: `${t("group.group_space")}: ${space.folder}` });
		}
	}

	/** 대기 신청 카드(교사) — 신청자·구성원·폴더 + 승인/거절. */
	private requestCard(list: HTMLElement, req: GroupRequestDoc): void {
		const card = list.createDiv({ cls: "covault-cr-card" });
		const head = card.createDiv({ cls: "covault-cr-card-head" });
		head.createSpan({ cls: "covault-cr-card-title", text: req.name });
		iconButton(head, "check", t("group.approve"), () => {
			void this.host.approveGroupRequest(req).then(() => this.redraw());
		});
		iconButton(head, "x", t("group.reject"), () => this.confirmReject(req));
		const byName = req.memberNames?.[req.byUser] || req.byUser;
		card.createDiv({ cls: "covault-cr-muted", text: t("group.request_from", { name: byName, date: formatDate(new Date(req.createdAtMs)) }) });
		const known = new Set(this.host.settings.members.map((m) => m.memberId));
		const names = req.memberIds.map((id) => req.memberNames?.[id] || id).join(", ");
		card.createDiv({ cls: "covault-cr-muted", text: `${t("group.n_members", { n: req.memberIds.filter((id) => known.has(id)).length })} · ${names}` });
		card.createDiv({ cls: "covault-cr-muted", text: `${t("group.group_space")}: ${req.folder}` });
	}

	private confirmReject(req: GroupRequestDoc): void {
		new ConfirmModal(this.host.app, {
			title: t("group.reject"),
			message: t("group.reject_confirm", { name: req.name }),
			confirmText: t("group.reject"),
			warning: true,
			onConfirm: async () => {
				await this.host.rejectGroupRequest(req);
				await this.redraw();
			},
		}).open();
	}

	/** 구성원 보기 — 소속 그룹 + 그룹 만들기 신청·내 신청 상태. */
	private async drawMember(): Promise<void> {
		const c = this.root;
		if (!c) return;
		const [groups, mine, roster] = await Promise.all([
			this.host.listChatGroups().catch(() => []),
			this.host.listMyGroupRequests().catch(() => []),
			this.host.rosterMembers().catch(() => []),
		]);
		if (this.root !== c) return; // 비동기 대기 중 dispose되었으면 중단
		const sig =
			`s|${groups.map((g) => g.channel).join(",")}#${mine.map((r) => `${r._id}:${r._rev ?? ""}:${r.status}`).join("|")}#${roster.length}`;
		if (sig === this.sig && c.childElementCount > 0) return;
		this.sig = sig;
		c.empty();
		c.createDiv({ cls: "covault-cr-muted", text: t("group.request_member_hint") });

		// 그룹 신청: 교사가 배포한 학급 명단(roster)이 있어야 구성원을 고를 수 있다.
		const actions = c.createDiv({ cls: "covault-panel-actions" });
		const btn = panelButton(actions, t("group.request_cta"), () => {
			new GroupRequestModal(this.host.app, roster, this.host.settings.userId, (input) => {
				void this.host.requestGroup(input).then(() => this.redraw());
			}).open();
		}, { cta: true });
		if (roster.length === 0) {
			btn.disabled = true;
			c.createDiv({ cls: "covault-cr-muted", text: t("group.roster_missing") });
		}

		// 내 신청 목록(상태 배지 + pending 취소).
		if (mine.length > 0) {
			c.createDiv({ cls: "covault-dash-label", text: t("group.my_requests") });
			const list = c.createDiv({ cls: "covault-dash-list" });
			for (const req of mine) {
				const card = list.createDiv({ cls: "covault-cr-card" });
				const head = card.createDiv({ cls: "covault-cr-card-head" });
				head.createSpan({ cls: "covault-cr-card-title", text: req.name });
				const badge = head.createSpan({ cls: `covault-cr-badge${req.status === "approved" ? " is-accent" : ""}` });
				const label = req.status === "approved" ? t("group.request_approved") : req.status === "rejected" ? t("group.request_rejected") : t("group.request_pending");
				badge.createSpan({ text: label });
				if (req.status === "pending") {
					iconButton(head, "x", t("group.request_cancel"), () => {
						void this.host.cancelGroupRequest(req).then(() => this.redraw());
					});
				}
				const names = req.memberIds.map((id) => req.memberNames?.[id] || id).join(", ");
				card.createDiv({ cls: "covault-cr-muted", text: `${t("group.group_space")}: ${req.folder} · ${names}` });
				if (req.status === "rejected" && req.reason) card.createDiv({ cls: "covault-cr-muted", text: req.reason });
			}
		}

		if (groups.length === 0) {
			c.createDiv({ cls: "covault-cr-muted", text: t("group.none_member") });
			return;
		}
		c.createDiv({ cls: "covault-dash-label", text: t("group.member_hint") });
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
			await this.redraw();
		}).open();
	}

	private confirmDelete(g: GroupConfig): void {
		new ConfirmModal(this.host.app, {
			title: t("common.delete"),
			message: g.spaceId ? t("group.delete_space_confirm", { name: g.name }) : t("group.delete_confirm", { name: g.name }),
			confirmText: t("common.delete"),
			warning: true,
			onConfirm: async () => {
				await this.host.deleteGroup(g.id);
				await this.redraw();
			},
		}).open();
	}

	dispose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.root = null;
	}
}
