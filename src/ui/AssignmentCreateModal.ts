import { App, Modal, Notice, Platform, Setting, setIcon } from "obsidian";
import { CoVaultSettings } from "../settings/types";
import { RubricCriterion } from "../core/model/types";
import { PathSuggest } from "./PathSuggest";
import { t } from "../i18n";

/** epoch ms → date input 값(YYYY-MM-DD, 로컬). */
function toDateInput(ms: number): string {
	const d = new Date(ms);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

export interface AssignmentInput {
	title: string;
	instructions: string;
	dueAt?: number;
	points?: number;
	privacy: "mirror" | "shared";
	targetMembers: string[];
	templatePath?: string;
	rubric?: RubricCriterion[];
}

/** 과제 생성/편집 모달(교사). 제목·안내·마감·배점·대상·공개범위·템플릿. */
export class AssignmentCreateModal extends Modal {
	private title = "";
	private instructions = "";
	private dueStr = "";
	private pointsStr = "";
	private privacy: "mirror" | "shared" = "mirror";
	private templatePath = "";
	private targets = new Set<string>();
	private criteria: Array<{ title: string; max: string }> = [];
	private editing: boolean;

	constructor(
		app: App,
		private settings: CoVaultSettings,
		private onSubmit: (input: AssignmentInput) => void | Promise<void>,
		initial?: AssignmentInput,
	) {
		super(app);
		this.editing = !!initial;
		if (initial) {
			this.title = initial.title;
			this.instructions = initial.instructions;
			this.dueStr = initial.dueAt ? toDateInput(initial.dueAt) : "";
			this.pointsStr = initial.points != null ? String(initial.points) : "";
			this.privacy = initial.privacy;
			this.templatePath = initial.templatePath ?? "";
			for (const id of initial.targetMembers) this.targets.add(id);
			this.criteria = (initial.rubric ?? []).map((c) => ({ title: c.title, max: String(c.levels?.[0]?.points ?? 0) }));
		} else {
			// 기본 대상 = 프로비저닝된 전원, 템플릿 = 설정 기본값
			for (const m of settings.members) if (m.memberId && m.provisioned) this.targets.add(m.memberId);
			this.templatePath = settings.assignmentTemplate ?? "";
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.editing ? t("dashboard.edit_assignment") : t("dashboard.new_assignment") });

		new Setting(contentEl).setName(t("dashboard.assignment_title")).addText((tx) => {
			tx.setPlaceholder(t("dashboard.assignment_title_placeholder")).setValue(this.title).onChange((v) => (this.title = v));
			// 모바일: 자동 포커스로 키보드가 즉시 올라와 하단 버튼을 가리지 않게 데스크톱에서만 포커스.
			if (!Platform.isMobile) window.setTimeout(() => tx.inputEl.focus(), 0);
		});

		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.assignment_instructions") });
		const ta = contentEl.createEl("textarea", { cls: "covault-feedback-input" });
		ta.rows = 5;
		ta.placeholder = t("dashboard.assignment_instructions_placeholder");
		ta.value = this.instructions;
		ta.oninput = () => (this.instructions = ta.value);

		new Setting(contentEl).setName(t("dashboard.due_date")).addText((tx) => {
			tx.inputEl.type = "date";
			tx.setValue(this.dueStr).onChange((v) => (this.dueStr = v));
		});
		new Setting(contentEl).setName(t("dashboard.points")).addText((tx) => {
			tx.inputEl.type = "number";
			tx.setPlaceholder("100").setValue(this.pointsStr).onChange((v) => (this.pointsStr = v));
		});
		new Setting(contentEl).setName(t("dashboard.privacy")).addDropdown((d) => {
			d.addOption("mirror", t("dashboard.privacy_mirror"));
			d.addOption("shared", t("dashboard.privacy_shared"));
			d.setValue(this.privacy).onChange((v) => (this.privacy = v as "mirror" | "shared"));
		});
		new Setting(contentEl)
			.setName(t("dashboard.template_path"))
			.setDesc(t("dashboard.template_path_desc"))
			.addText((tx) => {
				tx.setPlaceholder(t("dashboard.template_path_placeholder")).setValue(this.templatePath).onChange((v) => (this.templatePath = v));
				new PathSuggest(this.app, tx.inputEl, { extensions: ["md", "excalidraw"] });
			});

		// 루브릭(기준 × 배점)
		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.rubric") });
		const rubricBox = contentEl.createDiv({ cls: "covault-dash-rubric" });
		this.renderRubric(rubricBox);

		// 대상 멤버
		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.targets") });
		const members = this.settings.members.filter((m) => m.memberId && m.provisioned);
		const box = contentEl.createDiv({ cls: "covault-dash-targets" });
		for (const m of members) {
			const row = box.createDiv({ cls: "covault-dash-target" });
			const cb = row.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = this.targets.has(m.memberId);
			cb.onchange = () => (cb.checked ? this.targets.add(m.memberId) : this.targets.delete(m.memberId));
			row.createSpan({ text: m.memberName || m.memberId });
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.editing ? t("common.save") : t("dashboard.create_distribute"))
					.setCta()
					.onClick(async () => {
						const title = this.title.trim();
						if (!title) {
							new Notice(t("dashboard.enter_a_title"));
							return;
						}
						if (this.targets.size === 0) {
							new Notice(t("dashboard.select_targets"));
							return;
						}
						const dueAt = this.dueStr ? new Date(`${this.dueStr}T23:59`).getTime() : undefined;
						const points = this.pointsStr ? Number(this.pointsStr) : undefined;
						this.close();
						await this.onSubmit({
							title,
							instructions: this.instructions.trim(),
							dueAt: Number.isFinite(dueAt) ? dueAt : undefined,
							points: Number.isFinite(points) ? points : undefined,
							privacy: this.privacy,
							targetMembers: [...this.targets],
							templatePath: this.templatePath.trim() || undefined,
							rubric: this.buildRubric(),
						});
					}),
			);
	}

	private renderRubric(box: HTMLElement): void {
		box.empty();
		this.criteria.forEach((cr, i) => {
			const row = box.createDiv({ cls: "covault-dash-rubric-row" });
			const ti = row.createEl("input", { attr: { type: "text", placeholder: t("dashboard.criterion") } });
			ti.value = cr.title;
			ti.oninput = () => (cr.title = ti.value);
			const pi = row.createEl("input", { cls: "covault-dash-rubric-pts", attr: { type: "number", placeholder: t("dashboard.max") } });
			pi.value = cr.max;
			pi.oninput = () => (cr.max = pi.value);
			const del = row.createEl("button", { cls: "clickable-icon covault-icon-danger" });
			setIcon(del, "x");
			del.setAttr("aria-label", t("common.delete"));
			del.onclick = () => {
				this.criteria.splice(i, 1);
				this.renderRubric(box);
			};
		});
		const add = box.createEl("button", { text: t("dashboard.add_criterion") });
		add.onclick = () => {
			this.criteria.push({ title: "", max: "" });
			this.renderRubric(box);
		};
	}

	private buildRubric(): RubricCriterion[] {
		return this.criteria
			.filter((c) => c.title.trim())
			.map((c, i) => ({ id: `r${i}`, title: c.title.trim(), levels: [{ label: "", points: Number(c.max) || 0 }] }));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
