import { Notice, Setting, TFile, TFolder } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { ExistingPolicy, CopyResult, CopyPlan } from "../../modes/manager/BulkCopy";
import { PathSuggest } from "../PathSuggest";
import { captureScroll } from "./scroll";
import { t } from "../../i18n";

/** 배포 탭(교사) — 경로 선택 복사(현재 파일/폴더 빠른 입력) + 공유 공간 배포. 기술문서 §20. */
export class DeploySection implements PanelSection {
	private container: HTMLElement | null = null;
	private sourcePath = "";
	private destPath = "";
	private policy: ExistingPolicy = "skip";
	private substitute = true;
	private selected = new Set<string>();
	private infoEl: HTMLElement | null = null;
	private lastPlan: CopyPlan | null = null;
	private lastResult: (CopyResult & { error?: string }) | null = null;

	constructor(private host: PanelHost) {
		for (const st of host.settings.members) if (st.memberId) this.selected.add(st.memberId);
	}

	render(container: HTMLElement): void {
		this.container = container;
		// 버튼 클릭으로 전체 재렌더 시 스크롤이 최상단으로 튀지 않도록 위치 보존.
		const restore = captureScroll(container);
		container.empty();
		container.addClass("covault-panel-section");

		this.renderCopy(container);
		this.renderShared(container);
		restore();
	}

	dispose(): void {
		this.container = null;
		this.infoEl = null;
	}

	// --- 학생에게 복사 ---

	private renderCopy(container: HTMLElement): void {
		// 상단 제목 없음 — 탭 바가 이미 위치를 알려준다(실행 버튼에 같은 문구가 있다).
		const members = this.host.settings.members.filter((st) => st.memberId);
		if (members.length === 0) {
			container.createDiv({ cls: "covault-feedback-empty", text: t("deploy.add_members_in_settings_first") });
			return;
		}

		new Setting(container)
			.setName(t("deploy.source_path"))
			.setDesc(t("deploy.path_of_the_file_or_folder"))
			.addText((txt) => {
				txt
					.setPlaceholder(t("deploy.e_g_templates_today_md"))
					.setValue(this.sourcePath)
					.onChange((v) => {
						this.sourcePath = v.trim();
						this.updateInfo();
					});
				new PathSuggest(this.host.app, txt.inputEl, { files: true, folders: true });
			});

		const quick = container.createDiv({ cls: "covault-panel-actions" });
		panelButton(quick, t("deploy.current_file"), () => this.fillCurrent("file"));
		panelButton(quick, t("deploy.current_folder"), () => this.fillCurrent("folder"));

		this.infoEl = container.createDiv({ cls: "covault-panel-hint" });
		this.updateInfo();

		const srcFile = this.host.app.vault.getAbstractFileByPath(this.sourcePath);
		new Setting(container)
			.setName(t("deploy.target_path_empty_source_name"))
			.setDesc(t("deploy.path_inside_each_member_s_folder"))
			.addText((txt) =>
				txt
					.setPlaceholder(srcFile instanceof TFile ? srcFile.name : t("deploy.today_md"))
					.setValue(this.destPath)
					.onChange((v) => (this.destPath = v.trim())),
			);

		new Setting(container).setName(t("deploy.existing_file_handling")).addDropdown((dd) =>
			dd
				.addOption("skip", t("deploy.skip_2"))
				.addOption("overwrite", t("deploy.overwrite_2"))
				.addOption("rename", t("deploy.rename_2"))
				.setValue(this.policy)
				.onChange((v) => (this.policy = v as ExistingPolicy)),
		);

		new Setting(container)
			.setName(t("deploy.template_variable_substitution"))
			.setDesc(t("deploy.substitute_per_member"))
			.addToggle((tg) => tg.setValue(this.substitute).onChange((v) => (this.substitute = v)));

		const head = new Setting(container).setName(t("deploy.target_members", { count: members.length }));
		head.addButton((b) => b.setButtonText(t("deploy.select_all")).onClick(() => this.setAll(true)));
		head.addButton((b) => b.setButtonText(t("deploy.none")).onClick(() => this.setAll(false)));
		for (const st of members) {
			const name = st.memberName || st.memberId;
			// localRoot가 이름과 같으면(폴더=이름) 중복 표기되지 않도록 설명에서 생략.
			const desc = st.localRoot && st.localRoot !== name ? st.localRoot : "";
			new Setting(container)
				.setName(name)
				.setDesc(desc)
				.addToggle((tg) =>
					tg.setValue(this.selected.has(st.memberId)).onChange((v) => {
						if (v) this.selected.add(st.memberId);
						else this.selected.delete(st.memberId);
					}),
				);
		}

		const runRow = container.createDiv({ cls: "covault-panel-actions" });
		panelButton(runRow, t("deploy.preview"), () => this.runPreview());
		panelButton(runRow, t("deploy.copy_to_members"), () => this.runCopy(), { cta: true });

		this.renderResult(container);
	}

