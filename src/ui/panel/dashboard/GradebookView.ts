import { Notice, setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { NoticeDoc, ResponseDoc, AssignmentStateDoc, RoutineStateDoc, noticePrefix, RESPONSE_ID_PREFIX } from "../../../core/model/types";
import { rubricMax } from "../../../core/classroom/assignments";
import { computeStats, ratePct, MemberStats } from "../../../core/classroom/stats";
import { t } from "../../../i18n";

function localDateStr(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

interface Metric {
	key: string;
	label: string;
	icon: string;
	get: (s: MemberStats) => number | null;
}

/** 종합 통계(성적부) — 기간별 지표(알림장/수업 확인율·과제 제출율·평균 점수·체크리스트 완료율). 교사=전원, 학생=본인. */
export class GradebookView {
	private container: HTMLElement | null = null;
	private startDate = "";
	private endDate = "";

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private metrics(): Metric[] {
		return [
			{ key: "noticeRead", label: t("dashboard.metric_notice_read"), icon: "megaphone", get: (s) => ratePct(s.noticeRead) },
			{ key: "lessonRead", label: t("dashboard.metric_lesson_read"), icon: "calendar-days", get: (s) => ratePct(s.lessonRead) },
			{ key: "submit", label: t("dashboard.metric_submit"), icon: "clipboard-list", get: (s) => ratePct(s.submit) },
			{ key: "avgScore", label: t("dashboard.metric_avg_score"), icon: "award", get: (s) => s.avgScorePct },
			{ key: "routine", label: t("dashboard.metric_routine"), icon: "check-square", get: (s) => ratePct(s.routine) },
		];
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-cr-modhead" });
		iconButton(head, "arrow-left", t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-cr-modtitle", text: t("dashboard.gradebook") });

		const store = this.host.classroomStore;
		if (!store.ready()) {
			const box = c.createDiv({ cls: "covault-cr-empty" });
			setIcon(box.createSpan(), "table-2");
			box.createDiv({ text: t("dashboard.homeroom_not_ready") });
			return;
		}

		// 기간 기본값: 이번 달 1일 ~ 오늘
		if (!this.startDate) this.startDate = localDateStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
		if (!this.endDate) this.endDate = localDateStr(new Date());

		// 기간 선택
		const period = c.createDiv({ cls: "covault-dash-weeknav" });
		const si = period.createEl("input", { cls: "covault-dash-dateinput", attr: { type: "date" } });
		si.value = this.startDate;
		si.onchange = () => {
			if (si.value) {
				this.startDate = si.value;
				void this.reload();
			}
		};
		period.createSpan({ cls: "covault-cr-muted", text: "~" });
		const ei = period.createEl("input", { cls: "covault-dash-dateinput", attr: { type: "date" } });
		ei.value = this.endDate;
		ei.onchange = () => {
			if (ei.value) {
				this.endDate = ei.value;
				void this.reload();
			}
		};
		panelButton(period, t("dashboard.this_month"), () => {
			this.startDate = localDateStr(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
			this.endDate = localDateStr(new Date());
			void this.reload();
		});

		const startMs = new Date(`${this.startDate}T00:00`).getTime();
		const endMs = new Date(`${this.endDate}T23:59:59`).getTime();

		// 공통 데이터(학급 공유)
		const notices = await store.listByPrefix<NoticeDoc>(noticePrefix());
		const reads = (await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX)).filter((r) => r.kind === "read");
		const routines = await this.host.listRoutines();

		// 역할별 구성원/과제상태/루틴상태 수집
		let members: Array<{ memberId: string; memberName: string }>;
		const states: AssignmentStateDoc[] = [];
		const maxByUid = new Map<string, number | undefined>();
		const routineStates: RoutineStateDoc[] = [];

		if (this.manager) {
			members = this.host.settings.members
				.filter((m) => m.memberId && m.provisioned)
				.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
			for (const def of this.host.assignmentDefs()) {
				maxByUid.set(def.uid, def.rubric ? rubricMax(def.rubric) : def.points);
				states.push(...(await this.host.listAssignmentStates(def.uid)));
			}
			for (const r of routines) routineStates.push(...(await this.host.listRoutineStatesAll(r.uid)));
		} else {
			members = [{ memberId: this.host.settings.userId, memberName: this.host.settings.displayName || this.host.settings.userId }];
			const my = await this.host.listMyAssignments();
			for (const s of my) maxByUid.set(s.assignmentUid, s.maxPoints);
			states.push(...my);
			for (const r of routines) routineStates.push(...(await this.host.myRoutineDays(r.uid)));
		}

		const stats = computeStats({ startMs, endMs, members, notices, reads, states, maxByUid, routines, routineStates });

		if (members.length === 0) {
			const box = c.createDiv({ cls: "covault-cr-empty" });
			setIcon(box.createSpan(), "table-2");
			box.createDiv({ text: t("dashboard.gradebook_empty") });
			return;
		}

		// 지표별 카드
		const grid = c.createDiv({ cls: "covault-dash-list" });
		for (const metric of this.metrics()) this.renderMetricCard(grid, metric, stats);

		// CSV 내보내기(교사)
		if (this.manager) {
			panelButton(c, t("dashboard.export_csv"), async () => {
				const csv = this.buildCsv(stats);
				try {
					await navigator.clipboard.writeText(csv);
					new Notice(t("dashboard.csv_copied"));
				} catch {
					new Notice(t("dashboard.csv_copy_failed"));
				}
			});
		}
	}

	private renderMetricCard(parent: HTMLElement, metric: Metric, stats: MemberStats[]): void {
		const card = parent.createDiv({ cls: "covault-cr-card" });
		const head = card.createDiv({ cls: "covault-cr-card-head" });
		setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), metric.icon);
		head.createSpan({ cls: "covault-cr-card-title", text: metric.label });

		const vals: number[] = [];
		const matrix = card.createDiv({ cls: "covault-cr-matrix" });
		for (const s of stats) {
			const v = metric.get(s);
			if (v != null) vals.push(v);
			const row = matrix.createDiv({ cls: "covault-cr-matrix-row" });
			row.createSpan({ cls: "covault-cr-matrix-name", text: s.memberName });
			const prog = row.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = `${v ?? 0}%`;
			row.createSpan({ cls: "covault-cr-score", text: v == null ? "—" : `${v}%` });
		}
		// 학급 평균(교사, 2명 이상)
		if (this.manager && vals.length > 0 && stats.length > 1) {
			const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
			card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.class_average", { pct: avg }) });
		}
	}

	private buildCsv(stats: MemberStats[]): string {
		const ms = this.metrics();
		const header = [t("dashboard.member"), ...ms.map((m) => m.label)].join(",");
		const rows = stats.map((s) => [s.memberName, ...ms.map((m) => { const v = m.get(s); return v == null ? "" : String(v); })].join(","));
		return [header, ...rows].join("\n");
	}

	dispose(): void {
		this.container = null;
	}
}
