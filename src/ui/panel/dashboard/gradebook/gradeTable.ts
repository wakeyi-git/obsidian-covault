import { MemberStats } from "../../../../core/classroom/stats";
import { poolPct } from "../../../../core/classroom/statsSeries";
import { Metric, LOW_THRESHOLD, fmtMetric, byValueAsc } from "./metricCard";
import { t } from "../../../../i18n";

export interface GradeTableOpts {
	/** 정렬 기준 지표 key. null이면 입력 순서(명부 순). */
	sortKey: string | null;
	onSort: (key: string | null) => void;
}

/** 표 뷰(교사) — 행=구성원, 열=지표, 헤더 클릭 정렬, 마지막 행=전체 평균(풀링). */
export function renderGradeTable(parent: HTMLElement, metrics: Metric[], stats: MemberStats[], opts: GradeTableOpts): void {
	const wrap = parent.createDiv({ cls: "covault-dash-tablewrap" });
	const table = wrap.createEl("table", { cls: "covault-dash-gradetable" });

	const hr = table.createEl("thead").createEl("tr");
	const nameTh = hr.createEl("th", { text: t("dashboard.member") });
	if (opts.sortKey == null) nameTh.addClass("is-sorted");
	nameTh.onclick = () => opts.onSort(null);
	for (const m of metrics) {
		const th = hr.createEl("th", { text: m.label });
		if (m.hint) th.setAttr("title", m.hint);
		if (opts.sortKey === m.key) th.addClass("is-sorted");
		th.onclick = () => opts.onSort(m.key);
	}

	const rows = [...stats];
	const sortMetric = metrics.find((m) => m.key === opts.sortKey);
	if (sortMetric) rows.sort(byValueAsc(sortMetric));

	const tbody = table.createEl("tbody");
	for (const s of rows) {
		const tr = tbody.createEl("tr");
		tr.createEl("td", { text: s.memberName, cls: "covault-dash-gradetable-name" });
		for (const m of metrics) {
			const v = m.get(s);
			const td = tr.createEl("td", { text: fmtMetric(m, v) });
			if (!m.fmt && v != null && v < LOW_THRESHOLD) td.addClass("is-low");
		}
	}

	if (stats.length > 1) {
		const fr = table.createEl("tfoot").createEl("tr");
		fr.createEl("td", { text: t("dashboard.class_average_label"), cls: "covault-dash-gradetable-name" });
		for (const m of metrics) {
			const pct = m.agg ? poolPct(stats, m.agg) : null;
			fr.createEl("td", { text: pct == null ? "—" : `${pct}%` });
		}
	}
}

/** 성적부 CSV — 구성원 행 + 전체 평균 행(풀링 가능한 지표만). */
export function buildCsv(metrics: Metric[], stats: MemberStats[]): string {
	const header = [t("dashboard.member"), ...metrics.map((m) => m.label)].join(",");
	const rows = stats.map((s) =>
		[s.memberName, ...metrics.map((m) => {
			const v = m.get(s);
			return v == null ? "" : String(v);
		})].join(","),
	);
	const avg = [t("dashboard.class_average_label"), ...metrics.map((m) => {
		const pct = m.agg ? poolPct(stats, m.agg) : null;
		return pct == null ? "" : String(pct);
	})].join(",");
	return [header, ...rows, avg].join("\n");
}
