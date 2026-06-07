import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { AssignmentDoc, AssignmentStateDoc } from "../../../core/model/types";
import { buildMatrix, statusCounts, displayStatus, gradeTotal, rubricMax, AssignmentDisplayStatus, MatrixRow } from "../../../core/classroom/assignments";
import { AssignmentCreateModal } from "../../AssignmentCreateModal";
import { GradingModal } from "../../GradingModal";
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

/** 상태 → 배지 변형(색)·아이콘 매핑. */
function statusVariant(s: AssignmentDisplayStatus): string {
	switch (s) {
		case "returned":
			return "is-ok";
		case "submitted":
			return "is-accent";
		case "overdue":
		case "submitted-late":
			return "is-warn";
		default:
			return "";
	}
}
function statusIcon(s: AssignmentDisplayStatus): string {
	switch (s) {
		case "returned":
			return "check-check";
		case "submitted":
		case "submitted-late":
			return "check";
		case "overdue":
			return "alarm-clock";
		default:
			return "circle-dashed";
	}
}

/** 과제 모듈 — 교사: 정의 목록 + 생성 + 제출 현황 매트릭스 / 학생: 내 과제 + 제출. */
export class AssignmentsView {
	private container: HTMLElement | null = null;
	private limit = 0;

	constructor(private host: PanelHost, private onBack: () => void) {}

	/** 목록에 페이지 크기를 적용하고 "더 보기" 버튼을 단다. 표시할 항목 배열 반환. */
	private paginate<T>(items: T[], moreParent: HTMLElement): T[] {
		const pageSize = this.host.settings.dashboardPageSize ?? 10;
		if (!this.limit) this.limit = pageSize;
		const shown = items.slice(0, this.limit);
		if (items.length > shown.length) {
			const remaining = items.length - shown.length;
			panelButton(moreParent, t("dashboard.show_more", { n: Math.min(pageSize, remaining) }), () => {
				this.limit += pageSize;
				void this.reload();
			});
		}
		return shown;
	}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	private statusBadge(parent: HTMLElement, status: AssignmentDisplayStatus): void {
		const b = parent.createSpan({ cls: `covault-cr-badge ${statusVariant(status)}`.trim() });
		setIcon(b.createSpan(), statusIcon(status));
		b.createSpan({ text: statusLabel(status) });
	}

	private empty(parent: HTMLElement, text: string, icon = "clipboard-list"): void {
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
		head.createSpan({ cls: "covault-cr-modtitle", text: t("dashboard.assignments") });
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
			this.empty(c, t("dashboard.no_assignments"));
			return;
		}
		const members = this.host.settings.members
			.filter((m) => m.memberId)
			.map((m) => ({ memberId: m.memberId, memberName: m.memberName || m.memberId }));
		const now = Date.now();
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const def of this.paginate(defs.slice().reverse(), c)) {
			const states = await this.host.listAssignmentStates(def.uid);
			const rows = buildMatrix(def, members, states, now);
			const counts = statusCounts(rows);
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: def.title });
			if (def.dueAt) top.createSpan({ cls: "covault-feedback-time", text: formatDate(new Date(def.dueAt)) });

			// 제출 진행률(제출+지각+반환 / 전체)
			const submitted = counts.submitted + counts["submitted-late"] + counts.returned;
			const total = rows.length;
			const prow = card.createDiv({ cls: "covault-cr-cardrow" });
			prow.createSpan({ cls: "covault-cr-muted", text: t("dashboard.submit_summary", { submitted, total }) });
			const prog = prow.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = total > 0 ? `${Math.round((submitted / total) * 100)}%` : "0%";

			const matrix = card.createDiv({ cls: "covault-cr-matrix" });
			for (const r of rows) {
				const line = matrix.createDiv({ cls: "covault-cr-matrix-row" });
				line.createSpan({ cls: "covault-cr-matrix-name", text: r.memberName });
				this.statusBadge(line, r.status);
				if (r.state?.grade) {
					const gtotal = gradeTotal(r.state.grade, def.rubric);
					const max = def.rubric ? rubricMax(def.rubric) : def.points;
					line.createSpan({ cls: "covault-cr-score", text: max != null ? `${gtotal}/${max}` : String(gtotal) });
				}
				const full = this.teacherWorkPath(def, r);
				if (full) iconButton(line, "square-arrow-out-up-right", t("dashboard.open"), () => this.host.openVaultPath(full));
				if (r.state) iconButton(line, "pencil", t("dashboard.grade"), () => this.openGrading(def, r, full));
			}
		}
	}

	/** 교사 측 작업 파일 경로(개인=member.localRoot 접두, 공유=그대로). 없으면 null. */
	private teacherWorkPath(def: AssignmentDoc, r: MatrixRow): string | null {
		const wp = r.state?.workPaths?.[0];
		if (!wp) return null;
		if (def.privacy === "shared") return wp;
		const member = this.host.settings.members.find((m) => m.memberId === r.memberId);
		return member ? `${member.localRoot}/${wp}` : wp;
	}

	private openGrading(def: AssignmentDoc, r: MatrixRow, openPath: string | null): void {
		new GradingModal(this.host.app, {
			title: def.title,
			memberName: r.memberName,
			openPath,
			rubric: def.rubric,
			points: def.points,
			initial: r.state?.grade,
			onOpenWork: (p) => this.host.openVaultPath(p),
			onReturn: async (grade) => {
				grade.score = gradeTotal(grade, def.rubric); // 학생이 단일 총점으로 보도록 저장
				await this.host.returnAssignment(def.uid, r.memberId, grade);
				await this.reload();
			},
		}).open();
	}

	// --- 학생: 내 과제 + 제출 ---
	private async renderMember(c: HTMLElement): Promise<void> {
		const states = (await this.host.listMyAssignments()).sort((a, b) => b.assignedAtMs - a.assignedAtMs);
		if (states.length === 0) {
			this.empty(c, t("dashboard.no_assignments_member"));
			return;
		}
		const now = Date.now();
		const list = c.createDiv({ cls: "covault-dash-list" });
		for (const st of this.paginate(states, c)) {
			const status = displayStatus(st, now);
			const card = list.createDiv({ cls: "covault-cr-card" });
			const top = card.createDiv({ cls: "covault-cr-card-head" });
			top.createSpan({ cls: "covault-cr-card-title", text: st.title });
			this.statusBadge(top, status);
			if (st.dueAt) card.createDiv({ cls: "covault-cr-muted", text: t("dashboard.due", { date: formatDate(new Date(st.dueAt)) }) });

			// 반환된 과제: 성적 + 총평 표시.
			if (st.state === "returned" && st.grade) {
				const score = st.grade.score ?? (st.grade.rubricScores ? Object.values(st.grade.rubricScores).reduce((a, b) => a + b, 0) : 0);
				const grow = card.createDiv({ cls: "covault-cr-cardrow" });
				const gb = grow.createSpan({ cls: "covault-cr-badge is-ok" });
				setIcon(gb.createSpan(), "award");
				gb.createSpan({ text: t("dashboard.your_score", { score }) });
				if (st.grade.comment) card.createDiv({ cls: "covault-cr-card-desc", text: st.grade.comment });
			}

			const actions = card.createDiv({ cls: "covault-dash-actions" });
			const wp = st.workPaths?.[0];
			if (wp) panelButton(actions, t("dashboard.open"), () => this.host.openVaultPath(wp));
			if (st.state === "returned") {
				// 반환됨 — 제출 버튼 없음(성적은 위에 표시).
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
