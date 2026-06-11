import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { PanelHost, PanelSection, PanelTab } from "./panel/PanelSection";
import { PanelTabsModal } from "./PanelTabsModal";
import { DashboardSection } from "./panel/DashboardSection";
import { ChatSection } from "./panel/ChatSection";
import { GroupsSection } from "./panel/GroupsSection";
import { RealtimeSection } from "./panel/RealtimeSection";
import { FeedbackSection } from "./panel/FeedbackSection";
// (시작하기 마법사는 설정에서 모달로 실행 — 패널 탭 제거)
import { DeploySection } from "./panel/DeploySection";
import { SystemSection } from "./panel/SystemSection";
import { t } from "../i18n";

export const PANEL_VIEW_TYPE = "covault-panel";

function tabLabel(tab: PanelTab): string {
	switch (tab) {
		case "dashboard":
			return t("dashboard.dashboard");
		case "chat":
			return t("chat.chat");
		case "groups":
			return t("group.groups");
		case "feedback":
			return t("panel.feedback");
		case "realtime":
			return t("realtime.tab");
		case "deploy":
			return t("common.deploy");
		case "system":
			return t("panel.system");
	}
}

function tabIcon(tab: PanelTab): string {
	switch (tab) {
		case "dashboard":
			return "layout-dashboard";
		case "chat":
			return "messages-square";
		case "groups":
			return "users-round";
		case "feedback":
			return "message-square";
		case "realtime":
			return "radio";
		case "deploy":
			return "send";
		case "system":
			return "settings-2";
	}
}

/**
 * CoVault 통합 사이드 패널. 탭(피드백·배포·동기화 상태·관리·로그)으로 기존 3개 뷰 + 명령 기능을 모은다.
 * 배포 탭은 교사 전용. 탭 전환 시 이전 섹션을 dispose하고 새 섹션을 render한다.
 */
