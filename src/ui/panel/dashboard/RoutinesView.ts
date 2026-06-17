import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { RoutineDoc, RoutineStateDoc, routineStateId } from "../../../core/model/types";
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
	/** 교사: 펼쳐 둔 항목 키(`routineUid:itemId`) — 원격 갱신·재렌더에도 펼침 상태를 유지한다. */
	private expandedItems = new Set<string>();
	// 학생: 달력 월 / 선택 날짜(달력 1개 공통, 그날의 모든 루틴 표시)
	private calYear = new Date().getFullYear();
	private calMonth0 = new Date().getMonth();
	private studentSelDay = dayStr(Date.now());
	// 체크 저장 직렬화(상태문서 단위) — 같은 날 여러 항목이 같은 doc를 써 rev 충돌나는 것을 막는다.
	private persistQueue = new Map<string, Promise<unknown>>();

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	/** 원격 변경(다른 학생의 체크 등) 시 호출 — 선택 날짜·달력 월 등 자체 상태를 보존한 채 다시 그린다. */
	refresh(): void {
		void this.reload();
	}

	/** 체크 저장이 진행 중이면 true — 빠른 연속 탭 도중 재렌더로 입력이 씹히지 않도록 갱신을 미룬다. */
	busy(): boolean {
		return this.persistQueue.size > 0;
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
			// 이 루틴의 모든 항목 명단을 한 번에 펼치기/접기. 항목 ref는 아래 루프에서 채운다.
			const detailEls: HTMLElement[] = [];
			const chevEls: HTMLElement[] = [];
			const itemEls: HTMLElement[] = [];
			const itemKeys: string[] = [];
			const setAll = (open: boolean): void => {
				for (let i = 0; i < detailEls.length; i++) {
					detailEls[i].style.display = open ? "" : "none";
					itemEls[i].toggleClass("is-open", open);
					setIcon(chevEls[i], open ? "chevron-down" : "chevron-right");
					if (open) this.expandedItems.add(itemKeys[i]);
					else this.expandedItems.delete(itemKeys[i]);
				}
				setIcon(expandAll, open ? "chevrons-down-up" : "chevrons-up-down");
				expandAll.setAttr("aria-label", open ? t("dashboard.collapse_all") : t("dashboard.expand_all"));
			};
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
			// 전체 펼치기/접기 — 카드 가장 오른쪽(항목별 펼침 아이콘 열 위)에 고정.
			const expandAll = iconButton(top, "chevrons-up-down", t("dashboard.expand_all"), () =>
				setAll(detailEls.some((d) => d.style.display === "none")),
			);
			expandAll.addClass("covault-cr-expandall");

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
				const itemKey = `${r.uid}:${item.id}`;
				const open0 = this.expandedItems.has(itemKey);
				setIcon(chev, open0 ? "chevron-down" : "chevron-right");
				// 상세(완료/미완료 명단)는 미리 만들어 두고 토글만 한다 — 펼칠 때마다 전수 재조회(reload) 제거.
				const detail = itemEl.createDiv({ cls: "covault-cr-itemdetail" });
				detail.style.display = open0 ? "" : "none";
				itemEl.toggleClass("is-open", open0);
				detailEls.push(detail);
				chevEls.push(chev);
				itemEls.push(itemEl);
				itemKeys.push(itemKey);
				this.namesGroup(detail, t("dashboard.completed_n", { n: doneMembers.length }), doneMembers.map((m) => m.memberName), "is-ok");
				this.namesGroup(detail, t("dashboard.incomplete_n", { n: notDone.length }), notDone.map((m) => m.memberName), "is-warn");
				row.onclick = () => {
					const open = detail.style.display === "none";
					detail.style.display = open ? "" : "none";
					itemEl.toggleClass("is-open", open);
					setIcon(chev, open ? "chevron-down" : "chevron-right");
					if (open) this.expandedItems.add(itemKey);
					else this.expandedItems.delete(itemKey);
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
		// 날짜 키 → 셀 element. 체크 토글 시 전체 재렌더 없이 해당 날짜 셀만 다시 색칠한다(모바일 탭 씹힘 방지).
		const cellByDay = new Map<string, HTMLElement>();
		const paintLevel = (el: HTMLElement, ts: number, key: string): void => {
			el.removeClasses(["lvl-zero", "lvl-partial", "lvl-full"]);
			const agg = this.aggregateForDay(data, ts, key);
			if (agg.total > 0 && ts <= this.today) {
				const pct = Math.round((agg.done / agg.total) * 100);
				el.addClass(pct === 0 ? "lvl-zero" : pct >= 100 ? "lvl-full" : "lvl-partial");
			}
		};
		for (const week of monthMatrix(this.calYear, this.calMonth0)) {
			for (const cell of week) {
				const key = dayStr(cell.ts);
				const el = grid.createDiv({ cls: "covault-cal-cell", text: String(new Date(cell.ts).getDate()) });
				cellByDay.set(key, el);
				if (!cell.inMonth) el.addClass("is-out");
				if (key === todayKey) el.addClass("is-today");
				if (key === this.studentSelDay) el.addClass("is-sel");
				paintLevel(el, cell.ts, key);
				el.onclick = () => {
					this.studentSelDay = key;
					void this.reload();
				};
			}
		}
		const repaintCell = (key: string): void => {
			const el = cellByDay.get(key);
			if (el) paintLevel(el, new Date(`${key}T00:00`).getTime(), key);
		};

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
			const streakSlot = top.createSpan({ cls: "covault-cr-streakslot" });
			this.paintStreak(streakSlot, r, byDay);
			// 체크 토글: 즉시 로컬 반영 + 해당 셀/연속 배지만 갱신, 저장은 백그라운드로 — 전체 reload를 없애
			// 모바일에서 빠른 연속 탭이 DOM 재생성에 씹히던 문제를 제거한다. 저장 실패 시 되돌리고 알린다.
			this.renderRoutineItems(card, r, selTs, byDay, (itemId, nowChecked, cb, lab) => {
				const day = this.studentSelDay;
				this.applyLocalCheck(byDay, r, day, itemId, nowChecked);
				repaintCell(day);
				this.paintStreak(streakSlot, r, byDay);
				this.persistToggle(r.uid, day, itemId, nowChecked, () => {
					this.applyLocalCheck(byDay, r, day, itemId, !nowChecked);
					cb.checked = !nowChecked;
					lab.toggleClass("is-done", cb.checked);
					repaintCell(day);
					this.paintStreak(streakSlot, r, byDay);
				});
			});
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

	/** 한 루틴의 그날 항목 체크박스(오늘만 편집 가능, 과거/미래는 읽기 전용). onToggle은 즉시(낙관적) 처리용. */
	private renderRoutineItems(
		card: HTMLElement,
		r: RoutineDoc,
		ts: number,
		byDay: Map<string, RoutineStateDoc>,
		onToggle?: (itemId: string, checked: boolean, cb: HTMLInputElement, lab: HTMLElement) => void,
	): void {
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
			if (editable && onToggle) {
				cb.onchange = () => {
					lab.toggleClass("is-done", cb.checked);
					onToggle(item.id, cb.checked, cb, lab);
				};
			}
		}
		if (!editable) card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.past_readonly") });
	}

	/** 연속 완료(streak) 배지를 슬롯에 다시 그린다(체크 토글 시 즉시 갱신). */
	private paintStreak(slot: HTMLElement, r: RoutineDoc, byDay: Map<string, RoutineStateDoc>): void {
		slot.empty();
		const streak = computeStreak(r, byDay, this.today);
		if (streak <= 0) return;
		const sb = slot.createSpan({ cls: "covault-cr-badge is-accent" });
		setIcon(sb.createSpan(), "flame");
		sb.createSpan({ text: t("dashboard.streak", { n: streak }) });
	}

	/** 로컬 누가기록(byDay)에 체크 변경을 즉시 반영 — 저장 응답을 기다리지 않고 달력/연속 계산을 갱신한다. */
	private applyLocalCheck(byDay: Map<string, RoutineStateDoc>, r: RoutineDoc, key: string, itemId: string, checked: boolean): void {
		const cur = byDay.get(key);
		const set = new Set(cur?.checked ?? []);
		if (checked) set.add(itemId);
		else set.delete(itemId);
		const s = this.host.settings;
		byDay.set(
			key,
			cur
				? { ...cur, checked: [...set] }
				: {
						_id: routineStateId(r.uid, s.userId, key),
						type: "routine-state",
						schemaVersion: 1,
						workspaceId: s.workspaceId,
						routineUid: r.uid,
						memberId: s.userId,
						day: key,
						checked: [...set],
						updatedAtMs: this.today,
					},
		);
	}

	/**
	 * 체크 저장을 백그라운드로 수행 — 같은 상태문서(uid:day)에 대한 쓰기를 직렬화해 rev 충돌을 막는다.
	 * 실패(거부/예외)하면 onError로 UI를 되돌리고 사용자에게 알린다.
	 */
	private persistToggle(uid: string, day: string, itemId: string, checked: boolean, onError: () => void): void {
		const k = `${uid}:${day}`;
		const next = (this.persistQueue.get(k) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const ok = await this.host.toggleRoutineItem(uid, day, itemId, checked);
				if (!ok) throw new Error("toggle rejected");
			})
			.catch(() => {
				this.host.logger.warn(t("dashboard.routine_toggle_failed"), true);
				onError();
			});
		this.persistQueue.set(k, next);
		void next.finally(() => {
			if (this.persistQueue.get(k) === next) this.persistQueue.delete(k);
		});
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
