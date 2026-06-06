import { ItemView, WorkspaceLeaf } from "obsidian";
import { PanelHost, PanelSection, PanelTab } from "./panel/PanelSection";
import { DashboardSection } from "./panel/DashboardSection";
import { FeedbackSection } from "./panel/FeedbackSection";
// (시작하기 마법사는 설정에서 모달로 실행 — 패널 탭 제거)
import { SyncStatusSection } from "./panel/SyncStatusSection";
import { DeploySection } from "./panel/DeploySection";
import { ManageSection } from "./panel/ManageSection";
import { DeletedRecoverySection } from "./panel/DeletedRecoverySection";
import { VersionHistorySection } from "./panel/VersionHistorySection";
import { LogSection } from "./panel/LogSection";
import { t } from "../i18n";

export const PANEL_VIEW_TYPE = "covault-panel";

function tabLabel(tab: PanelTab): string {
	switch (tab) {
		case "dashboard":
			return t("dashboard.dashboard");
		case "feedback":
			return t("panel.feedback");
		case "deploy":
			return t("common.deploy");
		case "sync":
			return t("panel.sync_status");
		case "manage":
			return t("panel.manage");
		case "recovery":
			return t("recovery.recover_deleted");
		case "history":
			return t("version.version_history_2");
		case "log":
			return t("panel.log");
	}
}

/**
 * CoVault 통합 사이드 패널. 탭(피드백·배포·동기화 상태·관리·로그)으로 기존 3개 뷰 + 명령 기능을 모은다.
 * 배포 탭은 교사 전용. 탭 전환 시 이전 섹션을 dispose하고 새 섹션을 render한다.
 */
export class CoVaultPanelView extends ItemView {
	private current: PanelSection | null = null;
	private activeTab: PanelTab = "sync";
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
		return "graduation-cap";
	}

	private tabs(): PanelTab[] {
		const manager = this.host.settings.role === "manager";
		return manager
			? ["dashboard", "feedback", "deploy", "sync", "manage", "recovery", "history", "log"]
			: ["dashboard", "feedback", "sync", "manage", "recovery", "history", "log"];
	}

	async onOpen(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.addClass("covault-panel");
		this.tabBar = c.createDiv({ cls: "covault-panel-tabs" });
		this.body = c.createDiv({ cls: "covault-panel-body" });
		if (!this.tabs().includes(this.activeTab)) this.activeTab = "sync";
		this.renderTabBar();
		this.renderSection();
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

	/** 외부(명령/리본)에서 특정 탭을 연다. */
	setTab(tab: PanelTab): void {
		if (!this.tabs().includes(tab)) return;
		this.activeTab = tab;
		this.renderTabBar();
		this.renderSection();
	}

	private renderTabBar(): void {
		if (!this.tabBar) return;
		this.tabBar.empty();
		for (const tab of this.tabs()) {
			const el = this.tabBar.createDiv({
				cls: `covault-panel-tab${tab === this.activeTab ? " is-active" : ""}`,
				text: tabLabel(tab),
			});
			el.onclick = () => {
				if (this.activeTab === tab) return;
				this.activeTab = tab;
				this.renderTabBar();
				this.renderSection();
			};
		}
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
			case "feedback":
				return new FeedbackSection(this.host.app, this.host.feedbackStore);
			case "deploy":
				return new DeploySection(this.host);
			case "manage":
				return new ManageSection(this.host);
			case "recovery":
				return new DeletedRecoverySection(this.host);
			case "history":
				return new VersionHistorySection(this.host);
			case "log":
				return new LogSection(this.host.logger);
			case "sync":
			default:
				return new SyncStatusSection(this.host);
		}
	}
}
