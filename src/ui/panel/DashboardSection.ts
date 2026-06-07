import { setIcon } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { NoticesView } from "./dashboard/NoticesView";
import { AssignmentsView } from "./dashboard/AssignmentsView";
import { RoutinesView } from "./dashboard/RoutinesView";
import { GradebookView } from "./dashboard/GradebookView";
import { NoticeDoc, ResponseDoc, noticePrefix, RESPONSE_ID_PREFIX } from "../../core/model/types";
import { itemsOn, dayStr } from "../../core/classroom/routines";
import { t } from "../../i18n";

type DashView = "hub" | "notices" | "lessons" | "assignments" | "routines" | "gradebook";

/**
 * 학급 운영 대시보드(홈). 허브에서 모듈(알림장·시간표/수업·과제·체크리스트)로 진입한다.
 * 알림장·시간표는 동작, 과제·체크리스트는 다음 단계(준비 중).
 */
export class DashboardSection implements PanelSection {
	private root: HTMLElement | null = null;
	private view: DashView = "hub";
	private active: { dispose(): void } | null = null;
	private unsub: (() => void) | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		this.root = container;
		// 변경 알림 시 허브만 갱신(요약 최신화). 모듈 뷰는 자체 상태(선택한 주 등)를 잃지 않도록 재생성하지 않는다.
		this.unsub = this.host.classroomStore.onChange(() => {
			if (this.view === "hub") this.draw();
		});
		this.draw();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		this.active?.dispose();
		this.active = null;
		c.empty();

