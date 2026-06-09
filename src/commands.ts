import { Plugin } from "obsidian";
import { PanelTab } from "./ui/panel/PanelSection";
import { SyncDirection } from "./core/sync/FullSync";
import { t } from "./i18n";

/**
 * 명령 콜백 모음. main(CoVaultPlugin)이 private 내부에 접근해 구현하고, 여기서는 id/이름/등록만 담당.
 * (god object에서 명령 등록 보일러플레이트를 분리.)
 */
export interface CommandActions {
	openPanel(): void;
	openTab(tab: PanelTab): void;
	cleanupClassroom(): void;
	testConnection(): void;
	runDiagnostics(): void;
	fullSync(direction: SyncDirection): void;
	toggleAutoSync(): void;
	resetLocalCache(): void;
	openConflicts(): void;
	realtimeStatus(): void;
	refreshShares(): void;
	addFeedback(): void;
	/** 버전 히스토리 대상 경로(활성 md + 담당 sync 있을 때), 없으면 null. */
	versionHistoryPath(): string | null;
	openVersionHistory(path: string): void;
}

/** CoVault 명령 등록(통합 패널은 🎓 리본; 각 명령은 특정 탭/동작으로). */
export function registerCommands(plugin: Plugin, a: CommandActions): void {
	plugin.addCommand({ id: "covault-open-panel", name: t("command.open_panel"), callback: () => a.openPanel() });
	plugin.addCommand({ id: "covault-open-dashboard", name: t("command.open_dashboard"), callback: () => a.openTab("dashboard") });
	plugin.addCommand({ id: "covault-cleanup-classroom", name: t("command.cleanup_classroom_docs"), callback: () => a.cleanupClassroom() });
	plugin.addCommand({ id: "covault-open-log", name: t("command.open_log_panel"), callback: () => a.openTab("log") });
	plugin.addCommand({ id: "covault-test-connection", name: t("panel.test_connection_permissions"), callback: () => a.testConnection() });
	plugin.addCommand({ id: "covault-diagnostics", name: t("command.run_full_diagnostics_server_read_write"), callback: () => a.runDiagnostics() });
	plugin.addCommand({ id: "covault-full-sync", name: t("panel.full_sync"), callback: () => a.fullSync("both") });
	plugin.addCommand({ id: "covault-upload-only", name: t("command.upload_only"), callback: () => a.fullSync("up") });
	plugin.addCommand({ id: "covault-download-only", name: t("command.download_only"), callback: () => a.fullSync("down") });
	plugin.addCommand({ id: "covault-toggle-autosync", name: t("command.toggle_auto_sync"), callback: () => a.toggleAutoSync() });
	plugin.addCommand({ id: "covault-reset-local", name: t("command.reset_local_cache_re_fetch_from"), callback: () => a.resetLocalCache() });
	plugin.addCommand({ id: "covault-conflicts", name: t("command.open_conflict_list"), callback: () => a.openConflicts() });
	plugin.addCommand({ id: "covault-dashboard", name: t("command.open_sync_status"), callback: () => a.openTab("sync") });
	plugin.addCommand({ id: "covault-deploy", name: t("deploy.copy_to_members_open_deploy_tab"), callback: () => a.openTab("deploy") });
	plugin.addCommand({ id: "covault-realtime-status", name: t("panel.check_realtime_status"), callback: () => a.realtimeStatus() });
	plugin.addCommand({ id: "covault-add-feedback", name: t("command.add_feedback_selection"), callback: () => a.addFeedback() });
	plugin.addCommand({ id: "covault-open-feedback", name: t("command.open_feedback_panel"), callback: () => a.openTab("feedback") });
	plugin.addCommand({ id: "covault-refresh-shares", name: t("panel.refresh_shared_spaces"), callback: () => a.refreshShares() });
	plugin.addCommand({
		id: "covault-version-history",
		name: t("version.open_version_history"),
		checkCallback: (checking: boolean) => {
			const path = a.versionHistoryPath();
			if (path && !checking) a.openVersionHistory(path);
			return !!path;
		},
	});
}
