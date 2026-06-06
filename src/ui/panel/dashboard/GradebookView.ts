import { PanelHost, panelButton } from "../PanelSection";
import { AssignmentStateDoc } from "../../../core/model/types";
import { gradeTotal, rubricMax, displayStatus } from "../../../core/classroom/assignments";
import { t } from "../../../i18n";

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

		const head = c.createDiv({ cls: "covault-dash-modhead" });
		panelButton(head, t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-dash-modtitle", text: t("dashboard.gradebook") });

		const defs = this.host.assignmentDefs();
		const members = this.host.settings.members.filter((m) => m.memberId);
		if (defs.length === 0 || members.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.gradebook_empty") });
			return;
		}

		// def별 상태 수집: uid → (memberId → state)
		const now = Date.now();
		const stateMap = new Map<string, Map<string, AssignmentStateDoc>>();
		for (const def of defs) {
			const states = await this.host.listAssignmentStates(def.uid);
			stateMap.set(def.uid, new Map(states.map((s) => [s.memberId, s])));
		}

		const wrap = c.createDiv({ cls: "covault-gradebook-wrap" });
		const table = wrap.createEl("table", { cls: "covault-gradebook" });
		const hr = table.createEl("tr");
		hr.createEl("th", { text: t("dashboard.member") });
		for (const def of defs) {
			const max = def.rubric ? rubricMax(def.rubric) : def.points;
			hr.createEl("th", { text: max != null ? `${def.title} (/${max})` : def.title });
		}
		for (const m of members) {
			const row = table.createEl("tr");
			row.createEl("th", { cls: "covault-gradebook-name", text: m.memberName || m.memberId });
			for (const def of defs) {
				const st = stateMap.get(def.uid)?.get(m.memberId);
				const td = row.createEl("td");
				if (st?.grade) {
					td.setText(String(st.grade.score ?? gradeTotal(st.grade, def.rubric)));
					td.addClass("is-graded");
				} else if (st) {
					const ds = displayStatus(st, now);
					td.setText(ds === "submitted" || ds === "submitted-late" ? "○" : "·");
					td.setAttr("title", ds);
				} else {
					td.setText("·");
				}
			}
		}
	}

	dispose(): void {
		this.container = null;
	}
}
