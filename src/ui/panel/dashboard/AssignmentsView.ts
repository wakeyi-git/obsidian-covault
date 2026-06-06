import { PanelHost, panelButton } from "../PanelSection";
import { AssignmentDoc, AssignmentStateDoc } from "../../../core/model/types";
import { buildMatrix, statusCounts, displayStatus, AssignmentDisplayStatus } from "../../../core/classroom/assignments";
import { AssignmentCreateModal } from "../../AssignmentCreateModal";
import { t, formatDate } from "../../../i18n";

function statusLabel(s: AssignmentDisplayStatus): string {
	switch (s) {
		case "assigned":
			return t("dashboard.status_assigned");
		case "overdue":
			return t("dashboard.status_overdue");
		case "submitted":
			return t("dashboard.status_submitted");
		case "submitted-late":
			return t("dashboard.status_submitted_late");
		case "returned":
			return t("dashboard.status_returned");
	}
}

/** 과제 모듈 — 교사: 정의 목록 + 생성 + 제출 현황 매트릭스 / 학생: 내 과제 + 제출. */
export class AssignmentsView {
	private container: HTMLElement | null = null;

	constructor(private host: PanelHost, private onBack: () => void) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private async reload(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const head = c.createDiv({ cls: "covault-dash-modhead" });
		panelButton(head, t("dashboard.back"), () => this.onBack());
		head.createSpan({ cls: "covault-dash-modtitle", text: t("dashboard.assignments") });
		if (this.manager) {
			panelButton(
				head,
				t("dashboard.new_assignment"),
				() =>
					new AssignmentCreateModal(this.host.app, this.host.settings, async (input) => {
						const ok = await this.host.createAssignment(input);
						if (ok) await this.reload();
					}).open(),
				{ cta: true },
			);
		}

		if (this.manager) await this.renderManager(c);
		else await this.renderMember(c);
	}

	// --- 교사: 정의별 제출 매트릭스 ---
	private async renderManager(c: HTMLElement): Promise<void> {
		const defs = this.host.assignmentDefs();
		if (defs.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.no_assignments") });
			return;
		}
		const members = this.host.settings.members
			.filter((m) => m.memberId)
			.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
		const now = Date.now();
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const def of defs.slice().reverse()) {
			const states = await this.host.listAssignmentStates(def.uid);
			const rows = buildMatrix(def, members, states, now);
			const counts = statusCounts(rows);
			const card = list.createDiv({ cls: "covault-dash-card" });
			const top = card.createDiv({ cls: "covault-dash-card-row" });
			top.createSpan({ cls: "covault-dash-card-title", text: def.title });
			if (def.dueAt) top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(def.dueAt)) });
			card.createDiv({
				cls: "covault-dash-card-desc",
				text: t("dashboard.submit_summary", {
					submitted: counts.submitted + counts["submitted-late"] + counts.returned,
					total: rows.length,
				}),
			});
			for (const r of rows) {
				const line = card.createDiv({ cls: "covault-dash-matrix-row" });
				line.createSpan({ cls: "covault-dash-matrix-name", text: r.memberName });
				line.createSpan({ cls: `covault-dash-status is-${r.status}`, text: statusLabel(r.status) });
				const wp = r.state?.workPaths?.[0];
				if (wp) {
					const member = this.host.settings.members.find((m) => m.memberId === r.memberId);
					const full = def.privacy === "shared" || !member ? wp : `${member.localRoot}/${wp}`;
					panelButton(line, t("dashboard.open"), () => this.host.openVaultPath(full));
				}
			}
		}
	}

	// --- 학생: 내 과제 + 제출 ---
	private async renderMember(c: HTMLElement): Promise<void> {
		const states = (await this.host.listMyAssignments()).sort((a, b) => b.assignedAtMs - a.assignedAtMs);
		if (states.length === 0) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.no_assignments_member") });
			return;
		}
		const now = Date.now();
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const st of states) {
			const status = displayStatus(st, now);
			const card = list.createDiv({ cls: "covault-dash-card" });
			const top = card.createDiv({ cls: "covault-dash-card-row" });
			top.createSpan({ cls: "covault-dash-card-title", text: st.title });
			top.createSpan({ cls: `covault-dash-status is-${status}`, text: statusLabel(status) });
			if (st.dueAt) card.createDiv({ cls: "covault-dash-card-desc", text: t("dashboard.due", { date: formatDate(new Date(st.dueAt)) }) });
			const actions = card.createDiv({ cls: "covault-dash-actions" });
			const wp = st.workPaths?.[0];
			if (wp) panelButton(actions, t("dashboard.open"), () => this.host.openVaultPath(wp));
			if (st.state === "returned") {
				// 반환됨(채점은 Phase 3) — 제출 버튼 없음.
			} else if (st.state === "submitted") {
				panelButton(actions, t("dashboard.unsubmit"), async () => {
					await this.host.unsubmitAssignment(st);
					await this.reload();
				});
			} else {
				panelButton(actions, t("dashboard.submit"), async () => {
					await this.host.submitAssignment(st);
					await this.reload();
				}, { cta: true });
			}
		}
	}

	dispose(): void {
		this.container = null;
	}
}
