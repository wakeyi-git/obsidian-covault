import { setIcon } from "obsidian";
import { PanelHost, PanelSection, SystemView } from "./PanelSection";
import { SyncStatusSection } from "./SyncStatusSection";
import { DeletedRecoverySection } from "./DeletedRecoverySection";
import { VersionHistorySection } from "./VersionHistorySection";
import { LogSection } from "./LogSection";
import { t } from "../../i18n";

interface SubDef {
	view: SystemView;
	label: string;
	icon: string;
	make: () => PanelSection;
}

/**
 * 시스템 탭 — 유지보수 도구(동기화·복구·이력·로그)를 서브탭으로 묶는다.
 * 기존 섹션을 그대로 인스턴스화해 감싼다(로직 이동 없음). 서브탭 전환 시 이전 섹션을 dispose해 타이머 정리.
 */
export class SystemSection implements PanelSection {
	private root: HTMLElement | null = null;
	private tabBar: HTMLElement | null = null;
	private body: HTMLElement | null = null;
	private active: PanelSection | null = null;
	private view: SystemView = "sync";

	constructor(private host: PanelHost) {}

	private defs(): SubDef[] {
		return [
			{ view: "sync", label: t("panel.sync_status"), icon: "refresh-cw", make: () => new SyncStatusSection(this.host) },
			{ view: "recovery", label: t("recovery.recover_deleted"), icon: "archive-restore", make: () => new DeletedRecoverySection(this.host) },
			{ view: "history", label: t("version.version_history_2"), icon: "history", make: () => new VersionHistorySection(this.host) },
			{ view: "log", label: t("panel.log"), icon: "scroll-text", make: () => new LogSection(this.host.logger) },
		];
	}

	render(container: HTMLElement): void {
		this.root = container;
		const pending = this.host.consumePendingSystemView();
		if (pending) this.view = pending;
		container.addClass("covault-panel-section");
		this.tabBar = container.createDiv({ cls: "covault-system-subtabs" });
		this.body = container.createDiv({ cls: "covault-system-body" });
		this.renderTabBar();
		this.show(this.view);
	}

	private renderTabBar(): void {
		const bar = this.tabBar;
		if (!bar) return;
		bar.empty();
		for (const d of this.defs()) {
			const b = bar.createEl("button", { cls: `covault-system-subtab${d.view === this.view ? " is-active" : ""}` });
			setIcon(b.createSpan({ cls: "covault-system-subtab-icon" }), d.icon);
			b.createSpan({ text: d.label });
			b.onclick = () => {
				if (this.view === d.view) return;
				this.view = d.view;
				this.renderTabBar();
				this.show(d.view);
			};
		}
	}

	private show(view: SystemView): void {
		const body = this.body;
		if (!body) return;
		this.active?.dispose();
		body.empty();
		const def = this.defs().find((d) => d.view === view);
		this.active = def ? def.make() : null;
		void this.active?.render(body);
	}

	dispose(): void {
		this.active?.dispose();
		this.active = null;
		this.root = this.tabBar = this.body = null;
	}
}
