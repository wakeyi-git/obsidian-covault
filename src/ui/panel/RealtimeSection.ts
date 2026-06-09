import { EventRef, Setting, TFile, setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { getYjsSecret } from "../../core/secret";
import { t } from "../../i18n";

/**
 * 실시간 공동 편집(Yjs) 제어·상태 탭.
 * 구성: 실시간(토글+스냅샷 주기) → 공유 파일 읽기 전용 → 활성 세션 → 이 파일 참여자 → 문제 해결.
 */
export class RealtimeSection implements PanelSection {
	private root: HTMLElement | null = null;
	private sessionEl: HTMLElement | null = null;
	private partEl: HTMLElement | null = null;
	private refs: EventRef[] = [];
	private timer: number | null = null;
	private sessSig = ""; // 세션 목록 시그니처(변화 없으면 재구성 생략)
	private partPath: string | null = null; // 마지막 렌더한 파일(같은 파일이면 타이머에 재구성 안 함)

	constructor(private host: PanelHost) {}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	render(container: HTMLElement): void {
		this.root = container;
		this.refs.push(this.host.app.workspace.on("active-leaf-change", () => this.refreshLive()));
		this.refs.push(this.host.app.workspace.on("file-open", () => this.refreshLive()));
		this.timer = window.setInterval(() => this.refreshLive(), 2000);
		this.draw();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		c.empty();
		c.addClass("covault-panel-section");
		this.sessionEl = null;
		this.partEl = null;
		this.sessSig = "";
		this.partPath = null;
		const s = this.host.settings;

		if (this.manager) this.drawManager(c, s);
		else this.drawMember(c, s);
	}

	private drawManager(c: HTMLElement, s: PanelHost["settings"]): void {
		// 실시간 그룹: 사용 토글 + 세션 스냅샷 주기.
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

		new Setting(c).setName(t("settings.in_session_snapshot_interval_sec")).addText((txt) => {
			txt.inputEl.type = "number";
			txt.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec)).onChange(async (v) => {
				const n = Number(v);
				s.realtimeSnapshotSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
				await this.host.saveSettings();
			});
		});

		if (!s.yjsServerUrl) c.createDiv({ cls: "covault-issue is-warn", text: t("realtime.no_server_hint") });

		// 공유 파일 읽기 전용 정책.
		new Setting(c)
			.setName(t("realtime.shared_readonly"))
			.setDesc(t("realtime.shared_readonly_desc"))
			.addToggle((tg) =>
				tg.setValue(!!s.sharedReadOnly).onChange(async (v) => {
					await this.host.setSharedReadOnly(v);
					this.draw();
				}),
			);

		// 활성 세션(라이브) + 지정된 파일. 활성 파일 카드는 강조되고, 그 카드 안에서 참여자 칩이 펼쳐진다.
		c.createDiv({ cls: "covault-dash-label", text: t("realtime.active_sessions") });
		this.sessionEl = c.createDiv({ cls: "covault-rt-session" });
		// 참여자 칩 박스(안정 노드) — renderSessions가 활성 카드 안으로 이동시킨다. 칩 클릭이 카드 열기로
		// 전파되지 않도록 stopPropagation.
		this.partEl = c.createDiv({ cls: "covault-rt-partbox" });
		this.partEl.addEventListener("click", (e) => e.stopPropagation());
		void this.renderSessions();
		void this.renderFileParticipants();

		// 문제 해결.
		const secretPresent = !!getYjsSecret(this.host.app, s.yjsSecret);
		c.createDiv({ cls: "covault-dash-label", text: t("realtime.troubleshooting") });
		const actions = c.createDiv({ cls: "covault-panel-actions" });
		const redeploy = panelButton(actions, t("realtime.redeploy_tokens"), () => this.run(() => this.host.redeployRealtime()), { cta: true });
		if (!secretPresent) redeploy.disabled = true;
		panelButton(actions, t("panel.check_realtime_status"), () => void this.host.realtimeStatus());
		if (!secretPresent) c.createDiv({ cls: "covault-issue is-warn", text: t("realtime.secret_missing_hint") });
		c.createDiv({ cls: "covault-cr-muted", text: t("realtime.configure_in_settings") });
	}

	private drawMember(c: HTMLElement, s: PanelHost["settings"]): void {
		// 구성원 실시간 탭은 활성 세션 목록만 — 내가 라이브 참여자로 지정된 파일만 카드로.
		if (!s.realtimeEnabled) {
			c.createDiv({ cls: "covault-cr-muted", text: t("realtime.member_off") });
			return;
		}
		c.createDiv({ cls: "covault-dash-label", text: t("realtime.active_sessions") });
		this.sessionEl = c.createDiv({ cls: "covault-rt-session" });
		void this.renderSessions();
	}

	private async run(fn: () => Promise<void>): Promise<void> {
		await fn();
		this.draw();
	}

	/**
	 * 실시간 파일 목록 — 현재 열린 세션 + 참여자가 지정된(닫혀 있어도) 파일을 합쳐 보여준다.
	 * 탭을 닫아도 카드가 유지되어 클릭 한 번으로 다시 열 수 있다. 활성 파일 카드는 테두리 강조.
	 */
	private async renderSessions(): Promise<void> {
		const el = this.sessionEl;
		if (!el) return;
		const open = this.host.realtimeSessions(); // [{path, participants}] 이 기기에서 열린 세션
		const configured = await this.host.listRealtimeFiles(); // 지정된 파일(닫혀도) — 역할별 필터됨
		if (this.sessionEl !== el) return; // 비동기 대기 중 재드로우되었으면 중단

		type Row = { path: string; open: boolean; participants: number; memberIds: string[] | null; memberNames?: Record<string, string> };
		const byPath = new Map<string, Row>();
		for (const c of configured) byPath.set(c.path, { path: c.path, open: false, participants: 0, memberIds: c.memberIds, memberNames: c.memberNames });
		for (const o of open) {
			const r = byPath.get(o.path) ?? { path: o.path, open: false, participants: 0, memberIds: null };
			r.open = true;
			r.participants = o.participants;
			byPath.set(o.path, r);
		}
		const rows = [...byPath.values()].sort((a, b) => Number(b.open) - Number(a.open) || a.path.localeCompare(b.path));
		const activePath = this.host.app.workspace.getActiveFile()?.path ?? "";

		// 변화 없으면 재구성 생략(불필요한 DOM 교체로 카드 클릭이 씹히는 것 방지).
		// 열린 파일은 참가자 수만, 닫힌 지정 파일은 지정 명단만 본다 — 참여자 칩 토글이 목록을
		// 재구성하지 않게(활성 파일은 열려 있어 토글해도 시그니처 불변) → 칩 클릭 안정성.
		const sig =
			rows.map((r) => (r.open ? `${r.path}:o${r.participants}` : `${r.path}:a${(r.memberIds ?? []).join(",")}`)).join("|") + "#" + activePath;
		if (sig === this.sessSig && el.childElementCount > 0) return;
		this.sessSig = sig;
		el.empty();
		if (rows.length === 0) {
			el.createDiv({ cls: "covault-cr-muted", text: t("realtime.session_none") });
			return;
		}
		let activeCard: HTMLElement | null = null;
		for (const r of rows) {
			// 카드 전체를 클릭하면 파일이 열린다(별도 '열기' 버튼 제거).
			const box = el.createDiv({ cls: "covault-cr-card covault-rt-sescard" });
			if (r.path === activePath) {
				box.addClass("is-active"); // 활성 파일 강조
				activeCard = box;
			}
			box.setAttr("role", "button");
			box.setAttr("aria-label", t("dashboard.open"));
			box.onclick = () => this.openFile(r.path);
			const head = box.createDiv({ cls: "covault-cr-card-head" });
			setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), "radio");
			head.createSpan({ cls: "covault-cr-card-title", text: r.path.split("/").pop() ?? r.path });
			box.createDiv({ cls: "covault-cr-muted", text: r.path });
			// 참가자/지정 배지를 경로 아래(이전 '함께' 줄 위치)에 배치. 별도 '함께 이름' 줄은 제거.
			if (r.open) {
				const badge = box.createDiv({ cls: "covault-cr-badge is-accent covault-rt-sesbadge" });
				setIcon(badge.createSpan(), "users");
				badge.createSpan({ text: t("realtime.participants_n", { n: r.participants }) });
			} else if (r.memberIds != null) {
				const badge = box.createDiv({ cls: "covault-cr-badge covault-rt-sesbadge" });
				setIcon(badge.createSpan(), "user-check");
				badge.createSpan({ text: t("realtime.assigned_n", { n: r.memberIds.length }) });
			}
		}
		// 참여자 칩 박스(안정 노드)를 활성 카드 안으로 펼친다 — 재구성하지 않고 이동만 해 클릭 안정.
		if (this.partEl) (activeCard ?? el).appendChild(this.partEl);
	}

	private openFile(path: string): void {
		const f = this.host.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) void this.host.app.workspace.getLeaf(false).openFile(f, { active: true });
	}

	/** 활성 파일이 공유 공간에 있으면 파일별 실시간 참여자 선택 UI(교사). */
	private async renderFileParticipants(force = false): Promise<void> {
		const el = this.partEl;
		if (!el || !this.manager) return;
		const s = this.host.settings;
		const f = this.host.app.workspace.getActiveFile();
		const path = f?.path ?? null;
		// 같은 파일이면 재구성 생략 — 타이머가 그리드를 부수면서 체크 클릭이 씹히는 문제 방지.
		if (!force && path === this.partPath) return;
		this.partPath = path;
		const sp = f ? s.sharedSpaces.find((x) => x.folder && (f.path === x.folder || f.path.startsWith(x.folder + "/"))) : undefined;
		if (!f || !sp || sp.members.length === 0) {
			el.empty();
			return;
		}
		const current = await this.host.getFileRealtimeParticipants(f.path); // null=기본값
		if (this.host.app.workspace.getActiveFile()?.path !== f.path) return;
		el.empty();
		// 제목·파일명 없음 — 위 목록에서 강조된(활성) 카드가 어떤 파일인지 알려준다.
		// 기본값: 읽기 전용 정책이면 '아무도', 해제 상태면 '전원'(게이트와 일관).
		const defaultEveryone = !s.sharedReadOnly;
		const selected = new Set(current ?? (defaultEveryone ? sp.members : []));
		const grid = el.createDiv({ cls: "covault-rt-parts" });
		for (const id of sp.members) {
			const m = s.members.find((x) => x.memberId === id);
			const lab = grid.createEl("label", { cls: "covault-rt-part" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = selected.has(id);
			cb.onchange = async () => {
				if (cb.checked) selected.add(id);
				else selected.delete(id);
				lab.toggleClass("is-on", cb.checked);
				// 지정 문서를 삭제(null)하면 기본값으로 복귀: 전원기본이면 '전원선택', 아무도기본이면 '무선택'에서.
				const ids = defaultEveryone
					? selected.size >= sp.members.length
						? null
						: [...selected]
					: selected.size === 0
						? null
						: [...selected];
				await this.host.setFileRealtimeParticipants(f.path, ids);
			};
			lab.toggleClass("is-on", cb.checked);
			lab.createSpan({ text: m?.memberName || id });
		}
		el.createDiv({ cls: "covault-cr-muted", text: t("realtime.file_participants_hint") });
	}

	private refreshLive(): void {
		if (this.sessionEl) void this.renderSessions();
		if (this.partEl) void this.renderFileParticipants();
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
