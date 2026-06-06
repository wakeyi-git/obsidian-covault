import { App, Modal, Setting } from "obsidian";
import { AssignmentGrade, RubricCriterion } from "../core/model/types";
import { criterionMax, rubricMax } from "../core/classroom/assignments";
import { t } from "../i18n";

export interface GradingOptions {
	title: string;
	memberName: string;
	openPath: string | null;
	rubric?: RubricCriterion[];
	points?: number;
	initial?: AssignmentGrade;
	onOpenWork: (path: string) => void | Promise<void>;
	onReturn: (grade: AssignmentGrade) => void | Promise<void>;
}

/** 채점 모달(교사): 점수 또는 루브릭 + 총평 → 반환. 인라인 피드백은 제출물에서 기존 피드백 기능 사용. */
export class GradingModal extends Modal {
	private scores: Record<string, number> = {};
	private score = "";
	private comment = "";

	constructor(app: App, private opts: GradingOptions) {
		super(app);
		this.scores = { ...(opts.initial?.rubricScores ?? {}) };
		this.score = opts.initial?.score != null ? String(opts.initial.score) : "";
		this.comment = opts.initial?.comment ?? "";
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		contentEl.createEl("h3", { text: t("dashboard.grade_title", { name: opts.memberName }) });
		contentEl.createDiv({ cls: "covault-dash-card-desc", text: opts.title });

		if (opts.openPath) {
			new Setting(contentEl).setName(t("dashboard.submission")).addButton((b) =>
				b.setButtonText(t("dashboard.open")).onClick(() => opts.onOpenWork(opts.openPath!)),
			);
			contentEl.createDiv({ cls: "covault-dash-card-desc", text: t("dashboard.inline_feedback_hint") });
		}

		if (opts.rubric && opts.rubric.length > 0) {
			contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.rubric") });
			for (const c of opts.rubric) {
				const max = criterionMax(c);
				new Setting(contentEl).setName(c.title).setDesc(t("dashboard.max_points", { max })).addText((tx) => {
					tx.inputEl.type = "number";
					tx.setValue(this.scores[c.id] != null ? String(this.scores[c.id]) : "");
					tx.onChange((v) => {
						const n = Math.max(0, Math.min(max, Number(v) || 0));
						this.scores[c.id] = n;
					});
				});
			}
			contentEl.createDiv({ cls: "covault-dash-card-desc", text: t("dashboard.rubric_total", { max: rubricMax(opts.rubric) }) });
		} else {
			new Setting(contentEl)
				.setName(t("dashboard.score"))
				.setDesc(opts.points != null ? t("dashboard.out_of", { max: opts.points }) : "")
				.addText((tx) => {
					tx.inputEl.type = "number";
					tx.setValue(this.score).onChange((v) => (this.score = v));
				});
		}

		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.overall_comment") });
		const ta = contentEl.createEl("textarea", { cls: "covault-feedback-input" });
		ta.rows = 4;
		ta.value = this.comment;
		ta.oninput = () => (this.comment = ta.value);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("dashboard.return_grade"))
					.setCta()
					.onClick(async () => {
						const grade: AssignmentGrade = { comment: this.comment.trim() || undefined };
						if (opts.rubric && opts.rubric.length > 0) grade.rubricScores = { ...this.scores };
						else if (this.score.trim()) grade.score = Number(this.score) || 0;
						this.close();
						await opts.onReturn(grade);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
