import { setIcon } from "obsidian";
import { PanelHost } from "../PanelSection";
import { TimetableDoc, NoticeDoc, timetableId, noticePrefix } from "../../../core/model/types";
import { weekStart } from "../../../core/classroom/week";
import { defaultTimetableDays as defaultDays, DEFAULT_PERIODS } from "../../../core/classroom/timetable";
import { captureScroll } from "../scroll";
import { t } from "../../../i18n";

/** 시간표 — 주간 그리드(요일×교시). 주(週)별 문서. 수업 안내 뷰에 임베드되며 주는 NoticesView가 제어. */
export class TimetableView {
	private container: HTMLElement | null = null;
	private doc: TimetableDoc | null = null;

	constructor(private host: PanelHost, private weekKey: string = weekStart(Date.now())) {}

	render(container: HTMLElement): void {
		this.container = container;
		void this.reload();
	}

	private get manager(): boolean {
		return this.host.settings.role === "manager";
	}

	/** 재렌더 + 스크롤 위치 보존. */
	private async reload(): Promise<void> {
		const restore = captureScroll(this.container);
		await this.rebuild();
		restore();
	}

	private async rebuild(): Promise<void> {
		const c = this.container;
		if (!c) return;
		c.empty();

		const store = this.host.classroomStore;
		if (!store.ready()) {
			c.createDiv({ cls: "covault-dash-empty", text: t("dashboard.homeroom_not_ready") });
			return;
		}

		this.doc = (await store.get<TimetableDoc>(timetableId(this.weekKey))) ?? this.defaultDoc();
		// 삭제된 수업 안내를 가리키는 칸은 미연결로 취급(+ 버튼 복구) — 살아있는 lesson uid만 유효.
		// 학생에겐 게시된 수업만 연결로 노출(초안은 미연결 처리).
		const valid = new Set(
			(await store.listByPrefix<NoticeDoc>(noticePrefix()))
				.filter((n) => !n.deleted && (n.category ?? "notice") === "lesson" && (this.manager || n.published !== false))
				.map((n) => n.uid),
		);
		this.renderGrid(c, valid);
	}

	private defaultDoc(): TimetableDoc {
		return {
			_id: timetableId(this.weekKey),
			type: "timetable",
			schemaVersion: 1,
			workspaceId: this.host.settings.workspaceId,
			weekKey: this.weekKey,
			days: defaultDays(),
			periods: [...DEFAULT_PERIODS],
			cells: {},
			updatedAtMs: 0,
			updatedBy: this.host.settings.userId,
		};
	}

	private renderGrid(c: HTMLElement, validLessons: Set<string>): void {
		const doc = this.doc;
		if (!doc) return;
		const wrap = c.createDiv({ cls: "covault-timetable-wrap" });
		const table = wrap.createEl("table", { cls: "covault-timetable" });
		// 이번 주를 보고 있을 때만 오늘 요일 열을 강조.
		const todayCol = this.weekKey === weekStart(Date.now()) ? (new Date().getDay() + 6) % 7 : -1;
		const headRow = table.createEl("tr");
		headRow.createEl("th", { text: "" });
		doc.days.forEach((d, di) => {
			const th = headRow.createEl("th", { text: d });
			if (di === todayCol) th.addClass("is-today");
		});

		// 입력 칸은 DOM상 행 우선(교시 행마다 요일 칸)으로 생성되지만, Tab 순서는 "같은 요일의 다음 교시"
		// (열 우선)가 되도록 양의 tabindex를 부여한다. 한 요일(열)을 위→아래로 채운 뒤 다음 요일로 넘어간다.
		const periods = doc.periods.length;
		doc.periods.forEach((p, pi) => {
			const row = table.createEl("tr");
			row.createEl("th", { text: p });
			doc.days.forEach((d, di) => {
				const key = `${di}:${pi}`;
				const td = row.createEl("td");
				if (di === todayCol) td.addClass("is-today");
				const rawUid = doc.lessons?.[key];
				// 삭제된 수업을 가리키면 미연결 처리(+ 버튼 복구).
				const lessonUid = rawUid && validLessons.has(rawUid) ? rawUid : undefined;
				if (this.manager) {
					// 인라인 스타일로 레이아웃을 고정한다(styles.css 캐시/구버전과 무관하게 겹침 방지).
					const cell = td.createDiv({ cls: "covault-tt-cell" });
					cell.style.display = "flex";
					cell.style.alignItems = "center";
					cell.style.gap = "2px";
					cell.style.minWidth = "0";
					const input = cell.createEl("input", { attr: { type: "text" } });
					input.size = 1; // 본래 너비를 최소화 → flex로만 폭 결정(버튼을 밀어내지 않음)
					input.value = doc.cells[key] ?? "";
					input.tabIndex = di * periods + pi + 1; // 열 우선 순서(요일 di, 교시 pi)
					input.onchange = () => void this.setCell(key, input.value);
					Object.assign(input.style, { flex: "1 1 0", minWidth: "0", width: "auto", border: "none", background: "transparent", textAlign: "center" });
					// 수업 안내 연결: 있으면 열기(file-text), 없으면 생성(plus). 입력칸과 나란히 배치(겹침 방지).
					const btn = cell.createEl("button", {
						cls: `covault-tt-lesson${lessonUid ? " is-linked" : ""}`,
					});
					setIcon(btn, lessonUid ? "file-text" : "plus");
					btn.tabIndex = -1;
					btn.title = lessonUid ? t("dashboard.open_lesson") : t("dashboard.add_lesson");
					Object.assign(btn.style, {
						position: "static", // 구버전 styles.css의 absolute 무력화
						flex: "0 0 auto",
						background: "transparent",
						border: "none",
						boxShadow: "none",
						padding: "0 2px",
						margin: "0",
						minWidth: "0",
						cursor: "pointer",
						fontSize: "13px",
						opacity: lessonUid ? "1" : "0.5",
					});
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
		const uid = await this.host.createLesson(title, this.weekKey);
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