		if (this.view === "notices") {
			const v = new NoticesView(this.host, () => this.go("hub"), "notice");
			this.active = v;
			v.render(c);
			return;
		}
		if (this.view === "lessons") {
			const v = new NoticesView(this.host, () => this.go("hub"), "lesson");
			this.active = v;
			v.render(c);
			return;
		}
		if (this.view === "assignments") {
			const v = new AssignmentsView(this.host, () => this.go("hub"));
			this.active = v;
			v.render(c);
			return;
		}
		if (this.view === "routines") {
			const v = new RoutinesView(this.host, () => this.go("hub"));
			this.active = v;
			v.render(c);
			return;
		}
		if (this.view === "gradebook") {
			const v = new GradebookView(this.host, () => this.go("hub"));
			this.active = v;
			v.render(c);
			return;
		}
		this.drawHub(c);
	}

	private go(view: DashView): void {
		this.view = view;
		this.draw();
	}

	/** 대시보드 탭을 다시 누르면 허브(첫 페이지)로 복귀. */
	onReactivate(): void {
		if (this.view !== "hub") this.go("hub");
	}

	private drawHub(c: HTMLElement): void {
		const manager = this.host.settings.role === "manager";
		const ready = this.host.homeroomReady();

		c.createDiv({ cls: "covault-cr-title", text: t("dashboard.classroom_dashboard") });

		if (!ready) {
			const box = c.createDiv({ cls: "covault-cr-notice" });
			box.createDiv({
				cls: "covault-cr-notice-text",
				text: manager ? t("dashboard.homeroom_not_set_manager") : t("dashboard.homeroom_not_set_member"),
			});
			if (manager) panelButton(box, t("dashboard.open_settings_homeroom"), () => this.host.openSettings(), { cta: true });
		}

		const grid = c.createDiv({ cls: "covault-cr-grid" });
		const fullKeys = this.orderedKeys();
		const mods = this.moduleDefs();
		const enabled = this.host.settings.classroomModules;
		const visible = fullKeys.filter((k) => enabled?.[k as keyof typeof enabled] !== false);
		for (const key of visible) {
			const m = mods[key];
			if (m) this.moduleCard(grid, key, m.icon, m.title, m.desc, m.open, m.summary, fullKeys);
		}
	}

	/** 모듈 키 → 표시 정보. */
	private moduleDefs(): Record<string, { icon: string; title: string; desc: string; open: () => void; summary: () => Promise<string> }> {
		return {
			notices: { icon: "megaphone", title: t("dashboard.notices"), desc: t("dashboard.notices_desc"), open: () => this.go("notices"), summary: () => this.noticeSummary("notice") },
			lessons: { icon: "calendar-days", title: t("dashboard.lessons"), desc: t("dashboard.lessons_with_timetable_desc"), open: () => this.go("lessons"), summary: () => this.noticeSummary("lesson") },
			assignments: { icon: "clipboard-list", title: t("dashboard.assignments"), desc: t("dashboard.assignments_desc"), open: () => this.go("assignments"), summary: () => this.assignmentsSummary() },
			routines: { icon: "check-square", title: t("dashboard.routines"), desc: t("dashboard.routines_desc"), open: () => this.go("routines"), summary: () => this.routinesSummary() },
			gradebook: { icon: "table-2", title: t("dashboard.gradebook"), desc: t("dashboard.gradebook_desc"), open: () => this.go("gradebook"), summary: () => this.gradebookSummary() },
		};
	}

	private static readonly DEFAULT_ORDER = ["notices", "lessons", "assignments", "routines", "gradebook"];

	/** 저장된 순서를 적용한 전체 모듈 키(미지정·신규 키는 기본 순서로 뒤에 보충). */
	private orderedKeys(): string[] {
		const saved = this.host.settings.dashboardOrder ?? [];
		const all = DashboardSection.DEFAULT_ORDER;
		const ordered = saved.filter((k) => all.includes(k));
		for (const k of all) if (!ordered.includes(k)) ordered.push(k);
		return ordered;
	}

	private async reorder(dragKey: string, targetKey: string): Promise<void> {
		const keys = this.orderedKeys();
		const from = keys.indexOf(dragKey);
		const to = keys.indexOf(targetKey);
		if (from < 0 || to < 0 || from === to) return;
		keys.splice(to, 0, keys.splice(from, 1)[0]);
		this.host.settings.dashboardOrder = keys;
		await this.host.saveSettings();
		this.draw();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private moduleCard(
		parent: HTMLElement,
		key: string,
		icon: string,
		title: string,
		desc: string,
		open: (() => void) | null,
		summary?: () => Promise<string>,
		dragKeys?: string[],
	): void {
		const card = parent.createDiv({ cls: `covault-cr-card${open ? " is-clickable" : ""}` });
		const head = card.createDiv({ cls: "covault-cr-card-head" });
		setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), icon);
		head.createSpan({ cls: "covault-cr-card-title", text: title });
		// 드래그 배치(허브)
		if (dragKeys) {
			const grip = head.createSpan({ cls: "covault-cr-drag", attr: { "aria-label": t("dashboard.drag_to_reorder") } });
			setIcon(grip, "grip-vertical");
			grip.onclick = (e) => e.stopPropagation(); // 그립 클릭이 카드 열기로 번지지 않게
			card.draggable = true;
			card.addEventListener("dragstart", (e) => {
				e.dataTransfer?.setData("text/plain", key);
				card.addClass("is-dragging");
			});
			card.addEventListener("dragend", () => card.removeClass("is-dragging"));
			card.addEventListener("dragover", (e) => {
				e.preventDefault();
				card.addClass("is-dragover");
			});
			card.addEventListener("dragleave", () => card.removeClass("is-dragover"));
			card.addEventListener("drop", (e) => {
				e.preventDefault();
				card.removeClass("is-dragover");
				const src = e.dataTransfer?.getData("text/plain");
				if (src && src !== key) void this.reorder(src, key);
			});
		}
		card.createDiv({ cls: "covault-cr-card-desc", text: desc });
		if (summary) {
			const sumEl = card.createDiv({ cls: "covault-cr-card-summary" });
			void summary().then((text) => {
				// 허브를 벗어났으면(다른 뷰로 이동) 무시.
				if (this.view === "hub" && text) sumEl.setText(text);
			});
		}
		if (open) {
			card.onclick = () => open();
			card.setAttr("role", "button");
			card.tabIndex = 0;
			card.onkeydown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			};
		} else {
			card.createDiv({ cls: "covault-cr-card-soon", text: t("dashboard.coming_soon") });
		}
	}

	// --- 현황 요약(역할별, 완료/전체 형태). 학생=본인 진행, 교사=구성원별 집계. ---

	private async noticeSummary(category: "notice" | "lesson"): Promise<string> {
		const store = this.host.classroomStore;
		if (!store.ready()) return "";
		const notices = (await store.listByPrefix<NoticeDoc>(noticePrefix()))
			.filter((n) => !n.deleted && (n.category ?? "notice") === category)
			.sort((a, b) => b.postedAtMs - a.postedAtMs);
		if (notices.length === 0) return "";
		const resp = await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX);
		if (!this.manager) {
			// 학생: 확인한 게시물 / 전체
			const myReads = new Set(
				resp.filter((r) => r.kind === "read" && !r.deleted && r.byUser === this.host.settings.userId).map((r) => r.targetId),
			);
			const read = notices.filter((n) => myReads.has(n._id)).length;
			return t("dashboard.sum_read", { done: read, total: notices.length });
		}
		// 교사: 최신 게시물 확인 구성원 / 전체
		const latest = notices[0];
		const readers = new Set(resp.filter((r) => r.targetId === latest._id && r.kind === "read" && !r.deleted).map((r) => r.byUser));
		const members = this.host.settings.members.filter((m) => m.memberId);
		const read = members.filter((m) => readers.has(m.memberId)).length;
		return t("dashboard.sum_members_read", { done: read, total: members.length });
	}

	private async assignmentsSummary(): Promise<string> {
		if (!this.manager) {
			// 학생: 제출(또는 반환)한 과제 / 전체
			const states = await this.host.listMyAssignments();
			if (states.length === 0) return "";
			const submitted = states.filter((s) => s.state === "submitted" || s.state === "returned").length;
			return t("dashboard.sum_submitted", { done: submitted, total: states.length });
		}
		// 교사: 제출한 (과제,구성원) / 전체 대상
		const defs = this.host.assignmentDefs();
		if (defs.length === 0) return "";
		let total = 0;
		let submitted = 0;
		for (const def of defs) {
			const byId = new Map((await this.host.listAssignmentStates(def.uid)).map((s) => [s.memberId, s]));
			for (const memberId of def.targetMembers) {
				total++;
				const st = byId.get(memberId);
				if (st && (st.state === "submitted" || st.state === "returned")) submitted++;
			}
		}
		return t("dashboard.sum_submitted", { done: submitted, total });
	}

	private async routinesSummary(): Promise<string> {
		const routines = await this.host.listRoutines();
		if (routines.length === 0) return "";
		const now = Date.now();
		const day = dayStr(now);
		if (!this.manager) {
			// 학생: 오늘 체크한 항목 / 오늘 전체 항목
			let total = 0;
			let done = 0;
			for (const r of routines) {
				const items = itemsOn(r, now);
				if (items.length === 0) continue;
				const checked = new Set((await this.host.myRoutineState(r.uid, day))?.checked ?? []);
				total += items.length;
				done += items.filter((it) => checked.has(it.id)).length;
			}
			return total ? t("dashboard.sum_done", { done, total }) : "";
		}
		// 교사: 오늘 적용 항목을 모두 완료한 구성원 / (오늘 할 항목이 있는) 전체 구성원
		const members = this.host.settings.members.filter((m) => m.memberId);
		const stateMaps = new Map<string, Map<string, { checked: string[] }>>();
		for (const r of routines) {
			stateMaps.set(r.uid, new Map((await this.host.listRoutineStates(r.uid, day)).map((s) => [s.memberId, s])));
		}
		let total = 0;
		let done = 0;
		for (const m of members) {
			let hasItems = false;
			let allDone = true;
			for (const r of routines) {
				const items = itemsOn(r, now);
				if (items.length === 0) continue;
				hasItems = true;
				const checked = new Set(stateMaps.get(r.uid)?.get(m.memberId)?.checked ?? []);
				if (items.some((it) => !checked.has(it.id))) allDone = false;
			}
			if (!hasItems) continue;
			total++;
			if (allDone) done++;
		}
		return total ? t("dashboard.sum_done_members", { done, total }) : "";
	}

	private async gradebookSummary(): Promise<string> {
		const defs = this.host.assignmentDefs();
		if (defs.length === 0) return "";
		let total = 0;
		let graded = 0;
		for (const def of defs) {
			for (const st of await this.host.listAssignmentStates(def.uid)) {
				if (st.state === "submitted" || st.state === "returned") total++;
				if (st.state === "returned") graded++;
			}
		}
		return total ? t("dashboard.sum_graded", { done: graded, total }) : t("dashboard.sum_count", { n: defs.length });
	}

	dispose(): void {
		this.unsub?.();
		this.unsub = null;
		this.active?.dispose();
		this.active = null;
		this.root = null;
	}
}