	/** 직전 미리보기/실행 결과를 패널에 유지해 보여준다. */
	private renderResult(container: HTMLElement): void {
		if (this.lastPlan) {
			const plan = this.lastPlan;
			container.createDiv({ cls: "covault-panel-label", text: t("deploy.preview") });
			const table = container.createEl("table", { cls: "covault-dash-table" });
			const tr = table.createEl("thead").createEl("tr");
			for (const h of [t("common.member"), t("deploy.create"), t("deploy.overwrite"), t("deploy.skip"), t("deploy.rename")]) tr.createEl("th", { text: h });
			const tb = table.createEl("tbody");
			for (const sp of plan.members) {
				const c = { create: 0, overwrite: 0, skip: 0, rename: 0 };
				for (const e of sp.entries) c[e.action]++;
				const row = tb.createEl("tr");
				row.createEl("td", { text: sp.memberName || sp.memberId });
				row.createEl("td", { text: String(c.create) });
				row.createEl("td", { text: String(c.overwrite) });
				row.createEl("td", { text: String(c.skip) });
				row.createEl("td", { text: String(c.rename) });
			}
			if (plan.sampleAfter !== undefined) {
				container.createDiv({ cls: "covault-panel-hint", text: t("deploy.substitution_preview_first_member") });
				container.createEl("pre", { cls: "covault-deploy-sample", text: plan.sampleAfter });
			}
		}

		if (this.lastResult && !this.lastResult.error) {
			const res = this.lastResult;
			container.createDiv({ cls: "covault-panel-label", text: t("deploy.copy_result") });
			const table = container.createEl("table", { cls: "covault-dash-table" });
			const tr = table.createEl("thead").createEl("tr");
			for (const h of [t("common.member"), t("deploy.written"), t("deploy.skip"), t("deploy.result")]) tr.createEl("th", { text: h });
			const tb = table.createEl("tbody");
			for (const d of res.details) {
				const row = tb.createEl("tr");
				row.createEl("td", { text: d.memberName || d.memberId });
				row.createEl("td", { text: String(d.written) });
				row.createEl("td", { text: String(d.skipped) });
				const note = row.createEl("td", { text: d.error ? t("deploy.failed") : "✓" });
				if (d.error) {
					note.addClass("covault-dash-conflict");
					note.setAttribute("title", d.error);
				}
			}
			const failed = res.details.filter((d) => d.error).map((d) => d.memberId);
			if (failed.length > 0) {
				const row = container.createDiv({ cls: "covault-panel-actions" });
				panelButton(row, t("deploy.retry_failed", { n: failed.length }), () => this.runCopy(failed), { warning: true });
			}
		}
	}

	private fillCurrent(kind: "file" | "folder"): void {
		const f = this.host.app.workspace.getActiveFile();
		if (!f) {
			new Notice(t("deploy.covault_no_file_is_open"));
			return;
		}
		// 원본만 채운다. 대상 경로는 비워두면 복사 시 원본 이름으로 자동 적용되므로,
		// 다시 눌러 다른 파일을 가리켜도 (이전 파일명이 남지 않고) 새 파일 이름이 쓰인다.
		this.sourcePath = kind === "file" ? f.path : f.parent?.path ?? "";
		if (this.container) this.render(this.container);
	}

	private updateInfo(): void {
		const el = this.infoEl;
		if (!el) return;
		if (!this.sourcePath) {
			el.setText(t("deploy.type_a_path_or_fill_it"));
			return;
		}
		const src = this.host.app.vault.getAbstractFileByPath(this.sourcePath);
		if (src instanceof TFolder) el.setText(t("deploy.folder_copies_all_markdown_inside"));
		else if (src instanceof TFile) el.setText(t("deploy.file_copied_as_if_target_path", { name: src.name }));
		else el.setText(t("deploy.path_not_found", { path: this.sourcePath }));
	}

	private setAll(v: boolean): void {
		this.selected.clear();
		if (v) for (const st of this.host.settings.members) if (st.memberId) this.selected.add(st.memberId);
		if (this.container) this.render(this.container);
	}

	private opts() {
		return { destPath: this.destPath, policy: this.policy, substitute: this.substitute };
	}

	/** 선택/원본 검증 후 대상 학생 ID 반환(없으면 null + Notice). */
	private targetIds(override?: string[]): string[] | null {
		if (!this.sourcePath) {
			new Notice(t("deploy.covault_enter_a_source_path"));
			return null;
		}
		const ids = override ?? [...this.selected];
		if (ids.length === 0) {
			new Notice(t("deploy.covault_select_target_members"));
			return null;
		}
		return ids;
	}

	private async runPreview(): Promise<void> {
		const ids = this.targetIds();
		if (!ids) return;
		const plan = await this.host.bulkCopyPreview(this.sourcePath, this.opts(), ids);
		if (plan.error) {
			new Notice(t("deploy.preview_failed", { error: plan.error }));
			return;
		}
		this.lastPlan = plan;
		this.lastResult = null;
		if (this.container) this.render(this.container);
	}

	private async runCopy(override?: string[]): Promise<void> {
		const ids = this.targetIds(override);
		if (!ids) return;
		const res = await this.host.bulkCopy(this.sourcePath, this.opts(), ids);
		this.lastResult = res;
		this.lastPlan = null;
		if (res.error) new Notice(t("deploy.copy_failed", { error: res.error }));
		else new Notice(t("deploy.copy_complete_written_skipped", { written: res.written, skipped: res.skipped }));
		if (this.container) this.render(this.container);
	}

	// --- 공유 공간 배포 ---

	private renderShared(container: HTMLElement): void {
		container.createDiv({ cls: "covault-panel-label", text: t("panel.shared_spaces") });
		const spaces = this.host.settings.sharedSpaces;
		if (spaces.length === 0) {
			container.createDiv({ cls: "covault-feedback-empty", text: t("panel.add_a_shared_space_in_settings") });
			return;
		}
		for (const sp of spaces) {
			const row = container.createDiv({ cls: "covault-panel-row" });
			row.createSpan({
				text: t("panel.msg_3", {
					name: sp.name || sp.id,
					db: sp.remoteDb,
					status: sp.provisioned ? " ✓" : t("panel.not_deployed_2"),
				}),
			});
			panelButton(row, sp.provisioned ? t("common.redeploy") : t("common.deploy"), async () => {
				await this.host.deployShared(sp);
				if (this.container) this.render(this.container);
			});
		}
	}
}
