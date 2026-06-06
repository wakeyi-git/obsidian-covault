import { PanelHost, panelButton } from "../PanelSection";
import { RoutineDoc } from "../../../core/model/types";
import { dayStr, routineAppliesOn, itemsOn, completion, completionPct, computeStreak } from "../../../core/classroom/routines";
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
			const actions = top.createDiv({ cls: "covault-dash-rowactions" });
			panelButton(actions, t("dashboard.edit"), () =>
				new RoutineEditModal(
					this.host.app,
					async (input) => {
						await this.host.updateRoutine(r.uid, input);
						await this.reload();
					},
					{ title: r.title, items: r.items },
				).open(),
			);
			panelButton(actions, t("common.delete"), async () => {
				await this.host.deleteRoutine(r.uid);
				await this.reload();
			}, { warning: true });
			const now = Date.now();
			const states = await this.host.listRoutineStates(r.uid, this.day);
			const byMember = new Map(states.map((s) => [s.memberId, s]));
			for (const m of members) {
				const comp = completion(r, byMember.get(m.memberId), now);
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
			const statesByDay = new Map(days.map((d) => [d.day, d]));
			const state = statesByDay.get(this.day) ?? null;
			const checked = new Set(state?.checked ?? []);
			const streak = computeStreak(r, statesByDay, now);
			const todayItems = itemsOn(r, now); // 오늘 해당되는 항목만 표시/계산
			const card = list.createDiv({ cls: "covault-dash-card" });
			const top = card.createDiv({ cls: "covault-dash-card-row" });
			top.createSpan({ cls: "covault-dash-card-title", text: r.title });
			if (streak > 0) top.createSpan({ cls: "covault-dash-streak", text: t("dashboard.streak", { n: streak }) });
			const pct = top.createSpan({ cls: "covault-dash-score", text: `${completionPct(completion(r, state, now))}%` });
			for (const item of todayItems) {
				const lab = card.createDiv({ cls: "covault-dash-check" });
				const cb = lab.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = checked.has(item.id);
				lab.createSpan({ text: item.label });
				cb.onchange = async () => {
					await this.host.toggleRoutineItem(r.uid, this.day, item.id, cb.checked);
					if (cb.checked) checked.add(item.id);
					else checked.delete(item.id);
					const done = todayItems.filter((it) => checked.has(it.id)).length;
					pct.setText(`${completionPct({ done, total: todayItems.length })}%`);
				};
			}
		}
	}

	dispose(): void {
		this.container = null;
	}
}
