import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { PanelHost, PanelSection, PanelTab } from "./panel/PanelSection";
import { DashboardSection } from "./panel/DashboardSection";
import { ChatSection } from "./panel/ChatSection";
import { RealtimeSection } from "./panel/RealtimeSection";
import { FeedbackSection } from "./panel/FeedbackSection";
// (시작하기 마법사는 설정에서 모달로 실행 — 패널 탭 제거)
import { SyncStatusSection } from "./panel/SyncStatusSection";
import { DeploySection } from "./panel/DeploySection";
import { DeletedRecoverySection } from "./panel/DeletedRecoverySection";
import { VersionHistorySection } from "./panel/VersionHistorySection";
import { LogSection } from "./panel/LogSection";
import { t } from "../i18n";

export const PANEL_VIEW_TYPE = "covault-panel";

function tabLabel(tab: PanelTab): string {
	switch (tab) {
		case "dashboard":
			return t("dashboard.dashboard");
		case "chat":
			return t("chat.chat");
		case "feedback":
			return t("panel.feedback");
		case "realtime":
			return t("realtime.tab");
		case "deploy":
			return t("common.deploy");
		case "sync":
			return t("panel.sync_status");
		case "recovery":
			return t("recovery.recover_deleted");
		case "history":
			return t("version.version_history_2");
		case "log":
			return t("panel.log");
	}
}

function tabIcon(tab: PanelTab): string {
	switch (tab) {
		case "dashboard":
			return "layout-dashboard";
		case "chat":
			return "messages-square";
		case "feedback":
			return "message-square";
		case "realtime":
			return "radio";
		case "deploy":
			return "send";
		case "sync":
			return "refresh-cw";
		case "recovery":
			return "archive-restore";
		case "history":
			return "history";
		case "log":
			return "scroll-text";
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
			? ["dashboard", "chat", "feedback", "realtime", "deploy", "sync", "recovery", "history", "log"]
			: ["dashboard", "chat", "feedback", "realtime", "sync", "recovery", "history", "log"];
	}

	async onOpen(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.addClass("covault-panel");
		this.tabBar = c.createDiv({ cls: "covault-panel-tabs" });
		this.body = c.createDiv({ cls: "covault-panel-body" });
		this.attachEdgeScroll(this.tabBar);
		if (!this.tabs().includes(this.activeTab)) this.activeTab = "sync";
		this.renderTabBar();
		this.renderSection();
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
			case "chat":
				return new ChatSection(this.host);
			case "realtime":
				return new RealtimeSection(this.host);
			case "feedback":
				return new FeedbackSection(this.host.app, this.host.feedbackStore);
			case "deploy":
				return new DeploySection(this.host);
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
