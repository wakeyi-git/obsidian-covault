import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

/**
 * 학급 운영 대시보드(홈). 알림장·시간표/수업·과제·체크리스트 모듈의 허브.
 * 이번 단계는 셸 — 학급 공유 공간 준비 상태 + 모듈 카드(준비 중) + 교사용 "학급 공간 만들기" CTA.
 * 각 모듈의 실제 UI는 다음 단계(Phase 1~4)에서 카드 안에 채운다.
 */
export class DashboardSection implements PanelSection {
	private root: HTMLElement | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		this.root = container;
		this.draw();
	}

	private draw(): void {
		const c = this.root;
		if (!c) return;
		c.empty();
		const manager = this.host.settings.role === "manager";
		const ready = this.host.homeroomReady();

		c.createDiv({ cls: "covault-dash-title", text: t("dashboard.classroom_dashboard") });

		// 학급 공간 상태/설정
		if (!ready) {
			const box = c.createDiv({ cls: "covault-issues" });
			box.createDiv({
				cls: "covault-issues-title",
				text: manager ? t("dashboard.homeroom_not_set_manager") : t("dashboard.homeroom_not_set_member"),
			});
			if (manager) {
				panelButton(box, t("dashboard.create_homeroom"), async () => {
					await this.host.ensureHomeroom();
					this.draw();
				}, { cta: true });
			}
		}

		// 모듈 카드(허브) — 다음 단계에서 내용이 채워진다.
		const grid = c.createDiv({ cls: "covault-dash-grid" });
		this.moduleCard(grid, t("dashboard.notices"), t("dashboard.notices_desc"));
		this.moduleCard(grid, t("dashboard.timetable"), t("dashboard.timetable_desc"));
		this.moduleCard(grid, t("dashboard.assignments"), t("dashboard.assignments_desc"));
		this.moduleCard(grid, t("dashboard.routines"), t("dashboard.routines_desc"));
	}

	private moduleCard(parent: HTMLElement, title: string, desc: string): void {
		const card = parent.createDiv({ cls: "covault-dash-card" });
		card.createDiv({ cls: "covault-dash-card-title", text: title });
		card.createDiv({ cls: "covault-dash-card-desc", text: desc });
		card.createDiv({ cls: "covault-dash-card-soon", text: t("dashboard.coming_soon") });
	}

	dispose(): void {
		this.root = null;
	}
}
