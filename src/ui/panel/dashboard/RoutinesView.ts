import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { RoutineDoc, RoutineStateDoc } from "../../../core/model/types";
import { dayStr, itemsOn, completion, completionPct, computeStreak } from "../../../core/classroom/routines";
import { monthMatrix, shiftMonth } from "../../../core/classroom/calendar";
import { RoutineEditModal } from "../../RoutineEditModal";
import { t } from "../../../i18n";

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 루틴(체크리스트) 모듈 — 교사: 날짜별 항목 현황 + 명단 / 학생: 월간 달력 누가기록 + 그날 체크. */
export class RoutinesView {
	private container: HTMLElement | null = null;
	private readonly today = Date.now();
	// 교사: 조회 날짜 / 항목 상세 펼침
	private selectedDay = dayStr(Date.now());
	// 학생: 달력 월 / 펼친 날짜
	private calYear = new Date().getFullYear();
	private calMonth0 = new Date().getMonth();
	private memberOpen: { uid: string; ts: number } | null = null;

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

	// ===== 교사: 날짜별 항목 현황 =====
	private async renderManager(c: HTMLElement, routines: RoutineDoc[]): Promise<void> {
		if (routines.length === 0) {
			this.empty(c, t("dashboard.no_routines"));
			return;
		}
		// 날짜 선택
		const nav = c.createDiv({ cls: "covault-dash-weeknav" });
		iconButton(nav, "chevron-left", t("dashboard.prev_day"), () => this.shiftDay(-1));
		const di = nav.createEl("input", { cls: "covault-dash-dateinput", attr: { type: "date" } });
		di.value = this.selectedDay;
		di.onchange = () => {
			if (di.value) {
				this.selectedDay = di.value;
				void this.reload();
			}
		};
		iconButton(nav, "chevron-right", t("dashboard.next_day"), () => this.shiftDay(1));
		panelButton(nav, t("dashboard.today"), () => {
			this.selectedDay = dayStr(Date.now());
			void this.reload();
		});

		const dayTs = new Date(`${this.selectedDay}T00:00`).getTime();
		const members = this.host.settings.members
			.filter((m) => m.memberId && m.provisioned)
			.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));

		const order = routines.map((r) => r.uid);
		const move = async (i: number, d: number): Promise<void> => {
			const j = i + d;
			if (j < 0 || j >= order.length) return;
			[order[i], order[j]] = [order[j], order[i]];
			await this.host.reorderRoutines(order);
			await this.reload();
		};

		const list = c.createDiv({ cls: "covault-dash-list" });
		for (let ri = 0; ri < routines.length; ri++) {
			const r = routines[ri];
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: r.title });
			if (ri > 0) iconButton(top, "chevron-up", t("dashboard.move_up"), () => move(ri, -1));
			if (ri < routines.length - 1) iconButton(top, "chevron-down", t("dashboard.move_down"), () => move(ri, 1));
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

			const items = itemsOn(r, dayTs);
			if (items.length === 0) {
				card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.no_items_day") });
				continue;
			}
			const states = await this.host.listRoutineStates(r.uid, this.selectedDay);
			const checkedBy = new Map(states.map((s) => [s.memberId, new Set(s.checked)]));

			const matrix = card.createDiv({ cls: "covault-cr-matrix" });
			for (const item of items) {
				const doneMembers = members.filter((m) => checkedBy.get(m.memberId)?.has(item.id));
				const notDone = members.filter((m) => !checkedBy.get(m.memberId)?.has(item.id));
				const row = matrix.createDiv({ cls: "covault-cr-matrix-row is-clickable" });
				row.createSpan({ cls: "covault-cr-matrix-name", text: item.label });
				const mp = row.createDiv({ cls: "covault-cr-progress" });
				mp.createEl("i").style.width = `${members.length ? Math.round((doneMembers.length / members.length) * 100) : 0}%`;
				row.createSpan({ cls: "covault-cr-score", text: `${doneMembers.length}/${members.length}` });
				const chev = row.createSpan({ cls: "covault-cr-rowchev" });
				setIcon(chev, "chevron-right");
				// 상세(완료/미완료 명단)는 미리 만들어 두고 토글만 한다 — 펼칠 때마다 전수 재조회(reload) 제거.
				const detail = matrix.createDiv({ cls: "covault-cr-itemdetail" });
				detail.style.display = "none";
				this.namesGroup(detail, t("dashboard.completed_n", { n: doneMembers.length }), doneMembers.map((m) => m.memberName), "is-ok");
				this.namesGroup(detail, t("dashboard.incomplete_n", { n: notDone.length }), notDone.map((m) => m.memberName), "is-warn");
				row.onclick = () => {
					const open = detail.style.display === "none";
					detail.style.display = open ? "" : "none";
					setIcon(chev, open ? "chevron-down" : "chevron-right");
				};
			}
		}
	}

	private namesGroup(parent: HTMLElement, label: string, names: string[], variant: string): void {
		const g = parent.createDiv({ cls: "covault-cr-namesgroup" });
		g.createSpan({ cls: `covault-cr-badge ${variant}`, text: label });
		g.createSpan({ cls: "covault-cr-muted", text: names.length ? names.join(", ") : "—" });
	}

	private shiftDay(n: number): void {
		const d = new Date(`${this.selectedDay}T00:00`);
		d.setDate(d.getDate() + n);
		this.selectedDay = dayStr(d.getTime());
		void this.reload();
	}

	// ===== 학생: 월간 달력 누가기록 =====
	private async renderMember(c: HTMLElement, all: RoutineDoc[]): Promise<void> {
		if (all.length === 0) {
			this.empty(c, t("dashboard.no_routines"));
			return;
		}
		// 월 네비게이션(전 루틴 공통)
		const nav = c.createDiv({ cls: "covault-dash-weeknav" });
		iconButton(nav, "chevron-left", t("dashboard.prev_month"), () => this.shiftCalMonth(-1));
		nav.createSpan({ cls: "covault-dash-weeklabel", text: `${this.calYear}-${String(this.calMonth0 + 1).padStart(2, "0")}` });
		iconButton(nav, "chevron-right", t("dashboard.next_month"), () => this.shiftCalMonth(1));
		panelButton(nav, t("dashboard.today"), () => {
			this.calYear = new Date().getFullYear();
			this.calMonth0 = new Date().getMonth();
			void this.reload();
		});

		const todayKey = dayStr(this.today);
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const r of all) {
			const days = await this.host.myRoutineDays(r.uid);
			const byDay = new Map(days.map((d: RoutineStateDoc) => [d.day, d]));
			const streak = computeStreak(r, byDay, this.today);

			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: r.title });
			if (streak > 0) {
				const sb = top.createSpan({ cls: "covault-cr-badge is-accent" });
				setIcon(sb.createSpan(), "flame");
				sb.createSpan({ text: t("dashboard.streak", { n: streak }) });
			}

			// 달력
			const cal = card.createDiv({ cls: "covault-cal" });
			const headRow = cal.createDiv({ cls: "covault-cal-grid" });
			for (const k of WEEKDAY_KEYS) headRow.createDiv({ cls: "covault-cal-head", text: t(`dashboard.wd_${k}`) });
			const grid = cal.createDiv({ cls: "covault-cal-grid" });
			for (const week of monthMatrix(this.calYear, this.calMonth0)) {
				for (const cell of week) {
					const el = grid.createDiv({ cls: "covault-cal-cell", text: String(new Date(cell.ts).getDate()) });
					if (!cell.inMonth) el.addClass("is-out");
					const key = dayStr(cell.ts);
					if (key === todayKey) el.addClass("is-today");
					if (this.memberOpen && this.memberOpen.uid === r.uid && dayStr(this.memberOpen.ts) === key) el.addClass("is-sel");
					// 완료 등급(미래/적용없음은 색 없음)
					const items = itemsOn(r, cell.ts);
					if (items.length > 0 && cell.ts <= this.today) {
						const comp = completion(r, byDay.get(key), cell.ts);
						const pct = completionPct(comp);
						el.addClass(pct === 0 ? "lvl-zero" : pct >= 100 ? "lvl-full" : "lvl-partial");
					}
					el.onclick = () => {
						this.memberOpen = this.memberOpen && this.memberOpen.uid === r.uid && dayStr(this.memberOpen.ts) === key ? null : { uid: r.uid, ts: cell.ts };
						void this.reload();
					};
				}
			}

			// 선택 날짜 상세(없으면 오늘)
			if (this.memberOpen && this.memberOpen.uid === r.uid) {
				this.renderDayDetail(card, r, this.memberOpen.ts, byDay);
			}
		}
	}

	private renderDayDetail(card: HTMLElement, r: RoutineDoc, ts: number, byDay: Map<string, RoutineStateDoc>): void {
		const key = dayStr(ts);
		const items = itemsOn(r, ts);
		const detail = card.createDiv({ cls: "covault-cr-itemdetail" });
		detail.createDiv({ cls: "covault-cr-muted", text: key });
		if (items.length === 0) {
			detail.createDiv({ cls: "covault-cr-muted", text: t("dashboard.no_items_day") });
			return;
		}
		const editable = key === dayStr(this.today);
		const checked = new Set(byDay.get(key)?.checked ?? []);
		for (const item of items) {
			const lab = detail.createDiv({ cls: "covault-cr-check" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = checked.has(item.id);
			cb.disabled = !editable;
			lab.toggleClass("is-done", cb.checked);
			lab.createSpan({ text: item.label });
			if (editable) {
				cb.onchange = async () => {
					await this.host.toggleRoutineItem(r.uid, key, item.id, cb.checked);
					await this.reload();
				};
			}
		}
		if (!editable) detail.createDiv({ cls: "covault-cr-muted", text: t("dashboard.past_readonly") });
	}

	private shiftCalMonth(n: number): void {
		const { year, month0 } = shiftMonth(this.calYear, this.calMonth0, n);
		this.calYear = year;
		this.calMonth0 = month0;
		void this.reload();
	}

	dispose(): void {
		this.container = null;
	}
}
