import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

/** 관리 탭 — 연결/진단/캐시/실시간 점검 + (교사) 서버 초기화 / (학생) 공유 새로고침. */
export class ManageSection implements PanelSection {
	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("covault-panel-section");

		const item = (
			label: string,
			desc: string,
			onClick: () => void | Promise<void>,
			opts?: { warning?: boolean },
		) => {
			const row = container.createDiv({ cls: "covault-manage-item" });
			panelButton(row, label, onClick, opts);
			row.createDiv({ cls: "covault-panel-hint", text: desc });
		};

		item(t("panel.test_connection_permissions"), t("panel.checks_the_couchdb_connection_and_read"), () => this.host.testConnection());
		item(t("panel.run_full_diagnostics"), t("panel.checks_server_reachability_per_link_permissions"), () => this.host.runDiagnostics());
		item(t("panel.check_realtime_status"), t("panel.logs_the_current_file_s_realtime"), () => this.host.realtimeStatus());
		item(t("panel.reset_local_cache"), t("panel.clears_the_local_pouchdb_and_re"), () => this.host.resetLocalCache());

		if (this.host.settings.role === "manager") {
			item(t("panel.reset_server_data"), t("panel.deletes_the_member_shared_dbs_on"), () => this.host.openResetModal(), { warning: true });
		} else {
			item(t("panel.refresh_shared_spaces"), t("panel.re_fetches_the_shared_spaces_deployed"), () => this.host.refreshShares());
		}
	}

	dispose(): void {
		/* 구독 없음 */
	}
}
