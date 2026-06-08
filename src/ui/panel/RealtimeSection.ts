import { EventRef, Setting, setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { getSecretValue, YJS_SECRET_ID } from "../../core/secret";
import { t } from "../../i18n";

/**
 * 실시간 공동 편집(Yjs) 제어·상태 탭.
 * 운영 중 필요한 것(현재 세션·구성원별 실시간·공간 토큰)을 앞에 두고, 서버 URL·시크릿 같은 설정 정보는
 * 문제가 있을 때만 경고로 노출한다(상시 표시 X). 토글이 곧 실시간 on/off 상태이므로 별도 상태 줄은 두지 않는다.
 */
export class RealtimeSection implements PanelSection {
	private root: HTMLElement | null = null;
	private sessionEl: HTMLElement | null = null;
	private partEl: HTMLElement | null = null;
	private refs: EventRef[] = [];
	private timer: number | null = null;

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	render(container: HTMLElement): void {
		this.root = container;
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
		this.sessionEl = null;
		this.partEl = null;
		const s = this.host.settings;

		c.createDiv({ cls: "covault-dash-label", text: t("realtime.tab") });

		if (this.manager) this.drawManager(c, s);
		else this.drawMember(c, s);
	}

	private drawManager(c: HTMLElement, s: PanelHost["settings"]): void {
		// 토글 = 실시간 on/off (상태와 제어를 하나로).
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

		if (!s.realtimeEnabled) {
			c.createDiv({ cls: "covault-cr-muted", text: t("realtime.off_hint") });
			c.createDiv({ cls: "covault-cr-muted", text: t("realtime.configure_in_settings") });
			return;
		}

		// 실시간이 안 될 조건만 경고로(상시 설정 정보는 숨김).
		const secretPresent = !!getSecretValue(this.host.app, YJS_SECRET_ID, s.yjsSecret);
		if (!s.yjsServerUrl) c.createDiv({ cls: "covault-issue is-warn", text: t("realtime.no_server_hint") });
		if (!secretPresent) c.createDiv({ cls: "covault-issue is-warn", text: t("realtime.secret_missing_hint") });

		// 현재 세션(라이브).
		c.createDiv({ cls: "covault-dash-label", text: t("realtime.current_session") });
		this.sessionEl = c.createDiv({ cls: "covault-rt-session" });
		this.renderSession();

		// 이 파일 실시간 참여자(활성 파일이 공유 공간에 있을 때).
		this.partEl = c.createDiv();
		void this.renderFileParticipants();

		// 구성원별 실시간 허용/차단.
		const members = s.members.filter((m) => m.memberId && m.provisioned);
		if (members.length > 0) {
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

		// 공간 토큰 현황.
		if (s.sharedSpaces.length > 0) {
			c.createDiv({ cls: "covault-dash-label", text: t("realtime.spaces_tokens") });
			const list = c.createDiv({ cls: "covault-rt-status" });
			for (const sp of s.sharedSpaces) this.statusRow(list, sp.name || sp.id, sp.token ? t("common.set") : t("common.none"));
		}

		// 세션 스냅샷 주기.
		new Setting(c).setName(t("settings.in_session_snapshot_interval_sec")).addText((txt) => {
			txt.inputEl.type = "number";
			txt.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec)).onChange(async (v) => {
				const n = Number(v);
				s.realtimeSnapshotSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
				await this.host.saveSettings();
			});
		});

		// 액션.
		const actions = c.createDiv({ cls: "covault-panel-actions" });
		const redeploy = panelButton(actions, t("realtime.redeploy_tokens"), () => this.run(() => this.host.redeployRealtime()), { cta: true });
		if (!secretPresent) redeploy.disabled = true; // 시크릿 없이 재배포하면 토큰이 모두 삭제됨 → 막는다.
		panelButton(actions, t("panel.check_realtime_status"), () => void this.host.realtimeStatus());

		c.createDiv({ cls: "covault-cr-muted", text: t("realtime.configure_in_settings") });
	}

	private drawMember(c: HTMLElement, s: PanelHost["settings"]): void {
		// 구성원은 토글이 없으므로 on/off는 한 번만 표시(중복 아님). 서버 URL은 구성원에게 불필요해 숨김.
		const status = c.createDiv({ cls: "covault-rt-status" });
		this.statusRow(status, t("settings.realtime_status"), s.realtimeEnabled ? t("common.on") : t("common.off"));
		this.statusRow(status, t("settings.realtime_token"), this.host.realtimeTokenReceived() ? t("common.set") : t("common.none"));

		if (s.realtimeEnabled) {
			c.createDiv({ cls: "covault-dash-label", text: t("realtime.current_session") });
			this.sessionEl = c.createDiv({ cls: "covault-rt-session" });
			this.renderSession();
		}

		const actions = c.createDiv({ cls: "covault-panel-actions" });
		panelButton(actions, t("panel.check_realtime_status"), () => void this.host.realtimeStatus());
		c.createDiv({ cls: "covault-cr-muted", text: t("realtime.member_note") });
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
		if (this.partEl) void this.renderFileParticipants();
	}

	/** 활성 파일이 공유 공간에 있으면 파일별 실시간 참여자 선택 UI를 그린다(교사). */
	private async renderFileParticipants(): Promise<void> {
		const el = this.partEl;
		if (!el || !this.manager) return;
		const s = this.host.settings;
		const f = this.host.app.workspace.getActiveFile();
		const sp = f ? s.sharedSpaces.find((x) => x.folder && (f.path === x.folder || f.path.startsWith(x.folder + "/"))) : undefined;
		if (!f || !sp || sp.members.length === 0) {
			el.empty();
			return;
		}
		const current = await this.host.getFileRealtimeParticipants(f.path); // null=전원
		if (this.host.app.workspace.getActiveFile()?.path !== f.path) return; // 비동기 중 파일이 바뀌면 무시
		el.empty();
		el.createDiv({ cls: "covault-dash-label", text: t("realtime.file_participants") });
		el.createDiv({ cls: "covault-cr-muted", text: f.basename });
		const selected = new Set(current ?? sp.members);
		for (const id of sp.members) {
			const m = s.members.find((x) => x.memberId === id);
			const row = el.createDiv({ cls: "covault-cr-check" });
			const cb = row.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = selected.has(id);
			cb.onchange = async () => {
				if (cb.checked) selected.add(id);
				else selected.delete(id);
				// 전원 선택 = 지정 해제(기본). 일부면 명단 지정.
				const ids = selected.size >= sp.members.length ? null : [...selected];
				await this.host.setFileRealtimeParticipants(f.path, ids);
			};
			row.createSpan({ text: m?.memberName || id });
		}
		el.createDiv({ cls: "covault-cr-muted", text: t("realtime.file_participants_hint") });
	}

	dispose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		for (const r of this.refs) this.host.app.workspace.offref(r);
		this.refs = [];
		this.root = null;
		this.sessionEl = null;
		this.partEl = null;
	}
}
