import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { RoutineDoc, RoutineStateDoc } from "../../../core/model/types";
import { dayStr, itemsOn, computeStreak } from "../../../core/classroom/routines";
import { monthMatrix, shiftMonth } from "../../../core/classroom/calendar";
import { captureScroll } from "../scroll";
import { RoutineEditModal } from "../../RoutineEditModal";
import { t } from "../../../i18n";

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 학생: 루틴 + 그 루틴의 일자별 누가기록(달력 색칠·항목 표시 공용). */
interface RoutineDayData {
	r: RoutineDoc;
	byDay: Map<string, RoutineStateDoc>;
}

/** 루틴(체크리스트) 모듈 — 교사: 날짜별 항목 현황 + 명단 / 학생: 월간 달력 누가기록 + 그날 체크. */
export class RoutinesView {
	private container: HTMLElement | null = null;
	private readonly today = Date.now();
	// 교사: 조회 날짜 / 항목 상세 펼침
	private selectedDay = dayStr(Date.now());
	// 학생: 달력 월 / 선택 날짜(달력 1개 공통, 그날의 모든 루틴 표시)
	private calYear = new Date().getFullYear();
	private calMonth0 = new Date().getMonth();
	private studentSelDay = dayStr(Date.now());

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
		// 체크 입력 등으로 재렌더 시 스크롤이 최상단으로 튀지 않도록 위치를 보존한다.
		const restore = captureScroll(c);
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
		restore();
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
				// 항목별로 (행 + 상세)를 한 블록으로 묶어 구분선을 항목 사이에만 둔다(행↔명단 사이 이중선 제거).
				const itemEl = matrix.createDiv({ cls: "covault-cr-matrix-item" });
				const row = itemEl.createDiv({ cls: "covault-cr-matrix-row is-clickable" });
				row.createSpan({ cls: "covault-cr-matrix-name", text: item.label });
				const mp = row.createDiv({ cls: "covault-cr-progress" });
				mp.createEl("i").style.width = `${members.length ? Math.round((doneMembers.length / members.length) * 100) : 0}%`;
				row.createSpan({ cls: "covault-cr-score", text: `${doneMembers.length}/${members.length}` });
				const chev = row.createSpan({ cls: "covault-cr-rowchev" });
				setIcon(chev, "chevron-right");
				// 상세(완료/미완료 명단)는 미리 만들어 두고 토글만 한다 — 펼칠 때마다 전수 재조회(reload) 제거.
				const detail = itemEl.createDiv({ cls: "covault-cr-itemdetail" });
				detail.style.display = "none";
				itemEl.toggleClass("is-open", false);
				this.namesGroup(detail, t("dashboard.completed_n", { n: doneMembers.length }), doneMembers.map((m) => m.memberName), "is-ok");
				this.namesGroup(detail, t("dashboard.incomplete_n", { n: notDone.length }), notDone.map((m) => m.memberName), "is-warn");
				row.onclick = () => {
					const open = detail.style.display === "none";
					detail.style.display = open ? "" : "none";
					itemEl.toggleClass("is-open", open);
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

	// ===== 학생: 달력 1개 + 선택 날짜의 모든 루틴 =====
	private async renderMember(c: HTMLElement, all: RoutineDoc[]): Promise<void> {
		if (all.length === 0) {
			this.empty(c, t("dashboard.no_routines"));
			return;
		}
		// 월 네비게이션(공통)
		const nav = c.createDiv({ cls: "covault-dash-weeknav" });
		iconButton(nav, "chevron-left", t("dashboard.prev_month"), () => this.shiftCalMonth(-1));
		nav.createSpan({ cls: "covault-dash-weeklabel", text: `${this.calYear}-${String(this.calMonth0 + 1).padStart(2, "0")}` });
		iconButton(nav, "chevron-right", t("dashboard.next_month"), () => this.shiftCalMonth(1));
		panelButton(nav, t("dashboard.today"), () => {
			this.calYear = new Date().getFullYear();
			this.calMonth0 = new Date().getMonth();
			this.studentSelDay = dayStr(Date.now());
			void this.reload();
		});

		// 루틴별 누가기록 선로딩(달력 색칠·항목 표시 공용).
		const data: RoutineDayData[] = [];
		for (const r of all) {
			const days = await this.host.myRoutineDays(r.uid);
			data.push({ r, byDay: new Map(days.map((d: RoutineStateDoc) => [d.day, d])) });
		}
		const todayKey = dayStr(this.today);

		// 달력 1개 — 그날 적용되는 모든 루틴 항목의 합산 완료율로 색칠.
		const cal = c.createDiv({ cls: "covault-cal" });
		const headRow = cal.createDiv({ cls: "covault-cal-grid" });
		for (const k of WEEKDAY_KEYS) headRow.createDiv({ cls: "covault-cal-head", text: t(`dashboard.wd_${k}`) });
		const grid = cal.createDiv({ cls: "covault-cal-grid" });
		for (const week of monthMatrix(this.calYear, this.calMonth0)) {
			for (const cell of week) {
				const key = dayStr(cell.ts);
				const el = grid.createDiv({ cls: "covault-cal-cell", text: String(new Date(cell.ts).getDate()) });
				if (!cell.inMonth) el.addClass("is-out");
				if (key === todayKey) el.addClass("is-today");
				if (key === this.studentSelDay) el.addClass("is-sel");
				const agg = this.aggregateForDay(data, cell.ts, key);
				if (agg.total > 0 && cell.ts <= this.today) {
					const pct = Math.round((agg.done / agg.total) * 100);
					el.addClass(pct === 0 ? "lvl-zero" : pct >= 100 ? "lvl-full" : "lvl-partial");
				}
				el.onclick = () => {
					this.studentSelDay = key;
					void this.reload();
				};
			}
		}

		// 선택 날짜의 모든 루틴 항목(그날 적용되는 것만).
		const selTs = new Date(`${this.studentSelDay}T00:00`).getTime();
		c.createDiv({ cls: "covault-cr-muted covault-cal-sel", text: this.studentSelDay });
		const list = c.createDiv({ cls: "covault-dash-list" });
		let any = false;
		for (const { r, byDay } of data) {
			if (itemsOn(r, selTs).length === 0) continue;
			any = true;
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: r.title });
			const streak = computeStreak(r, byDay, this.today);
			if (streak > 0) {
				const sb = top.createSpan({ cls: "covault-cr-badge is-accent" });
				setIcon(sb.createSpan(), "flame");
				sb.createSpan({ text: t("dashboard.streak", { n: streak }) });
			}
			this.renderRoutineItems(card, r, selTs, byDay);
		}
		if (!any) this.empty(list, t("dashboard.no_items_day"));
	}

	/** 그날 적용되는 모든 루틴 항목의 합산(완료/전체). */
	private aggregateForDay(data: RoutineDayData[], ts: number, key: string): { done: number; total: number } {
		let done = 0;
		let total = 0;
		for (const { r, byDay } of data) {
			const items = itemsOn(r, ts);
			if (items.length === 0) continue;
			const checked = new Set(byDay.get(key)?.checked ?? []);
			total += items.length;
			done += items.filter((i) => checked.has(i.id)).length;
		}
		return { done, total };
	}

	/** 한 루틴의 그날 항목 체크박스(오늘만 편집 가능, 과거/미래는 읽기 전용). */
	private renderRoutineItems(card: HTMLElement, r: RoutineDoc, ts: number, byDay: Map<string, RoutineStateDoc>): void {
		const key = dayStr(ts);
		const editable = key === dayStr(this.today);
		const checked = new Set(byDay.get(key)?.checked ?? []);
		for (const item of itemsOn(r, ts)) {
			const lab = card.createDiv({ cls: "covault-cr-check" });
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
		if (!editable) card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.past_readonly") });
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
