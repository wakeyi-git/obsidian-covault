import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

export interface RoutineInput {
	title: string;
	items: string[];
	recurrence: "daily" | "weekly";
	weekdays?: number[];
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 루틴(체크리스트) 생성 모달(교사). */
export class RoutineEditModal extends Modal {
	private title = "";
	private items: string[] = [""];
	private recurrence: "daily" | "weekly" = "daily";
	private weekdays = new Set<number>([1, 2, 3, 4, 5]);

	constructor(app: App, private onSubmit: (input: RoutineInput) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("dashboard.new_routine") });

		new Setting(contentEl).setName(t("dashboard.routine_title")).addText((tx) => {
			tx.setPlaceholder(t("dashboard.routine_title_placeholder")).onChange((v) => (this.title = v));
			window.setTimeout(() => tx.inputEl.focus(), 0);
		});

		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.routine_items") });
		const itemsBox = contentEl.createDiv({ cls: "covault-dash-rubric" });
		this.renderItems(itemsBox);

		new Setting(contentEl).setName(t("dashboard.recurrence")).addDropdown((d) => {
			d.addOption("daily", t("dashboard.daily"));
			d.addOption("weekly", t("dashboard.weekly"));
			d.setValue("daily").onChange((v) => {
				this.recurrence = v as "daily" | "weekly";
				wdRow.style.display = this.recurrence === "weekly" ? "" : "none";
			});
		});

		const wdRow = contentEl.createDiv({ cls: "covault-dash-weekdays" });
		wdRow.style.display = "none";
		WEEKDAY_KEYS.forEach((k, i) => {
			const lab = wdRow.createEl("label", { cls: "covault-dash-weekday" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = this.weekdays.has(i);
			cb.onchange = () => (cb.checked ? this.weekdays.add(i) : this.weekdays.delete(i));
			lab.createSpan({ text: t(`dashboard.wd_${k}` as never) });
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("dashboard.create"))
					.setCta()
					.onClick(async () => {
						const title = this.title.trim();
						const items = this.items.map((i) => i.trim()).filter(Boolean);
						if (!title) {
							new Notice(t("dashboard.enter_a_title"));
							return;
						}
						if (items.length === 0) {
							new Notice(t("dashboard.add_an_item"));
							return;
						}
						this.close();
						await this.onSubmit({
							title,
							items,
							recurrence: this.recurrence,
							weekdays: this.recurrence === "weekly" ? [...this.weekdays].sort() : undefined,
						});
					}),
			);
	}

	private renderItems(box: HTMLElement): void {
		box.empty();
		this.items.forEach((val, i) => {
			const row = box.createDiv({ cls: "covault-dash-rubric-row" });
			const ti = row.createEl("input", { attr: { type: "text", placeholder: t("dashboard.routine_item_placeholder") } });
			ti.value = val;
			ti.oninput = () => (this.items[i] = ti.value);
			const del = row.createEl("button", { cls: "mod-warning", text: "✕" });
			del.onclick = () => {
				this.items.splice(i, 1);
				if (this.items.length === 0) this.items.push("");
				this.renderItems(box);
			};
		});
		const add = box.createEl("button", { text: t("dashboard.add_item") });
		add.onclick = () => {
			this.items.push("");
			this.renderItems(box);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
