import { PanelHost, panelButton } from "../PanelSection";
import { TimetableDoc, TIMETABLE_DOC_ID } from "../../../core/model/types";
import { t } from "../../../i18n";

const DEFAULT_DAYS = ["월", "화", "수", "목", "금"];
const DEFAULT_PERIODS = ["1", "2", "3", "4", "5", "6"];

/** 시간표 모듈 — 주간 그리드(요일×교시). 교사 편집 / 학생 읽기전용. */
export class TimetableView {
	private container: HTMLElement | null = null;
	private doc: TimetableDoc | null = null;

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
		head.createSpan({ cls: "covault-dash-modtitle", text: t("dashboard.timetable") });

		const store = this.host.classroomStore;
		if (!store.ready()) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.homeroom_not_ready") });
			return;
		}

		this.doc = (await store.get<TimetableDoc>(TIMETABLE_DOC_ID)) ?? this.defaultDoc();
		this.renderGrid(c);
	}

	private defaultDoc(): TimetableDoc {
		return {
			_id: TIMETABLE_DOC_ID,
			type: "timetable",
			schemaVersion: 1,
			workspaceId: this.host.settings.workspaceId,
			days: [...DEFAULT_DAYS],
			periods: [...DEFAULT_PERIODS],
			cells: {},
			updatedAtMs: 0,
			updatedBy: this.host.settings.userId,
		};
	}

	private renderGrid(c: HTMLElement): void {
		const doc = this.doc;
		if (!doc) return;
		const table = c.createEl("table", { cls: "covault-timetable" });
		const headRow = table.createEl("tr");
		headRow.createEl("th", { text: "" });
		for (const d of doc.days) headRow.createEl("th", { text: d });

		// Tab 이동을 "같은 요일의 다음 교시"(열 우선) 순서로 만들기 위해 입력들을 열 우선으로 모은다.
		const colMajor: HTMLInputElement[] = new Array(doc.days.length * doc.periods.length);
		doc.periods.forEach((p, pi) => {
			const row = table.createEl("tr");
			row.createEl("th", { text: p });
			doc.days.forEach((_d, di) => {
				const key = `${di}:${pi}`;
				const td = row.createEl("td");
				if (this.manager) {
					const input = td.createEl("input", { attr: { type: "text" } });
					input.value = doc.cells[key] ?? "";
					input.onchange = () => void this.setCell(key, input.value);
					colMajor[di * doc.periods.length + pi] = input;
				} else {
					td.setText(doc.cells[key] ?? "");
				}
			});
		});

		// Tab=다음 교시(아래), Shift+Tab=이전 교시. 한 요일을 위→아래로 채운 뒤 다음 요일로.
		colMajor.forEach((input, idx) => {
			if (!input) return;
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Tab") return;
				const next = colMajor[e.shiftKey ? idx - 1 : idx + 1];
				if (next) {
					e.preventDefault();
					next.focus();
					next.select();
				}
			});
		});
	}

	private async setCell(key: string, value: string): Promise<void> {
		if (!this.doc) return;
		const cells = { ...this.doc.cells };
		if (value.trim()) cells[key] = value.trim();
		else delete cells[key];
		this.doc = { ...this.doc, cells, updatedAtMs: Date.now(), updatedBy: this.host.settings.userId };
		await this.host.classroomStore.put(this.doc);
	}

	dispose(): void {
		this.container = null;
	}
}
