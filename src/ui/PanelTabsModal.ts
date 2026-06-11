import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import { t } from "../i18n";

export interface TabRow {
	id: string;
	label: string;
	icon: string;
}

/**
 * 패널 탭 편집 — 체크(표시/숨김) + 위/아래 화살표(순서). 역할 기본 구성에서 시작해
 * 사용자가 고른 구성(settings.panelTabs)을 저장한다. 최소 1개 탭은 남겨야 한다.
 */
export class PanelTabsModal extends Modal {
	/** rows: 역할에 허용된 전체 탭(현재 표시 순서 우선, 숨김 탭은 뒤에). */
	constructor(
		app: App,
		private rows: Array<TabRow & { visible: boolean }>,
		private rememberLastTab: boolean,
		private onSave: (visibleIds: string[] | null, rememberLastTab: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.draw();
	}

	private draw(): void {
		const c = this.contentEl;
		c.empty();
		c.createEl("h3", { text: t("panel.edit_tabs") });
		c.createDiv({ cls: "covault-cr-muted", text: t("panel.edit_tabs_hint") });

		const list = c.createDiv({ cls: "covault-dash-list" });
		this.rows.forEach((row, i) => {
			const item = list.createDiv({ cls: "covault-cr-card covault-tab-row" });
			const head = item.createDiv({ cls: "covault-cr-card-head" });
			const cb = head.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = row.visible;
			cb.onchange = () => {
				row.visible = cb.checked;
			};
			setIcon(head.createSpan({ cls: "covault-panel-tab-icon" }), row.icon);
			head.createSpan({ cls: "covault-cr-card-title", text: row.label });
			const up = head.createEl("button", { cls: "clickable-icon" });
			setIcon(up, "chevron-up");
			up.setAttr("aria-label", t("panel.move_up"));
			up.disabled = i === 0;
			up.onclick = () => {
				[this.rows[i - 1], this.rows[i]] = [this.rows[i], this.rows[i - 1]];
				this.draw();
			};
			const down = head.createEl("button", { cls: "clickable-icon" });
			setIcon(down, "chevron-down");
			down.setAttr("aria-label", t("panel.move_down"));
			down.disabled = i === this.rows.length - 1;
			down.onclick = () => {
				[this.rows[i], this.rows[i + 1]] = [this.rows[i + 1], this.rows[i]];
				this.draw();
			};
		});

		// 마지막에 본 탭을 재시작 후 복원할지(옵션).
		new Setting(c)
			.setName(t("panel.remember_last_tab"))
			.setDesc(t("panel.remember_last_tab_desc"))
			.addToggle((tg) => tg.setValue(this.rememberLastTab).onChange((v) => (this.rememberLastTab = v)));

		new Setting(c)
			.addButton((b) =>
				b.setButtonText(t("panel.tabs_reset")).onClick(() => {
					this.onSave(null, this.rememberLastTab); // 탭 구성만 기본 복귀, 복원 옵션은 토글값 유지
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(t("common.save"))
					.setCta()
					.onClick(() => {
						const visible = this.rows.filter((r) => r.visible).map((r) => r.id);
						if (visible.length === 0) {
							new Notice(t("panel.tabs_min"));
							return;
						}
						this.onSave(visible, this.rememberLastTab);
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
