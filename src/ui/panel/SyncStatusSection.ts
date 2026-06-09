import { setIcon } from "obsidian";
import { errMessage } from "../../core/util/err";
import { LinkStatus } from "../../core/sync/MirrorContext";
import { computeChildRoots } from "../../core/sync/childRoots";
import { DashboardRow, PanelHost, PanelSection, panelButton } from "./PanelSection";
import { computeSyncSummary, SyncSummary } from "./syncSummary";
import { t } from "../../i18n";

function overallIcon(o: SyncSummary["overall"]): string {
	switch (o) {
		case "ok":
			return "circle-check";
		case "attention":
			return "alert-triangle";
		case "offline":
			return "wifi-off";
		case "autosync-off":
			return "pause";
		case "empty":
			return "inbox";
	}
}

function overallLabel(o: SyncSummary["overall"]): string {
	switch (o) {
		case "ok":
			return t("panel.ok");
		case "attention":
			return t("panel.needs_attention");
		case "offline":
			return t("panel.offline");
		case "autosync-off":
			return t("panel.auto_sync_off");
		case "empty":
			return t("panel.idle_2");
	}
}

function stateIcon(state: LinkStatus["state"]): string {
	switch (state) {
		case "syncing":
			return "refresh-cw";
		case "idle":
			return "circle-check";
		case "offline":
			return "circle-slash";
		case "error":
			return "circle-x";
		case "disabled":
			return "circle-pause";
	}
}

function stateLabel(state: LinkStatus["state"]): string {
	switch (state) {
		case "syncing":
			return t("panel.syncing");
		case "idle":
			return t("panel.idle");
		case "offline":
			return t("panel.offline");
		case "error":
			return t("panel.error");
		case "disabled":
			return t("panel.off");
	}
}

/** 동기화 상태 탭 — 링크별 상태 표(3초 갱신) + 동기화/자동동기화/충돌 액션. (구 DashboardView 본문 + 버튼) */
export class SyncStatusSection implements PanelSection {
	private timer: number | null = null;
	private tableWrap: HTMLElement | null = null;
	private autoBtn: HTMLButtonElement | null = null;
	private renderSeq = 0;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("covault-dashboard");

		const actions = container.createDiv({ cls: "covault-panel-actions" });
		panelButton(actions, t("panel.full_sync"), () => this.host.fullSync("both"), { cta: true });
		panelButton(actions, t("panel.upload_only"), () => this.host.fullSync("up"));
		panelButton(actions, t("panel.download_only"), () => this.host.fullSync("down"));
		this.autoBtn = panelButton(actions, this.autoLabel(), async () => {
			await this.host.toggleAutoSync();
			this.autoBtn?.setText(this.autoLabel());
		});
		panelButton(actions, t("panel.conflicts"), () => this.host.openConflictModal());

		this.tableWrap = container.createDiv();
		void this.renderTable();
		// 폴링 갱신: 백그라운드(document.hidden)에선 건너뛰어 충돌 전수 스캔 비용을 줄인다.
		// 간격도 3초→5초로 완화(상태 표는 즉시성보다 부하가 중요).
		this.timer = window.setInterval(() => {
			if (!document.hidden) void this.renderTable();
		}, 5000);

