import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

export interface RoutineItemInput {
	id?: string; // 편집 시 기존 항목 id 보존(체크 상태 연속성)
	label: string;
	recurrence: "daily" | "weekly";
	weekdays?: number[];
}
export interface RoutineInput {
	title: string;
	items: RoutineItemInput[];
}

/** 편집 시 기존 루틴(제목 + 항목). */
export interface RoutineInitial {
	title: string;
	items: Array<{ id: string; label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }>;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

interface ItemDraft {
	id?: string;
	label: string;
	recurrence: "daily" | "weekly";
	weekdays: Set<number>;
}

/** 루틴(체크리스트) 생성/편집 모달(교사). 반복은 항목별로 설정. */
export class RoutineEditModal extends Modal {
	private title = "";
	private items: ItemDraft[];

	constructor(app: App, private onSubmit: (input: RoutineInput) => void | Promise<void>, private initial?: RoutineInitial) {
		super(app);
		this.title = initial?.title ?? "";
		this.items = initial
			? initial.items.map((it) => ({
					id: it.id,
					label: it.label,
					recurrence: it.recurrence,
					weekdays: new Set(it.weekdays ?? [1, 2, 3, 4, 5]),
				}))
			: [{ label: "", recurrence: "daily", weekdays: new Set([1, 2, 3, 4, 5]) }];
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.initial ? t("dashboard.edit_routine") : t("dashboard.new_routine") });

		new Setting(contentEl).setName(t("dashboard.routine_title")).addText((tx) => {
			tx.setPlaceholder(t("dashboard.routine_title_placeholder")).setValue(this.title).onChange((v) => (this.title = v));
			window.setTimeout(() => tx.inputEl.focus(), 0);
		});

		contentEl.createDiv({ cls: "covault-dash-label", text: t("dashboard.routine_items") });
		const itemsBox = contentEl.createDiv();
		this.renderItems(itemsBox);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("common.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.initial ? t("common.save") : t("dashboard.create"))
					.setCta()
					.onClick(async () => {
						const title = this.title.trim();
						const items = this.items
							.filter((it) => it.label.trim())
							.map((it) => ({
								id: it.id,
								label: it.label.trim(),
								recurrence: it.recurrence,
								weekdays: it.recurrence === "weekly" ? [...it.weekdays].sort() : undefined,
							}));
						if (!title) {
							new Notice(t("dashboard.enter_a_title"));
							return;
						}
						if (items.length === 0) {
							new Notice(t("dashboard.add_an_item"));
							return;
						}
						this.close();
						await this.onSubmit({ title, items });
					}),
			);
	}

	private renderItems(box: HTMLElement): void {
		box.empty();
		this.items.forEach((it, i) => {
			const card = box.createDiv({ cls: "covault-dash-itemrow" });
			const top = card.createDiv({ cls: "covault-dash-rubric-row" });
			const ti = top.createEl("input", { attr: { type: "text", placeholder: t("dashboard.routine_item_placeholder") } });
			ti.value = it.label;
			ti.oninput = () => (it.label = ti.value);
			const sel = top.createEl("select", { cls: "covault-dash-recur" });
			sel.createEl("option", { value: "daily", text: t("dashboard.daily") });
			sel.createEl("option", { value: "weekly", text: t("dashboard.weekly") });
			sel.value = it.recurrence;
			const del = top.createEl("button", { cls: "mod-warning", text: "✕" });
			del.onclick = () => {
				this.items.splice(i, 1);
				if (this.items.length === 0) this.items.push({ label: "", recurrence: "daily", weekdays: new Set([1, 2, 3, 4, 5]) });
				this.renderItems(box);
			};

			// 요일 선택(weekly일 때만 표시)
			const wd = card.createDiv({ cls: "covault-dash-weekdays" });
			wd.style.display = it.recurrence === "weekly" ? "" : "none";
			WEEKDAY_KEYS.forEach((k, di) => {
				const lab = wd.createEl("label", { cls: "covault-dash-weekday" });
				const cb = lab.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = it.weekdays.has(di);
				cb.onchange = () => (cb.checked ? it.weekdays.add(di) : it.weekdays.delete(di));
				lab.createSpan({ text: t(`dashboard.wd_${k}` as never) });
			});
			sel.onchange = () => {
				it.recurrence = sel.value as "daily" | "weekly";
				wd.style.display = it.recurrence === "weekly" ? "" : "none";
			};
		});
		const add = box.createEl("button", { text: t("dashboard.add_item") });
		add.onclick = () => {
			this.items.push({ label: "", recurrence: "daily", weekdays: new Set([1, 2, 3, 4, 5]) });
			this.renderItems(box);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
