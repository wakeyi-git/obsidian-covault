import { Notice, setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { AssignmentStateDoc } from "../../../core/model/types";
import { gradeTotal, rubricMax, displayStatus, gradebookCsv } from "../../../core/classroom/assignments";
import { t } from "../../../i18n";

/** 점수 비율 → 색 등급 클래스(높음/중간/낮음). max 미상이면 색 없음. */
function scoreClass(ratio: number | null): string {
	if (ratio == null) return "";
	if (ratio >= 0.8) return "score-hi";
	if (ratio >= 0.5) return "score-mid";
	return "score-lo";
}

/** 통합 성적부(교사) — 학생 × 과제 점수 매트릭스. */
export class GradebookView {
	private container: HTMLElement | null = null;

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-cr-modhead" });
		iconButton(head, "arrow-left", t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-cr-modtitle", text: t("dashboard.gradebook") });

		const defs = this.host.assignmentDefs();
		const members = this.host.settings.members.filter((m) => m.memberId);
		if (defs.length === 0 || members.length === 0) {
			const box = c.createDiv({ cls: "covault-cr-empty" });
			setIcon(box.createSpan(), "table-2");
			box.createDiv({ text: t("dashboard.gradebook_empty") });
			return;
		}

		// def별 상태 수집: uid → (memberId → state)
		const now = Date.now();
		const stateMap = new Map<string, Map<string, AssignmentStateDoc>>();
		for (const def of defs) {
			const states = await this.host.listAssignmentStates(def.uid);
			stateMap.set(def.uid, new Map(states.map((s) => [s.memberId, s])));
		}

		// CSV 내보내기(클립보드 복사).
		panelButton(head, t("dashboard.export_csv"), async () => {
			const csv = gradebookCsv(
				defs.map((d) => ({ uid: d.uid, title: d.title, rubric: d.rubric, points: d.points })),
				members.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId })),
				stateMap,
			);
			try {
				await navigator.clipboard.writeText(csv);
				new Notice(t("dashboard.csv_copied"));
			} catch {
				new Notice(t("dashboard.csv_copy_failed"));
			}
		});

		const maxOf = (def: (typeof defs)[number]): number | undefined => (def.rubric ? rubricMax(def.rubric) : def.points);
		const scoreOf = (st: AssignmentStateDoc | undefined, def: (typeof defs)[number]): number | null =>
			st?.grade ? st.grade.score ?? gradeTotal(st.grade, def.rubric) : null;

		const wrap = c.createDiv({ cls: "covault-gradebook-wrap" });
		const table = wrap.createEl("table", { cls: "covault-gradebook" });
		const hr = table.createEl("tr");
		hr.createEl("th", { text: t("dashboard.member") });
		for (const def of defs) {
			const max = maxOf(def);
			hr.createEl("th", { text: max != null ? `${def.title} (/${max})` : def.title });
		}
		hr.createEl("th", { cls: "covault-gradebook-avg", text: t("dashboard.average") });

		for (const m of members) {
			const row = table.createEl("tr");
			row.createEl("th", { cls: "covault-gradebook-name", text: m.memberName || m.memberId });
			const pcts: number[] = [];
			for (const def of defs) {
				const st = stateMap.get(def.uid)?.get(m.memberId);
				const td = row.createEl("td");
				const score = scoreOf(st, def);
				if (score != null) {
					const max = maxOf(def);
					const ratio = max != null && max > 0 ? score / max : null;
					if (ratio != null) pcts.push(ratio);
					td.setText(String(score));
					td.addClass("is-graded");
					const cls = scoreClass(ratio);
					if (cls) td.addClass(cls);
				} else if (st) {
					const ds = displayStatus(st, now);
					td.setText(ds === "submitted" || ds === "submitted-late" ? "○" : "·");
					td.setAttr("title", ds);
				} else {
					td.setText("·");
				}
			}
			// 학생 평균(%) — max 알 수 있는 채점 과제 기준.
			const avgTd = row.createEl("td", { cls: "covault-gradebook-avg" });
			if (pcts.length > 0) {
				const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
				avgTd.setText(`${Math.round(avg * 100)}%`);
				const cls = scoreClass(avg);
				if (cls) avgTd.addClass(cls);
			} else {
				avgTd.setText("—");
			}
		}

		// 과제별 평균 행(채점된 점수 기준).
		const foot = table.createEl("tr", { cls: "covault-gradebook-foot" });
		foot.createEl("th", { cls: "covault-gradebook-name", text: t("dashboard.average") });
		const allPcts: number[] = [];
		for (const def of defs) {
			const scores: number[] = [];
			const ratios: number[] = [];
			const max = maxOf(def);
			for (const m of members) {
				const score = scoreOf(stateMap.get(def.uid)?.get(m.memberId), def);
				if (score != null) {
					scores.push(score);
					if (max != null && max > 0) ratios.push(score / max);
				}
			}
			const td = foot.createEl("td");
			if (scores.length > 0) {
				const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
				td.setText(avg.toFixed(1));
				if (ratios.length > 0) {
					const ra = ratios.reduce((a, b) => a + b, 0) / ratios.length;
					allPcts.push(...ratios);
					const cls = scoreClass(ra);
					if (cls) td.addClass(cls);
				}
			} else {
				td.setText("—");
			}
		}
		const overall = foot.createEl("td", { cls: "covault-gradebook-avg" });
		if (allPcts.length > 0) {
			const avg = allPcts.reduce((a, b) => a + b, 0) / allPcts.length;
			overall.setText(`${Math.round(avg * 100)}%`);
			const cls = scoreClass(avg);
			if (cls) overall.addClass(cls);
		} else {
			overall.setText("—");
		}
	}

	dispose(): void {
		this.container = null;
	}
}
