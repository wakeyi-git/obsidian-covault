import { PanelHost, panelButton } from "../PanelSection";
import { RoutineDoc } from "../../../core/model/types";
import { dayStr, routineAppliesOn, completion, completionPct, computeStreak } from "../../../core/classroom/routines";
import { RoutineEditModal } from "../../RoutineEditModal";
import { t } from "../../../i18n";

/** 루틴(체크리스트) 모듈 — 교사: 정의 + 오늘 완료 현황 / 학생: 오늘 체크. */
export class RoutinesView {
	private container: HTMLElement | null = null;
	private readonly day = dayStr(Date.now());

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-dash-modhead" });
		panelButton(head, t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-dash-modtitle", text: t("dashboard.routines") });
		if (this.manager) {
			panelButton(
				head,
				t("dashboard.new_routine"),
				() =>
					new RoutineEditModal(this.host.app, async (input) => {
						const ok = await this.host.createRoutine(input);
						if (ok) await this.reload();
					}).open(),
				{ cta: true },
			);
		}

		if (!this.host.homeroomReady()) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.homeroom_not_ready") });
			return;
		}

		const routines = await this.host.listRoutines();
		if (this.manager) await this.renderManager(c, routines);
		else await this.renderMember(c, routines);
	}

	private async renderManager(c: HTMLElement, routines: RoutineDoc[]): Promise<void> {
		if (routines.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.no_routines") });
			return;
		}
		const members = this.host.settings.members.filter((m) => m.memberId).map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const r of routines) {
			const card = list.createDiv({ cls: "covault-dash-card" });
			const top = card.createDiv({ cls: "covault-dash-card-row" });
			top.createSpan({ cls: "covault-dash-card-title", text: r.title });
			panelButton(top, t("common.delete"), async () => {
				await this.host.deleteRoutine(r.uid);
				await this.reload();
			}, { warning: true });
			const states = await this.host.listRoutineStates(r.uid, this.day);
			const byMember = new Map(states.map((s) => [s.memberId, s]));
			for (const m of members) {
				const comp = completion(r, byMember.get(m.memberId));
				const line = card.createDiv({ cls: "covault-dash-matrix-row" });
				line.createSpan({ cls: "covault-dash-matrix-name", text: m.memberName });
				line.createSpan({ cls: "covault-dash-score", text: `${comp.done}/${comp.total} (${completionPct(comp)}%)` });
			}
		}
	}

	private async renderMember(c: HTMLElement, all: RoutineDoc[]): Promise<void> {
		const now = Date.now();
		const routines = all.filter((r) => routineAppliesOn(r, now));
		if (routines.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.no_routines_today") });
			return;
		}
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const r of routines) {
			const days = await this.host.myRoutineDays(r.uid);
			const state = days.find((d) => d.day === this.day) ?? null;
			const checked = new Set(state?.checked ?? []);
			const comp = completion(r, state);
			// 연속 완료(streak): 완전 완료한 날짜 집합으로 계산.
			const completedDays = new Set(
				days.filter((d) => {
					const cc = completion(r, d);
					return cc.total > 0 && cc.done === cc.total;
				}).map((d) => d.day),
			);
			const streak = computeStreak(r, completedDays, now);
			const card = list.createDiv({ cls: "covault-dash-card" });
			const top = card.createDiv({ cls: "covault-dash-card-row" });
			top.createSpan({ cls: "covault-dash-card-title", text: r.title });
			if (streak > 0) top.createSpan({ cls: "covault-dash-streak", text: t("dashboard.streak", { n: streak }) });
			const pct = top.createSpan({ cls: "covault-dash-score", text: `${completionPct(comp)}%` });
			for (const item of r.items) {
				const lab = card.createDiv({ cls: "covault-dash-check" });
				const cb = lab.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = checked.has(item.id);
				lab.createSpan({ text: item.label });
				cb.onchange = async () => {
					await this.host.toggleRoutineItem(r.uid, this.day, item.id, cb.checked);
					if (cb.checked) checked.add(item.id);
					else checked.delete(item.id);
					pct.setText(`${completionPct(completion(r, { checked: [...checked] } as never))}%`);
				};
			}
		}
	}

	dispose(): void {
		this.container = null;
	}
}
