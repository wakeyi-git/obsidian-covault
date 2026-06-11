import { setIcon } from "obsidian";
import { PanelHost, panelButton, iconButton } from "../PanelSection";
import { AssignmentDoc, AssignmentStateDoc } from "../../../core/model/types";
import { buildMatrix, statusCounts, displayStatus, gradeTotal, rubricMax, defTab, stateTab, AssignmentDisplayStatus, AssignmentTab, MatrixRow } from "../../../core/classroom/assignments";
import { AssignmentCreateModal, AssignmentInput } from "../../AssignmentCreateModal";
import { GradingModal } from "../../GradingModal";
import { ConfirmModal } from "../../ConfirmModal";
import { captureScroll } from "../scroll";
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
	private tab: AssignmentTab = "active";
	/** 명단을 펼쳐 둔 과제 uid — 채점·반환 후 reload에도 펼침 유지. */
	private openUids = new Set<string>();

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

	/** 재렌더 + 스크롤 위치 보존(입력·버튼 후 최상단으로 튀지 않게). */
	private async reload(): Promise<void> {
		const restore = captureScroll(this.container);
		await this.rebuild();
		restore();
	}

	private async rebuild(): Promise<void> {
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

		this.renderTabBar(c);
		if (this.manager) await this.renderManager(c);
		else await this.renderMember(c);
	}

	/** 진행 중/완료 필터 탭 — 전환 시 페이지네이션 limit 리셋. */
	private renderTabBar(c: HTMLElement): void {
		const bar = c.createDiv({ cls: "covault-dash-subtabs" });
		const tabs: Array<{ tab: AssignmentTab; icon: string; label: string }> = [
			{ tab: "active", icon: "circle-dashed", label: t("dashboard.tab_active") },
			{ tab: "done", icon: "check-check", label: t("dashboard.tab_done") },
		];
		for (const d of tabs) {
			const b = bar.createEl("button", { cls: `covault-dash-subtab${d.tab === this.tab ? " is-active" : ""}` });
			setIcon(b.createSpan({ cls: "covault-dash-subtab-icon" }), d.icon);
			b.createSpan({ text: d.label });
			b.onclick = () => {
				if (this.tab === d.tab) return;
				this.tab = d.tab;
				this.limit = 0;
				void this.reload();
			};
		}
	}

	// --- 교사: 정의별 제출 매트릭스 ---
	private async renderManager(c: HTMLElement): Promise<void> {
		const defs = this.host.assignmentDefs().filter((d) => defTab(d) === this.tab);
		if (defs.length === 0) {
			this.empty(c, this.tab === "done" ? t("dashboard.no_assignments_done") : t("dashboard.no_assignments"));
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
			// 제목(위) + 마감일(아래)을 세로로 쌓고, 편집/삭제는 오른쪽에.
			const titles = top.createDiv({ cls: "covault-cr-card-titles" });
			titles.createSpan({ cls: "covault-cr-card-title", text: def.title });
			if (def.dueAt) titles.createSpan({ cls: "covault-cr-card-due", text: t("dashboard.due", { date: formatDate(new Date(def.dueAt)) }) });
			iconButton(top, "pencil", t("common.edit"), () => this.editAssignment(def));
			const archived = def.archivedAtMs != null;
			iconButton(top, archived ? "archive-restore" : "archive", archived ? t("dashboard.unarchive") : t("dashboard.archive"), async () => {
				await this.host.archiveAssignment(def.uid, !archived);
				await this.reload();
			});
			iconButton(top, "trash-2", t("common.delete"), () => this.confirmDelete(def));

			// 제출 진행률(제출+지각+반환 / 전체) — 행 클릭으로 명단 펼침/접힘(기본 접힘)
			const submitted = counts.submitted + counts["submitted-late"] + counts.returned;
			const total = rows.length;
			const prow = card.createDiv({ cls: "covault-cr-cardrow is-clickable" });
			prow.createSpan({ cls: "covault-cr-muted", text: t("dashboard.submit_summary", { submitted, total }) });
			const prog = prow.createDiv({ cls: "covault-cr-progress" });
			prog.createEl("i").style.width = total > 0 ? `${Math.round((submitted / total) * 100)}%` : "0%";
			const chev = prow.createSpan({ cls: "covault-cr-rowchev" });

			const matrix = card.createDiv({ cls: "covault-cr-matrix" });
			const setOpen = (open: boolean): void => {
				matrix.style.display = open ? "" : "none";
				setIcon(chev, open ? "chevron-down" : "chevron-right");
			};
			setOpen(this.openUids.has(def.uid));
			prow.onclick = () => {
				const open = !this.openUids.has(def.uid);
				if (open) this.openUids.add(def.uid);
				else this.openUids.delete(def.uid);
				setOpen(open);
			};
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

	/** 과제 편집(교사) — 정의를 모달에 채워 열고, 저장 시 재배포(제출/성적 보존). */
	private editAssignment(def: AssignmentDoc): void {
		const initial: AssignmentInput = {
			title: def.title,
			instructions: def.instructions,
			dueAt: def.dueAt,
			points: def.points,
			privacy: def.privacy,
			targetMembers: [...def.targetMembers],
			templatePath: def.templatePaths[0],
			rubric: def.rubric,
		};
		new AssignmentCreateModal(this.host.app, this.host.settings, async (input) => {
			const ok = await this.host.updateAssignment(def.uid, input);
			if (ok) await this.reload();
		}, initial).open();
	}

	/** 과제 삭제 확인(교사). 학생 상태 문서가 사라지고 작업 파일은 남는다. */
	private confirmDelete(def: AssignmentDoc): void {
		new ConfirmModal(this.host.app, {
			title: t("dashboard.delete_assignment_title", { title: def.title }),
			message: t("dashboard.delete_assignment_msg"),
			warning: true,
			onConfirm: async () => {
				const ok = await this.host.deleteAssignment(def.uid);
				if (ok) await this.reload();
			},
		}).open();
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
		const states = (await this.host.listMyAssignments())
			.filter((s) => stateTab(s) === this.tab)
			.sort((a, b) => b.assignedAtMs - a.assignedAtMs);
		if (states.length === 0) {
			this.empty(c, this.tab === "done" ? t("dashboard.no_assignments_done_member") : t("dashboard.no_assignments_member"));
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
