import { PanelHost, panelButton } from "../PanelSection";
import { TimetableDoc, TIMETABLE_DOC_ID } from "../../../core/model/types";
import { t } from "../../../i18n";

const DEFAULT_DAYS = ["월", "화", "수", "목", "금"];
const DEFAULT_PERIODS = ["1", "2", "3", "4", "5", "6"];

/** 시간표 — 주간 그리드(요일×교시). 교사 편집 / 학생 읽기전용. 수업 안내 뷰 상단에 임베드(onBack 없음). */
export class TimetableView {
	private container: HTMLElement | null = null;
	private doc: TimetableDoc | null = null;

	/** onBack 없으면 임베드 모드(뒤로 버튼 미표시). */
	constructor(private host: PanelHost, private onBack?: () => void) {}

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
		if (this.onBack) panelButton(head, t("dashboard.back"), () => this.onBack!());
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

		// 입력 칸은 DOM상 행 우선(교시 행마다 요일 칸)으로 생성되지만, Tab 순서는 "같은 요일의 다음 교시"
		// (열 우선)가 되도록 양의 tabindex를 부여한다. 한 요일(열)을 위→아래로 채운 뒤 다음 요일로 넘어간다.
		const periods = doc.periods.length;
		doc.periods.forEach((p, pi) => {
			const row = table.createEl("tr");
			row.createEl("th", { text: p });
			doc.days.forEach((d, di) => {
				const key = `${di}:${pi}`;
				const td = row.createEl("td");
				const lessonUid = doc.lessons?.[key];
				if (this.manager) {
					const input = td.createEl("input", { attr: { type: "text" } });
					input.value = doc.cells[key] ?? "";
					input.tabIndex = di * periods + pi + 1; // 열 우선 순서(요일 di, 교시 pi)
					input.onchange = () => void this.setCell(key, input.value);
					// 수업 안내 연결: 있으면 열기(📄), 없으면 생성(＋).
					const btn = td.createEl("button", { cls: "covault-tt-lesson", text: lessonUid ? "📄" : "＋" });
					btn.tabIndex = -1;
					btn.title = lessonUid ? t("dashboard.open_lesson") : t("dashboard.add_lesson");
					btn.onclick = () => void (lessonUid ? this.host.openLesson(lessonUid) : this.createLesson(key, d, doc.periods[pi]));
				} else {
					const text = doc.cells[key] ?? "";
					if (lessonUid && text) {
						const link = td.createEl("a", { cls: "covault-tt-link", text });
						link.onclick = (e) => {
							e.preventDefault();
							void this.host.openLesson(lessonUid);
						};
					} else {
						td.setText(text);
					}
				}
			});
		});
	}

	/** 칸에서 수업 안내 생성 후 칸에 연결(교사). */
	private async createLesson(key: string, day: string, period: string): Promise<void> {
		if (!this.doc) return;
		const subject = this.doc.cells[key]?.trim();
		const title = subject ? `${subject} (${day} ${period}${t("dashboard.period_suffix")})` : `${day} ${period}${t("dashboard.period_suffix")}`;
		const uid = await this.host.createLesson(title);
		if (!uid) return;
		const lessons = { ...(this.doc.lessons ?? {}), [key]: uid };
		this.doc = { ...this.doc, lessons, updatedAtMs: Date.now(), updatedBy: this.host.settings.userId };
		await this.host.classroomStore.put(this.doc);
		await this.host.openLesson(uid);
		await this.reload();
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