export class CoVaultPanelView extends ItemView {
	private current: PanelSection | null = null;
	private activeTab: PanelTab = "dashboard";
	private tabBar: HTMLElement | null = null;
	private body: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private host: PanelHost) {
		super(leaf);
	}

	getViewType(): string {
		return PANEL_VIEW_TYPE;
	}
	getDisplayText(): string {
		return t("panel.covault");
	}
	getIcon(): string {
		return "vault"; // 리본 아이콘과 동일 — 학급 전용이 아닌 제품 정체성(공유 금고)
	}

	/** 역할에 허용된 전체 탭(기본 순서). 탭 사용자화의 후보 목록. */
	private allTabs(): PanelTab[] {
		const manager = this.host.settings.role === "manager";
		return manager
			? ["dashboard", "chat", "feedback", "realtime", "groups", "deploy", "system"]
			: ["dashboard", "chat", "feedback", "realtime", "groups", "system"];
	}

	/** 표시할 탭(사용자화 반영). settings.panelTabs가 있으면 그 순서·구성, 없으면 역할 기본. */
	private tabs(): PanelTab[] {
		const all = this.allTabs();
		const custom = this.host.settings.panelTabs;
		if (!custom?.length) return all;
		const picked = custom.filter((id): id is PanelTab => (all as string[]).includes(id));
		return picked.length > 0 ? picked : all;
	}

	async onOpen(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.addClass("covault-panel");
		this.tabBar = c.createDiv({ cls: "covault-panel-tabs" });
		this.body = c.createDiv({ cls: "covault-panel-body" });
		this.attachEdgeScroll(this.tabBar);
		// 마지막 본 탭 복원(옵션). 저장된 탭이 현재 표시 목록에 있을 때만 — 숨김/역할변경이면 폴백.
		const s = this.host.settings;
		if (s.rememberLastTab && s.lastActiveTab && this.tabs().includes(s.lastActiveTab as PanelTab)) {
			this.activeTab = s.lastActiveTab as PanelTab;
		}
		if (!this.tabs().includes(this.activeTab)) this.activeTab = this.tabs()[0] ?? "dashboard";
		this.renderTabBar();
		this.renderSection();
	}

	/** 마지막 본 탭 기록(옵션 켜짐일 때만). 클릭/외부 진입 공통. */
	private rememberTab(tab: PanelTab): void {
		if (!this.host.settings.rememberLastTab) return;
		this.host.settings.lastActiveTab = tab;
		void this.host.saveSettings();
	}

	/** 탭 바 좌우 가장자리에 포인터가 오면 자동으로 가로 스크롤. */
	private attachEdgeScroll(el: HTMLElement): void {
		const EDGE = 44; // 가장자리 감지 폭(px)
		const SPEED = 10; // 프레임당 스크롤(px)
		let dir = 0;
		let raf = 0;
		const step = (): void => {
			if (dir === 0 || !el.isConnected) {
				raf = 0;
				return;
			}
			el.scrollLeft += dir * SPEED;
			raf = requestAnimationFrame(step);
		};
		el.addEventListener("mousemove", (e) => {
			if (el.scrollWidth <= el.clientWidth) {
				dir = 0;
				return;
			}
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			if (x < EDGE && el.scrollLeft > 0) dir = -1;
			else if (x > r.width - EDGE && el.scrollLeft < el.scrollWidth - el.clientWidth) dir = 1;
			else dir = 0;
			if (dir !== 0 && !raf) raf = requestAnimationFrame(step);
		});
		el.addEventListener("mouseleave", () => {
			dir = 0;
		});
	}

	async onClose(): Promise<void> {
		this.current?.dispose();
		this.current = null;
	}

	/** 언어 변경 등으로 탭 라벨·현재 섹션을 다시 그린다. */
	refresh(): void {
		if (!this.tabBar || !this.body) return;
		this.renderTabBar();
		this.renderSection();
	}

	/** 외부(명령/리본)에서 특정 탭을 연다. 숨겨진 탭도 역할에 허용되면 임시로 표시해 연다(그룹 대화 진입 등). */
	setTab(tab: PanelTab): void {
		if (!this.allTabs().includes(tab)) return;
		this.activeTab = tab;
		this.rememberTab(tab);
		this.renderTabBar();
		this.renderSection();
	}

	private renderTabBar(): void {
		if (!this.tabBar) return;
		this.tabBar.empty();
		// 숨겨진 탭이 외부 진입(setTab)으로 활성화됐으면 임시로 뒤에 붙여 일관된 탭 표시를 유지.
		const list = [...this.tabs()];
		if (!list.includes(this.activeTab) && this.allTabs().includes(this.activeTab)) list.push(this.activeTab);
		for (const tab of list) {
			const el = this.tabBar.createDiv({
				cls: `covault-panel-tab${tab === this.activeTab ? " is-active" : ""}`,
			});
			setIcon(el.createSpan({ cls: "covault-panel-tab-icon" }), tabIcon(tab));
			el.createSpan({ cls: "covault-panel-tab-label", text: tabLabel(tab) });
			el.setAttr("aria-label", tabLabel(tab));
			el.onclick = () => {
				if (this.activeTab === tab) {
					// 같은 탭 재선택 → 섹션 초기 화면으로(대시보드 첫 페이지 등).
					this.current?.onReactivate?.();
					return;
				}
				this.activeTab = tab;
				this.rememberTab(tab);
				this.renderTabBar();
				this.renderSection();
			};
		}
		// 탭 편집(추가/제거/순서) — 탭 바 끝의 작은 버튼.
		const edit = this.tabBar.createDiv({ cls: "covault-panel-tab covault-panel-tab-edit" });
		setIcon(edit.createSpan({ cls: "covault-panel-tab-icon" }), "sliders-horizontal");
		edit.setAttr("aria-label", t("panel.edit_tabs"));
		edit.onclick = () => this.openTabsEditor();
	}

	/** 탭 편집 모달 — 현재 표시 순서 우선, 숨김 탭은 기본 순서대로 뒤에. */
	private openTabsEditor(): void {
		const visible = this.tabs();
		const hidden = this.allTabs().filter((tab) => !visible.includes(tab));
		const rows = [
			...visible.map((tab) => ({ id: tab, label: tabLabel(tab), icon: tabIcon(tab), visible: true })),
			...hidden.map((tab) => ({ id: tab, label: tabLabel(tab), icon: tabIcon(tab), visible: false })),
		];
		new PanelTabsModal(this.host.app, rows, this.host.settings.rememberLastTab ?? false, (visibleIds, rememberLastTab) => {
			// null=기본 구성으로 복귀. 기본과 동일한 선택도 미설정으로 저장해 이후 기본 변경을 따라가게 한다.
			const all = this.allTabs();
			const isDefault = visibleIds != null && visibleIds.length === all.length && visibleIds.every((id, i) => id === all[i]);
			this.host.settings.panelTabs = visibleIds == null || isDefault ? undefined : visibleIds;
			this.host.settings.rememberLastTab = rememberLastTab;
			// 켜는 즉시 현재 탭을 기준점으로 기록(끄면 무의미하므로 그대로 둠).
			if (rememberLastTab) this.host.settings.lastActiveTab = this.activeTab;
			void this.host.saveSettings();
			if (!this.tabs().includes(this.activeTab)) this.activeTab = this.tabs()[0] ?? "dashboard";
			this.refresh();
		}).open();
	}

	private renderSection(): void {
		if (!this.body) return;
		this.current?.dispose();
		this.body.empty();
		this.current = this.createSection(this.activeTab);
		void this.current.render(this.body);
	}

	private createSection(tab: PanelTab): PanelSection {
		switch (tab) {
			case "dashboard":
				return new DashboardSection(this.host);
			case "chat":
				return new ChatSection(this.host);
			case "groups":
				return new GroupsSection(this.host);
			case "realtime":
				return new RealtimeSection(this.host);
			case "feedback":
				return new FeedbackSection(this.host.app, this.host.feedbackStore);
			case "deploy":
				return new DeploySection(this.host);
			case "system":
				return new SystemSection(this.host);
			default:
				return new DashboardSection(this.host);
		}
	}
}
