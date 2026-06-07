import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
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

	private empty(parent: HTMLElement, text: string, icon = "check-square"): void {
		const box = parent.createDiv({ cls: "covault-cr-empty" });
		setIcon(box.createSpan(), icon);
		box.createDiv({ text });
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-cr-modhead" });
		iconButton(head, "arrow-left", t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-cr-modtitle", text: t("dashboard.routines") });
		iconButton(head, "refresh-cw", t("dashboard.refresh"), () => void this.reload());
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
			this.empty(c, t("dashboard.homeroom_not_ready"), "inbox");
			return;
		}

		const routines = await this.host.listRoutines();
		if (this.manager) await this.renderManager(c, routines);
		else await this.renderMember(c, routines);
	}

	private async renderManager(c: HTMLElement, routines: RoutineDoc[]): Promise<void> {
		if (routines.length === 0) {
			this.empty(c, t("dashboard.no_routines"));
			return;
		}
		const members = this.host.settings.members.filter((m) => m.memberId).map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const r of routines) {
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: r.title });
			iconButton(top, "pencil", t("dashboard.edit"), () =>
				new RoutineEditModal(
					this.host.app,
					async (input) => {
						await this.host.updateRoutine(r.uid, input);
						await this.reload();
					},
					{ title: r.title, items: r.items },
				).open(),
			);
			iconButton(top, "trash-2", t("common.delete"), async () => {
				await this.host.deleteRoutine(r.uid);
				await this.reload();
			});

			const now = Date.now();
			const states = await this.host.listRoutineStates(r.uid, this.day);
			const byMember = new Map(states.map((s) => [s.memberId, s]));
			const comps = members.map((m) => completion(r, byMember.get(m.memberId), now));
			const classDone = comps.reduce((a, comp) => a + comp.done, 0);
			const classTotal = comps.reduce((a, comp) => a + comp.total, 0);

			// 학급 전체 완료 진행률(전 구성원 항목 합산)
			const prow = card.createDiv({ cls: "covault-cr-cardrow" });
			prow.createSpan({ cls: "covault-cr-muted", text: `${classDone}/${classTotal}` });
			const cprog = prow.createDiv({ cls: "covault-cr-progress" });
			cprog.createEl("i").style.width = classTotal > 0 ? `${Math.round((classDone / classTotal) * 100)}%` : "0%";

			const matrix = card.createDiv({ cls: "covault-cr-matrix" });
			members.forEach((m, i) => {
				const comp = comps[i];
				const line = matrix.createDiv({ cls: "covault-cr-matrix-row" });
				line.createSpan({ cls: "covault-cr-matrix-name", text: m.memberName });
				const mp = line.createDiv({ cls: "covault-cr-progress" });
				mp.createEl("i").style.width = `${completionPct(comp)}%`;
				line.createSpan({ cls: "covault-cr-score", text: `${comp.done}/${comp.total}` });
			});
		}
	}

	private async renderMember(c: HTMLElement, all: RoutineDoc[]): Promise<void> {
		const now = Date.now();
		const routines = all.filter((r) => routineAppliesOn(r, now));
		if (routines.length === 0) {
			this.empty(c, t("dashboard.no_routines_today"));
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
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: r.title });
			if (streak > 0) {
				const sb = top.createSpan({ cls: "covault-cr-badge is-accent" });
				setIcon(sb.createSpan(), "flame");
				sb.createSpan({ text: t("dashboard.streak", { n: streak }) });
			}

			// 완료 진행률(오늘 항목)
			const prow = card.createDiv({ cls: "covault-cr-cardrow" });
			const countEl = prow.createSpan({ cls: "covault-cr-muted" });
			const prog = prow.createDiv({ cls: "covault-cr-progress" });
			const bar = prog.createEl("i");
			const refresh = (): void => {
				const done = todayItems.filter((it) => checked.has(it.id)).length;
				countEl.setText(`${done}/${todayItems.length}`);
				bar.style.width = `${completionPct({ done, total: todayItems.length })}%`;
			};
			refresh();

			for (const item of todayItems) {
				const lab = card.createDiv({ cls: "covault-cr-check" });
				const cb = lab.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = checked.has(item.id);
				lab.toggleClass("is-done", cb.checked);
				lab.createSpan({ text: item.label });
				cb.onchange = async () => {
					await this.host.toggleRoutineItem(r.uid, this.day, item.id, cb.checked);
					if (cb.checked) checked.add(item.id);
					else checked.delete(item.id);
					lab.toggleClass("is-done", cb.checked);
					refresh();
				};
			}
		}
	}

	dispose(): void {
		this.container = null;
	}
}
