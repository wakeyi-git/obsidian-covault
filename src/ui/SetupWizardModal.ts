import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { CoVaultSettings } from "../settings/types";
import { PanelTab } from "./panel/PanelSection";
import { getCouchPassword } from "../core/secret";
import { t } from "../i18n";

/** 마법사가 의존하는 플러그인 동작(설정 탭에서 주입). 플러그인 인스턴스가 모두 구현한다. */
export interface SetupWizardHost {
	app: App;
	settings: CoVaultSettings;
	testConnection(): Promise<void>;
	fullSync(dir: "both" | "up" | "down"): Promise<void>;
	completeOnboarding(): Promise<void>;
	activatePanel(tab?: PanelTab): Promise<void>;
}

interface Step {
	title: string;
	desc: string;
	done: boolean;
	actions: Array<{ label: string; run: () => void | Promise<void>; cta?: boolean }>;
}

/**
 * 교사 온보딩 마법사(모달). 설정에서 실행하며, 각 단계 완료 여부를 설정에서 파생 계산하고 다음 행동을 안내한다.
 * "설정 열기" 동작은 모달을 닫아(설정 화면이 보이도록) 사용자가 값을 입력하게 한다.
 */
export class SetupWizardModal extends Modal {
	constructor(app: App, private host: SetupWizardHost) {
		super(app);
	}

	onOpen(): void {
		this.draw();
	}

	private steps(): Step[] {
		const s = this.host.settings;
		const membersWithId = s.members.filter((st) => st.memberId);
		const provisioned = s.members.filter((st) => st.provisioned).length;
		const synced = Object.keys(s.lastSeqByDb ?? {}).length > 0;
		const hasPassword = !!getCouchPassword(this.host.app, s.password);
		const openSettings = { label: t("panel.open_settings"), run: () => this.close() };
		return [
			{
				title: t("panel.1_server_connection"),
				desc: t("panel.enter_the_couchdb_server_address_and"),
				done: !!(s.couchdbUrl && s.username) && hasPassword,
				actions: [
					{ ...openSettings, cta: true },
					{ label: t("settings.connection_test"), run: () => this.host.testConnection() },
				],
			},
			{
				title: t("panel.2_workspace_info"),
				desc: t("panel.set_the_workspace_id_and_manager"),
				done: !!s.workspaceId,
				actions: [openSettings],
			},
			{
				title: t("panel.3_add_members"),
				desc: t("panel.add_members_add_member_in_the"),
				done: membersWithId.length > 0,
				actions: [{ ...openSettings, cta: membersWithId.length === 0 }],
			},
			{
				title: t("panel.4_invite_members"),
				desc: t("panel.use_invite_on_a_member_card", { n: provisioned }),
				done: provisioned > 0,
				actions: [openSettings],
			},
			{
				title: t("panel.5_first_sync_test"),
				desc: t("panel.run_a_full_sync_once_to"),
				done: synced,
				actions: [{ label: t("panel.full_sync"), run: () => this.host.fullSync("both"), cta: !synced }],
			},
		];
	}

	private draw(): void {
		const c = this.contentEl;
		c.empty();
		const steps = this.steps();
		const doneCount = steps.filter((x) => x.done).length;

		c.createEl("h3", { text: t("panel.manager_setup") });
		c.createDiv({
			cls: "covault-panel-hint",
			text: t("panel.steps_done_follow_them_in_order", { done: doneCount, total: steps.length }),
		});

		for (const step of steps) {
			const card = c.createDiv({ cls: `covault-setup-step${step.done ? " is-done" : ""}` });
			const head = card.createDiv({ cls: "covault-setup-head" });
			setIcon(head.createSpan({ cls: "covault-setup-check" }), step.done ? "check-circle" : "circle");
			head.createSpan({ cls: "covault-setup-title", text: step.title });
			card.createDiv({ cls: "covault-panel-hint", text: step.desc });
			if (!step.done) {
				const actions = card.createDiv({ cls: "covault-panel-actions" });
				for (const a of step.actions) {
					const b = actions.createEl("button", { text: a.label });
					if (a.cta) b.addClass("mod-cta");
					b.onclick = () => void a.run();
				}
			}
		}

		new Setting(c)
			.addButton((b) => b.setButtonText(t("dashboard.refresh")).onClick(() => this.draw()))
			.addButton((b) =>
				b
					.setButtonText(doneCount === steps.length ? t("panel.finish_dashboard") : t("panel.do_it_later_dashboard"))
					.setCta()
					.onClick(async () => {
						await this.host.completeOnboarding();
						new Notice(t("panel.covault_closed_the_setup_guide"));
						this.close();
						await this.host.activatePanel("dashboard");
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