		// 관리/도구(이전 '관리' 탭 통합): 연결·진단·캐시·실시간 점검 + 서버 초기화/공유 새로고침.
		this.renderTools(container);
	}

	/** 이전 '관리' 탭을 동기화 상태 탭 하단으로 통합. 정적이라 한 번만 렌더. */
	private renderTools(container: HTMLElement): void {
		container.createDiv({ cls: "covault-dash-label", text: t("panel.manage") });
		const item = (label: string, desc: string, onClick: () => void | Promise<void>, opts?: { warning?: boolean }) => {
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
		if (this.timer != null) window.clearInterval(this.timer);
		this.timer = null;
		this.tableWrap = null;
		this.autoBtn = null;
	}

	private autoLabel(): string {
		return t("panel.auto_sync", { state: this.host.settings.autoSync ? t("common.on") : t("common.off") });
	}

	private async renderTable(): Promise<void> {
		const seq = ++this.renderSeq; // 이 렌더의 순번. 비동기 후 더 새 렌더가 시작됐으면 덮어쓰지 않는다.
		if (!this.tableWrap) return;
		let rows: DashboardRow[] = [];
		try {
			rows = await this.host.getDashboardRows();
		} catch (e) {
			if (seq !== this.renderSeq || !this.tableWrap) return;
			this.tableWrap.empty();
			this.tableWrap.createEl("p", {
				text: t("panel.failed_to_load_status", { error: errMessage(e) }),
			});
			return;
		}
		// 그 사이 dispose됐거나(=tableWrap null) 더 새 렌더가 시작됐으면(오래된 완료) 중단 — 이전 흔적 방지.
		if (seq !== this.renderSeq || !this.tableWrap) return;
		const wrap = this.tableWrap;
		wrap.empty();

		if (rows.length === 0) {
			wrap.createEl("p", {
				cls: "covault-feedback-empty",
				text:
					this.host.settings.role === "manager"
						? t("panel.no_members_to_sync_yet_add")
						: t("panel.not_connected_yet_apply_the_qr"),
			});
			return;
		}

		const summary = computeSyncSummary(rows, this.host.settings);
		this.renderBanner(wrap, summary);
		this.renderActionCards(wrap, summary);

		const table = wrap.createEl("table", { cls: "covault-dash-table" });
		const thead = table.createEl("thead").createEl("tr");
		for (const h of [
			t("panel.target"),
			t("panel.mirror_db"),
			t("settings.folder"),
			t("panel.last_upload"),
			t("panel.last_received"),
			t("panel.conflicts_4"),
			t("panel.status"),
		]) {
			thead.createEl("th", { text: h });
		}
		// 중첩 root 감지: 다른 링크 폴더 안에 든 폴더는 그 안쪽 링크가 담당한다(이중 동기화 방지).
		const allRoots = rows.map((r) => r.localRoot);

		const tbody = table.createEl("tbody");
		for (const r of rows) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: r.memberName || r.memberId || "—" });
			tr.createEl("td", { text: r.remoteDb });
			const fTd = tr.createEl("td", { text: r.localRoot || t("panel.root") });
			const children = computeChildRoots(r.localRoot, allRoots);
			if (children.length > 0) {
				fTd.setAttribute(
					"title",
					t("panel.inside_this_folder_are_handled_by", { roots: children.join(", ") }),
				);
				fTd.createSpan({ cls: "covault-nested-tag", text: t("panel.nested", { n: children.length }) });
			}
			tr.createEl("td", { text: fmtTime(r.lastUploadAt) });
			tr.createEl("td", { text: fmtTime(r.lastDownloadAt) });
			const cTd = tr.createEl("td", { text: String(r.conflicts) });
			if (r.conflicts > 0) cTd.addClass("covault-dash-conflict");
			const sTd = tr.createEl("td");
			this.renderState(sTd, r.state);
			if (r.state === "error" && r.lastError) {
				sTd.setAttribute("title", r.lastError);
				sTd.createDiv({ cls: "covault-dash-err", text: shortErr(r.lastError) });
			}
		}

		// 좁은 패널/모바일용 카드 목록(같은 데이터). CSS container query로 표↔카드 전환.
		this.renderCards(wrap, rows, allRoots);
	}

	/** 상태 아이콘 + 라벨(이모지 원 대신 단일 아이콘). 상태별 색은 CSS(is-<state>). */
	private renderState(parent: HTMLElement, state: LinkStatus["state"]): void {
		const span = parent.createSpan({ cls: `covault-state is-${state}` });
		setIcon(span.createSpan({ cls: "covault-state-icon" }), stateIcon(state));
		span.createSpan({ text: stateLabel(state) });
	}

	private renderBanner(wrap: HTMLElement, s: SyncSummary): void {
		const banner = wrap.createDiv({ cls: `covault-dash-banner is-${s.overall}` });
		const status = banner.createSpan({ cls: "covault-dash-banner-status" });
		setIcon(status.createSpan({ cls: "covault-dash-banner-icon" }), overallIcon(s.overall));
		status.createSpan({ text: overallLabel(s.overall) });
		const parts =
			this.host.settings.role === "manager"
				? [
						t("panel.member_progress", { invited: s.invited, total: s.members }),
						t("panel.shared", { n: s.shared }),
						t("panel.conflicts_2", { n: s.conflicts }),
					]
				: [t("panel.shared", { n: s.shared }), t("panel.conflicts_2", { n: s.conflicts })];
		if (s.lastSyncAt) parts.push(t("panel.last", { time: fmtTime(s.lastSyncAt) }));
		banner.createSpan({ cls: "covault-dash-banner-meta", text: parts.join(" · ") });
	}

	private renderActionCards(wrap: HTMLElement, s: SyncSummary): void {
		const cards: Array<{ text: string; cta: string; run: () => void | Promise<void>; warn?: boolean }> = [];
		if (s.notInvited > 0)
			cards.push({
				text: t("panel.need_inviting", { n: s.notInvited }),
				cta: t("panel.open_member_settings"),
				run: () => this.host.openSettings(),
				warn: true,
			});
		if (s.conflicts > 0)
			cards.push({ text: t("panel.conflicts_3", { n: s.conflicts }), cta: t("panel.conflicts"), run: () => this.host.openConflictModal(), warn: true });
		if (s.problems > 0)
			cards.push({ text: t("panel.connection_issues", { n: s.problems }), cta: t("settings.connection_test"), run: () => this.host.testConnection(), warn: true });
		if (s.realtimeTokenMissing)
			cards.push({ text: t("panel.no_realtime_token"), cta: t("panel.open_settings"), run: () => this.host.openSettings(), warn: true });
		if (s.autoSyncOff)
			cards.push({ text: t("panel.auto_sync_is_off"), cta: t("panel.turn_on"), run: () => void this.host.toggleAutoSync() });
		if (cards.length === 0) return;
		const box = wrap.createDiv({ cls: "covault-dash-cards-actions" });
		for (const c of cards) {
			const card = box.createDiv({ cls: `covault-action-card${c.warn ? " is-warn" : ""}` });
			const main = card.createDiv({ cls: "covault-action-card-main" });
			setIcon(main.createSpan({ cls: "covault-action-card-icon" }), c.warn ? "alert-triangle" : "info");
			main.createSpan({ text: c.text });
			panelButton(card, c.cta, c.run);
		}
	}

	private renderCards(wrap: HTMLElement, rows: DashboardRow[], allRoots: string[]): void {
		const box = wrap.createDiv({ cls: "covault-dash-cards" });
		for (const r of rows) {
			const card = box.createDiv({ cls: "covault-dash-card" });
			const head = card.createDiv({ cls: "covault-dash-card-head" });
			head.createSpan({ cls: "covault-dash-card-name", text: r.memberName || r.memberId || "—" });
			this.renderState(head, r.state);
			const meta = card.createDiv({ cls: "covault-dash-card-meta" });
			meta.createSpan({ text: t("panel.received", { time: fmtTime(r.lastDownloadAt) }) });
			const conf = meta.createSpan({ text: t("panel.conflicts_2", { n: r.conflicts }) });
			if (r.conflicts > 0) conf.addClass("covault-dash-conflict");
			const children = computeChildRoots(r.localRoot, allRoots);
			if (children.length > 0) meta.createSpan({ cls: "covault-nested-tag", text: t("panel.nested", { n: children.length }) });
			if (r.state === "error" && r.lastError) card.createDiv({ cls: "covault-dash-err", text: shortErr(r.lastError) });
		}
	}
}

function shortErr(msg: string): string {
	return msg.length > 80 ? msg.slice(0, 79) + "…" : msg;
}

function fmtTime(ts?: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	const diff = Date.now() - ts;
	if (diff < 60_000) return t("panel.just_now");
	if (diff < 3_600_000) return t("panel.min_ago", { min: Math.floor(diff / 60_000) });
	return d.toLocaleTimeString();
}
