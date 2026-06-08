import { EventRef, Setting, setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

/**
 * 실시간 공동 편집(Yjs) 제어·상태 탭.
 * - 상태: 켜짐/꺼짐 · 서버 · (교사)공간 시크릿 / (구성원)토큰 수신.
 * - 현재 세션: 활성 파일·참가자 수(라이브 갱신).
 * - 교사 제어: 실시간 토글 · 스냅샷 주기 · 토큰 재배포 · 상태 진단 · 공간 토큰 현황.
 */
export class RealtimeSection implements PanelSection {
	private root: HTMLElement | null = null;
	private sessionEl: HTMLElement | null = null;
	private refs: EventRef[] = [];
	private timer: number | null = null;

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	render(container: HTMLElement): void {
		this.root = container;
		// 현재 세션 카드는 활성 파일/참가자에 따라 라이브 갱신(섹션 전체 재렌더 없이 카드만).
		this.refs.push(this.host.app.workspace.on("active-leaf-change", () => this.refreshSession()));
		this.refs.push(this.host.app.workspace.on("file-open", () => this.refreshSession()));
		this.timer = window.setInterval(() => this.refreshSession(), 2000);
		this.draw();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		c.empty();
		c.addClass("covault-panel-section");
		const s = this.host.settings;

		// 상태
		c.createDiv({ cls: "covault-dash-label", text: t("realtime.tab") });
		const status = c.createDiv({ cls: "covault-rt-status" });
		this.statusRow(status, t("settings.realtime_status"), s.realtimeEnabled ? t("common.on") : t("common.off"));
		this.statusRow(status, t("settings.yjs_server_url"), s.yjsServerUrl || t("settings.not_set"));
		if (this.manager) this.statusRow(status, t("settings.yjs_space_secret_hmac_recommended"), s.yjsSecretSet ? t("common.set") : t("common.none"));
		else this.statusRow(status, t("settings.realtime_token"), this.host.realtimeTokenReceived() ? t("common.set") : t("common.none"));

		// 현재 세션(라이브)
		this.sessionEl = c.createDiv({ cls: "covault-rt-session" });
		this.renderSession();

		// 제어
		if (this.manager) {
			new Setting(c)
				.setName(t("settings.enable_realtime_editing"))
				.setDesc(t("settings.enable_realtime_editing_desc"))
				.addToggle((tg) =>
					tg.setValue(s.realtimeEnabled).onChange(async (v) => {
						s.realtimeEnabled = v;
						await this.host.saveSettings();
						await this.host.redeployRealtime();
						this.draw();
					}),
				);
			new Setting(c).setName(t("settings.in_session_snapshot_interval_sec")).addText((txt) => {
				txt.inputEl.type = "number";
				txt.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec)).onChange(async (v) => {
					const n = Number(v);
					s.realtimeSnapshotSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
					await this.host.saveSettings();
				});
			});

			const actions = c.createDiv({ cls: "covault-panel-actions" });
			panelButton(actions, t("realtime.redeploy_tokens"), () => this.run(() => this.host.redeployRealtime()), { cta: true });
			panelButton(actions, t("panel.check_realtime_status"), () => void this.host.realtimeStatus());

			if (s.sharedSpaces.length > 0) {
				c.createDiv({ cls: "covault-dash-label", text: t("realtime.spaces_tokens") });
				const list = c.createDiv({ cls: "covault-rt-status" });
				for (const sp of s.sharedSpaces) this.statusRow(list, sp.name || sp.id, sp.token ? t("common.set") : t("common.none"));
			}

			// 구성원별 실시간 허용/차단(전역 실시간이 켜진 동안만 의미 있음).
			const members = s.members.filter((m) => m.memberId && m.provisioned);
			if (s.realtimeEnabled && members.length > 0) {
				c.createDiv({ cls: "covault-dash-label", text: t("realtime.per_member") });
				for (const m of members) {
					new Setting(c).setName(m.memberName || m.memberId).addToggle((tg) =>
						tg.setValue(!m.realtimeBlocked).onChange(async (v) => {
							await this.host.setMemberRealtime(m.memberId, v);
							this.draw();
						}),
					);
				}
				c.createDiv({ cls: "covault-cr-muted", text: t("realtime.per_member_hint") });
			}

			c.createDiv({ cls: "covault-cr-muted", text: t("realtime.configure_in_settings") });
		} else {
			const actions = c.createDiv({ cls: "covault-panel-actions" });
			panelButton(actions, t("panel.check_realtime_status"), () => void this.host.realtimeStatus());
			c.createDiv({ cls: "covault-cr-muted", text: t("realtime.member_note") });
		}
	}

	private async run(fn: () => Promise<void>): Promise<void> {
		await fn();
		this.draw();
	}

	private statusRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: "covault-rt-row" });
		row.createSpan({ cls: "covault-rt-key", text: label });
		row.createSpan({ cls: "covault-rt-val", text: value });
	}

	private renderSession(): void {
		const el = this.sessionEl;
		if (!el) return;
		el.empty();
		const s = this.host.settings;
		if (!s.realtimeEnabled) {
			el.createDiv({ cls: "covault-cr-muted", text: t("realtime.disabled_hint") });
			return;
		}
		const info = this.host.realtimeActiveFile();
		if (!info) {
			el.createDiv({ cls: "covault-cr-muted", text: t("realtime.session_none") });
			return;
		}
		const box = el.createDiv({ cls: "covault-cr-card" });
		const head = box.createDiv({ cls: "covault-cr-card-head" });
		setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), "radio");
		head.createSpan({ cls: "covault-cr-card-title", text: info.path.split("/").pop() ?? info.path });
		const badge = head.createSpan({ cls: "covault-cr-badge is-accent" });
		setIcon(badge.createSpan(), "users");
		badge.createSpan({ text: t("realtime.participants_n", { n: info.participants }) });
		box.createDiv({ cls: "covault-cr-muted", text: info.path });
	}

	private refreshSession(): void {
		if (this.sessionEl) this.renderSession();
	}

	dispose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		for (const r of this.refs) this.host.app.workspace.offref(r);
		this.refs = [];
		this.root = null;
		this.sessionEl = null;
	}
}
