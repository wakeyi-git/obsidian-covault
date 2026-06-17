import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { NoticeDoc, ResponseDoc, AssignmentStateDoc, RoutineStateDoc, noticePrefix, RESPONSE_ID_PREFIX } from "../../../core/model/types";
import { rubricMax } from "../../../core/classroom/assignments";
import { computeStats, ratePct, StatsInput } from "../../../core/classroom/stats";
import { splitBuckets, computeBucketStats, poolPct } from "../../../core/classroom/statsSeries";
import { computeAlerts, AssignmentAlert } from "../../../core/classroom/statsInsights";
import { weekStart, addWeeks } from "../../../core/classroom/week";
import { Metric, renderMetricCard } from "./gradebook/metricCard";
import { renderGradeTable, buildCsv } from "./gradebook/gradeTable";
import { captureScroll } from "../scroll";
import { t } from "../../../i18n";
import { copyWithNotice } from "../../util/clipboard";

const DAY_MS = 86_400_000;

function localDateStr(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

function shortDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 종합 통계(성적부) — 기간별 지표 카드/표, 추세 스파크라인, 마감 주의 알림. 교사=전원, 학생=본인. */
export class GradebookView {
	private container: HTMLElement | null = null;
	private startDate = "";
	private endDate = "";
	private viewMode: "cards" | "table" = "cards";
	/** 카드 뷰 구성원 정렬 — false=명부 순, true=낮은 값 순. */
	private sortLow = false;
	/** 표 뷰 정렬 기준 지표 key(null=명부 순). */
	private tableSortKey: string | null = null;
	/** 미달 명단을 펼친 지표 key 집합. */
	private expanded = new Set<string>();

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	/** 원격 변경 시 호출 — 기간·뷰모드·정렬·펼침 등 자체 상태를 보존한 채 통계를 다시 집계해 그린다. */
	refresh(): void {
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private metrics(): Metric[] {
		const all: Metric[] = [
			{ key: "noticeRead", label: t("dashboard.metric_notice_read"), icon: "megaphone", get: (s) => ratePct(s.noticeRead), agg: (s) => s.noticeRead },
			{ key: "lessonRead", label: t("dashboard.metric_lesson_read"), icon: "calendar-days", get: (s) => ratePct(s.lessonRead), agg: (s) => s.lessonRead },
			{ key: "submit", label: t("dashboard.metric_submit"), icon: "clipboard-list", hint: t("dashboard.metric_submit_hint"), get: (s) => ratePct(s.submit), agg: (s) => s.submit },
			{ key: "progress", label: t("dashboard.metric_progress"), icon: "list-checks", hint: t("dashboard.metric_progress_hint"), get: (s) => ratePct(s.progress), agg: (s) => s.progress },
			{ key: "onTime", label: t("dashboard.metric_on_time"), icon: "clock", hint: t("dashboard.metric_on_time_hint"), get: (s) => ratePct(s.onTime), agg: (s) => s.onTime },
			// 과제 평균: 만점 가중 풀링 — Σ득점/Σ만점. (비율 단위로 통일, 학급 평균식이 ×100)
			{ key: "avgScore", label: t("dashboard.metric_avg_score"), icon: "award", get: (s) => s.avgScorePct, agg: (s) => ({ num: s.scoreSum, den: s.maxSum }), noBehind: true },
			{ key: "graded", label: t("dashboard.metric_graded"), icon: "check-check", hint: t("dashboard.metric_graded_hint"), get: (s) => ratePct(s.graded), agg: (s) => s.graded, managerOnly: true },
			{ key: "routine", label: t("dashboard.metric_routine"), icon: "check-square", get: (s) => ratePct(s.routine), agg: (s) => s.routine },
			{ key: "streak", label: t("dashboard.metric_streak"), icon: "flame", hint: t("dashboard.metric_streak_hint"), get: (s) => s.bestStreak, fmt: (v) => t("dashboard.streak", { n: v }) },
			{ key: "participation", label: t("dashboard.metric_participation"), icon: "message-circle", get: (s) => s.participation, fmt: (v) => t("dashboard.sum_count", { n: v }) },
		];
		return this.manager ? all : all.filter((m) => !m.managerOnly);
	}

	/** 재렌더 + 스크롤 위치 보존. */
	private async reload(): Promise<void> {
		const restore = captureScroll(this.container);
		await this.rebuild();
		restore();
	}

	private setPeriod(startMs: number, endMs: number): void {
		this.startDate = localDateStr(new Date(startMs));
		this.endDate = localDateStr(new Date(endMs));
		void this.reload();
	}

	private renderPeriodControls(c: HTMLElement): void {
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

		// 기간 프리셋 — 이번 주/지난주/이번 달/지난달
		const presets = c.createDiv({ cls: "covault-dash-presets" });
		const now = new Date();
		const todayMs = now.getTime();
		const wkParse = (key: string): number => {
			const [y, m, d] = key.split("-").map(Number);
			return new Date(y, m - 1, d).getTime();
		};
		panelButton(presets, t("dashboard.this_week"), () => this.setPeriod(wkParse(weekStart(todayMs)), todayMs));
		panelButton(presets, t("dashboard.preset_last_week"), () => {
			const start = wkParse(addWeeks(weekStart(todayMs), -1));
			this.setPeriod(start, start + 6 * DAY_MS);
		});
		panelButton(presets, t("dashboard.this_month"), () => this.setPeriod(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), todayMs));
		panelButton(presets, t("dashboard.preset_last_month"), () => {
			this.setPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 0).getTime());
		});
	}

	/** 마감 주의 카드(교사) — 마감 경과/임박 미제출. 기간 무관 "현재" 기준. */
	private renderAlerts(c: HTMLElement, states: AssignmentStateDoc[], members: Array<{ memberId: string; memberName: string }>, nowMs: number): void {
		const { overdue, dueSoon } = computeAlerts(states, members, nowMs);
		if (overdue.length === 0 && dueSoon.length === 0) return;
		const card = c.createDiv({ cls: "covault-cr-card covault-dash-alerts" });
		const head = card.createDiv({ cls: "covault-cr-card-head" });
		setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), "alert-triangle");
		head.createSpan({ cls: "covault-cr-card-title", text: t("dashboard.insight_title") });
		const section = (label: string, list: AssignmentAlert[], cls: string): void => {
			if (list.length === 0) return;
			card.createDiv({ cls: "covault-cr-muted", text: label });
			for (const a of list) {
				const row = card.createDiv({ cls: `covault-dash-alert-row ${cls}` });
				row.createSpan({ cls: "covault-cr-matrix-name", text: `${a.memberName} — ${a.title}` });
				row.createSpan({ cls: "covault-cr-score", text: shortDate(a.dueAt) });
			}
		};
		section(t("dashboard.insight_overdue", { n: overdue.length }), overdue, "is-overdue");
		section(t("dashboard.insight_due_soon", { n: dueSoon.length }), dueSoon, "is-soon");
	}

	private async rebuild(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-cr-modhead" });
		iconButton(head, "arrow-left", t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-cr-modtitle", text: t("dashboard.gradebook") });
		if (this.manager) {
			if (this.viewMode === "cards") {
				const sortBtn = iconButton(head, "arrow-down-up", this.sortLow ? t("dashboard.sort_name") : t("dashboard.sort_low"), () => {
					this.sortLow = !this.sortLow;
					void this.reload();
				});
				if (this.sortLow) sortBtn.addClass("is-active");
			}
			iconButton(head, this.viewMode === "cards" ? "table-2" : "layout-grid", this.viewMode === "cards" ? t("dashboard.view_table") : t("dashboard.view_cards"), () => {
				this.viewMode = this.viewMode === "cards" ? "table" : "cards";
				void this.reload();
			});
		}

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
		this.renderPeriodControls(c);

		const startMs = new Date(`${this.startDate}T00:00`).getTime();
		const endMs = new Date(`${this.endDate}T23:59:59`).getTime();
		const nowMs = Date.now();

		// 공통 데이터(학급 공유) — 응답은 읽음/참여(댓글·질문)로 분리, 비공개 응답(mirror)은 별도 수집
		const notices = await store.listByPrefix<NoticeDoc>(noticePrefix());
		const allResponses = await store.listByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX);
		const reads = allResponses.filter((r) => r.kind === "read");
		const responses = [...allResponses.filter((r) => r.kind === "comment" || r.kind === "question"), ...(await this.host.listPrivateResponses())];
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
			for (const def of this.host.assignmentDefs()) maxByUid.set(def.uid, def.rubric ? rubricMax(def.rubric) : def.points);
			// 구성원당 prefix 조회 1회로 일괄 수집(과제·루틴 N+1 제거).
			states.push(...(await this.host.listAllAssignmentStates()));
			routineStates.push(...(await this.host.listAllRoutineStates()));
		} else {
			members = [{ memberId: this.host.settings.userId, memberName: this.host.settings.displayName || this.host.settings.userId }];
			const my = await this.host.listMyAssignments();
			for (const s of my) maxByUid.set(s.assignmentUid, s.maxPoints);
			states.push(...my);
			for (const r of routines) routineStates.push(...(await this.host.myRoutineDays(r.uid)));
		}

		const input: StatsInput = { startMs, endMs, nowMs, members, notices, reads, states, maxByUid, routines, routineStates, responses };
		const stats = computeStats(input);

		if (members.length === 0) {
			const box = c.createDiv({ cls: "covault-cr-empty" });
			setIcon(box.createSpan(), "table-2");
			box.createDiv({ text: t("dashboard.gradebook_empty") });
			return;
		}

		if (this.manager) this.renderAlerts(c, states, members, nowMs);

		const metrics = this.metrics();
		if (this.manager && this.viewMode === "table") {
			renderGradeTable(c, metrics, stats, {
				sortKey: this.tableSortKey,
				onSort: (key) => {
					this.tableSortKey = key;
					void this.reload();
				},
			});
		} else {
			// 추세 스파크라인: 버킷별 학급 풀링(교사, 버킷 2개 이상일 때만)
			const buckets = this.manager ? splitBuckets(startMs, endMs, nowMs) : [];
			const bucketStats = buckets.length >= 2 ? computeBucketStats(input, buckets) : null;
			const grid = c.createDiv({ cls: "covault-dash-list" });
			for (const metric of metrics) {
				const series = bucketStats && metric.agg ? bucketStats.map((bs) => poolPct(bs, metric.agg!)) : undefined;
				renderMetricCard(grid, metric, stats, {
					manager: this.manager,
					series,
					expanded: this.expanded.has(metric.key),
					onToggleExpand: () => {
						if (this.expanded.has(metric.key)) this.expanded.delete(metric.key);
						else this.expanded.add(metric.key);
						void this.reload();
					},
					sortLow: this.sortLow,
				});
			}
		}

		// CSV 내보내기(교사)
		if (this.manager) {
			const csvBtn = panelButton(c, t("dashboard.export_csv"), async () => {
				await copyWithNotice(buildCsv(metrics, stats), t("dashboard.csv_copied"), t("dashboard.csv_copy_failed"));
			});
			csvBtn.style.marginTop = "10px";
		}
	}

	dispose(): void {
		this.container = null;
	}
}
