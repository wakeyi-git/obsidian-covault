import { setIcon } from "obsidian";
import { MemberStats, Rate } from "../../../../core/classroom/stats";
import { renderSparkline } from "./sparkline";
import { t } from "../../../../i18n";

/** 이 값(%) 미만이면 주의 표시. */
export const LOW_THRESHOLD = 60;

export interface Metric {
	key: string;
	label: string;
	icon: string;
	/** 표시값 — % 지표는 0~100, fmt 지표는 원시값. 측정 불가 시 null. */
	get: (s: MemberStats) => number | null;
	/** 학급 평균(풀링: Σ분자/Σ분모)·스파크라인용. 없으면 평균·추세 생략. */
	agg?: (s: MemberStats) => Rate;
	/** % 아닌 지표의 값 포맷 — 지정 시 막대 없이 값만 표시. */
	fmt?: (v: number) => string;
	managerOnly?: boolean;
	/** 산출 기준 설명(제목 툴팁). */
	hint?: string;
	/** 미달 명단 펼치기 제외(평균 점수처럼 num<den이 미달을 뜻하지 않는 지표). */
	noBehind?: boolean;
}

/** 지표 표시값 포맷 — null이면 "—". */
export function fmtMetric(metric: Metric, v: number | null): string {
	return v == null ? "—" : metric.fmt ? metric.fmt(v) : `${v}%`;
}

/** 낮은 값 우선(null 마지막) 정렬 비교자. */
export function byValueAsc(metric: Metric): (a: MemberStats, b: MemberStats) => number {
	return (a, b) => {
		const va = metric.get(a);
		const vb = metric.get(b);
		if (va == null && vb == null) return 0;
		if (va == null) return 1;
		if (vb == null) return -1;
		return va - vb;
	};
}

export interface MetricCardOpts {
	manager: boolean;
	/** 학급 평균 시계열(교사 카드 헤드 스파크라인). */
	series?: Array<number | null>;
	/** 미달 명단 펼침 여부 + 토글(교사). */
	expanded: boolean;
	onToggleExpand?: () => void;
	/** true면 낮은 값 순 정렬(null 마지막), false면 입력 순서. */
	sortLow: boolean;
}

/** 지표 카드 1장 — 학생=본인 값, 교사=구성원 행렬+학급 평균+추세+미달 명단. */
export function renderMetricCard(parent: HTMLElement, metric: Metric, stats: MemberStats[], opts: MetricCardOpts): void {
	const card = parent.createDiv({ cls: "covault-cr-card" });
	const head = card.createDiv({ cls: "covault-cr-card-head" });
	setIcon(head.createSpan({ cls: "covault-cr-card-icon" }), metric.icon);
	const title = head.createSpan({ cls: "covault-cr-card-title", text: metric.label });
	if (metric.hint) title.setAttr("title", metric.hint);

	// 학생: 본인 값 + 막대(% 지표만)
	if (!opts.manager) {
		const s = stats[0];
		const v = s ? metric.get(s) : null;
		const score = head.createSpan({ cls: "covault-cr-score", text: fmtMetric(metric, v) });
		score.style.marginLeft = "auto";
		if (!metric.fmt) {
			const prog = card.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = `${v ?? 0}%`;
		}
		return;
	}

	// 교사 헤드 도구: 추세 스파크라인 + 미달 명단 토글
	const tools = head.createDiv({ cls: "covault-dash-cardtools" });
	if (opts.series && opts.series.some((v) => v != null)) renderSparkline(tools, opts.series, metric.label);
	const behind = !metric.noBehind && metric.agg
		? stats.filter((s) => {
				const r = metric.agg!(s);
				return r.den > 0 && r.num < r.den;
			})
		: [];
	if (behind.length > 0 && opts.onToggleExpand) {
		const chev = tools.createSpan({ cls: "covault-cr-iconbtn clickable-icon" });
		setIcon(chev, opts.expanded ? "chevron-up" : "chevron-down");
		chev.setAttr("aria-label", t("dashboard.members_behind"));
		chev.onclick = () => opts.onToggleExpand!();
	}

	const rows = [...stats];
	if (opts.sortLow) rows.sort(byValueAsc(metric));

	const matrix = card.createDiv({ cls: "covault-cr-matrix" });
	let aggNum = 0;
	let aggDen = 0;
	for (const s of rows) {
		const v = metric.get(s);
		if (metric.agg) {
			const a = metric.agg(s);
			aggNum += a.num;
			aggDen += a.den;
		}
		const row = matrix.createDiv({ cls: "covault-cr-matrix-row" });
		if (!metric.fmt && v != null && v < LOW_THRESHOLD) row.addClass("is-low");
		row.createSpan({ cls: "covault-cr-matrix-name", text: s.memberName });
		if (!metric.fmt) {
			const prog = row.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = `${v ?? 0}%`;
		}
		row.createSpan({ cls: "covault-cr-score", text: fmtMetric(metric, v) });
	}

	// 학급 평균(2명 이상) — 풀링: Σ분자/Σ분모
	if (stats.length > 1 && metric.agg && aggDen > 0) {
		card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.class_average", { pct: Math.round((aggNum / aggDen) * 100) }) });
	}

	// 미달 명단(펼침) — 이름 + 부족 건수
	if (opts.expanded && behind.length > 0 && metric.agg) {
		const list = card.createDiv({ cls: "covault-dash-behind" });
		list.createDiv({ cls: "covault-cr-muted", text: t("dashboard.members_behind") });
		for (const s of behind) {
			const r = metric.agg(s);
			list.createDiv({ cls: "covault-dash-behind-row", text: `${s.memberName} — ${t("dashboard.sum_count", { n: r.den - r.num })}` });
		}
	}
}
