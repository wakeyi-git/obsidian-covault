import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { NoticesView } from "./dashboard/NoticesView";
import { TimetableView } from "./dashboard/TimetableView";
import { AssignmentsView } from "./dashboard/AssignmentsView";
import { RoutinesView } from "./dashboard/RoutinesView";
import { GradebookView } from "./dashboard/GradebookView";
import { t } from "../../i18n";

type DashView = "hub" | "notices" | "lessons" | "timetable" | "assignments" | "routines" | "gradebook";

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
		// 원격 변경(다른 기기 게시/응답) 시 현재 화면 갱신.
		this.unsub = this.host.classroomStore.onChange(() => this.draw());
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
		if (this.view === "timetable") {
			const v = new TimetableView(this.host, () => this.go("hub"));
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

	private drawHub(c: HTMLElement): void {
		const manager = this.host.settings.role === "manager";
		const ready = this.host.homeroomReady();

		c.createDiv({ cls: "covault-dash-title", text: t("dashboard.classroom_dashboard") });

		if (!ready) {
			const box = c.createDiv({ cls: "covault-issues" });
			box.createDiv({
				cls: "covault-issues-title",
				text: manager ? t("dashboard.homeroom_not_set_manager") : t("dashboard.homeroom_not_set_member"),
			});
			if (manager)
				panelButton(box, t("dashboard.create_homeroom"), async () => {
					await this.host.ensureHomeroom();
					this.draw();
				}, { cta: true });
		}

		const grid = c.createDiv({ cls: "covault-dash-grid" });
		this.moduleCard(grid, t("dashboard.notices"), t("dashboard.notices_desc"), () => this.go("notices"));
		this.moduleCard(grid, t("dashboard.lessons"), t("dashboard.lessons_desc"), () => this.go("lessons"));
		this.moduleCard(grid, t("dashboard.timetable"), t("dashboard.timetable_desc"), () => this.go("timetable"));
		this.moduleCard(grid, t("dashboard.assignments"), t("dashboard.assignments_desc"), () => this.go("assignments"));
		this.moduleCard(grid, t("dashboard.routines"), t("dashboard.routines_desc"), () => this.go("routines"));
		if (manager) this.moduleCard(grid, t("dashboard.gradebook"), t("dashboard.gradebook_desc"), () => this.go("gradebook"));
	}

	private moduleCard(parent: HTMLElement, title: string, desc: string, open: (() => void) | null): void {
		const card = parent.createDiv({ cls: `covault-dash-card${open ? " is-clickable" : ""}` });
		card.createDiv({ cls: "covault-dash-card-title", text: title });
		card.createDiv({ cls: "covault-dash-card-desc", text: desc });
		if (open) card.onclick = () => open();
		else card.createDiv({ cls: "covault-dash-card-soon", text: t("dashboard.coming_soon") });
	}

	dispose(): void {
		this.unsub?.();
		this.unsub = null;
		this.active?.dispose();
		this.active = null;
		this.root = null;
	}
}
