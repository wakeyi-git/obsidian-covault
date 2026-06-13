import { TFile } from "obsidian";
import { CouchAdmin } from "../../core/couch/CouchAdmin";
import { noticeFilePath, staleNoticesForPath } from "../../core/classroom/notices";
import {
	defaultTemplate,
	defaultTemplatePath,
	applyNoticeVars,
	noticeFieldsFromFrontmatter,
	NoticeTemplateKind,
} from "../../core/classroom/templates";
import { defaultTimetableDays, DEFAULT_PERIODS, resolveTimetableSlot, placeLessonSlot, removeLessonSlot } from "../../core/classroom/timetable";
import {
	NoticeDoc,
	noticeId,
	noticePrefix,
	TimetableDoc,
	timetableId,
	TIMETABLE_ID_PREFIX,
	ResponseDoc,
	responseId,
	RESPONSE_ID_PREFIX,
	AssignmentStateDoc,
	assignmentStateId,
	ASSIGNMENT_STATE_ID_PREFIX,
} from "../../core/model/types";
import { ensureParentFolders } from "../../core/vault/folders";
import { t } from "../../i18n";
import { ClassroomDeps, readVaultText, writeFileIfAbsent, openVaultPath, frontmatterOf } from "./deps";

/**
 * 알림장·수업 안내(편집창 + 프론트매터) + 시간표 배치 + 비공개 응답(질문) 도메인.
 * 평가 P2-3: ClassroomController에서 분리(거동 불변). 콘텐츠=파일, 게시 메타=NoticeDoc 원칙 유지.
 */
export class NoticeController {
	constructor(private d: ClassroomDeps) {}

	// --- 알림장 / 수업 안내 (편집창 + 프론트매터) ---

	/** 유형별 본문 템플릿(설정 경로 우선, 없으면 내장 기본). */
	private async templateContent(kind: NoticeTemplateKind): Promise<string> {
		const s = this.d.settings();
		const path = kind === "lesson" ? s.lessonTemplate : kind === "assignment" ? s.assignmentTemplate : s.noticeTemplate;
		const tpl = path ? await readVaultText(this.d, path) : null;
		return tpl ?? defaultTemplate(kind);
	}

	/** 새 글 기본 제목(월/일). 교사가 편집창 프론트매터에서 수정한다. */
	private defaultPostTitle(category: "notice" | "lesson"): string {
		const d = new Date();
		const base = category === "lesson" ? t("dashboard.lessons") : t("dashboard.notices");
		return `${base} ${d.getMonth() + 1}/${d.getDate()}`;
	}

	/**
	 * 초안 본문 파일 생성(교사) + 프론트매터(covault/uid/published 등) 주입. 성공 시 {uid, path}.
	 * 게시 메타(NoticeDoc)는 즉시 1회 upsert하고, 이후 편집창에서의 프론트매터 변경은 syncNoticeFromFile이 반영.
	 */
	private async createDraft(
		category: "notice" | "lesson",
		title: string,
		weekKey?: string,
		slot?: { day: string; period: string },
	): Promise<{ uid: string; path: string } | null> {
		if (this.d.settings().role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return null;
		}
		const folder = this.d.homeroomFolder();
		if (!this.d.homeroomReady() || !folder) {
			this.d.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return null;
		}
		const ts = Date.now();
		const path = noticeFilePath(folder, ts, title, category === "lesson" ? t("dashboard.subfolder_lesson") : t("dashboard.subfolder_notice")); // 로케일 반영(U-2)
		await ensureParentFolders(this.d.app, path);
		if (this.d.app.vault.getAbstractFileByPath(path)) {
			this.d.logger.warn(t("dashboard.notice_file_exists"), true);
			return null;
		}
		const uid = `${ts.toString(36)}`;
		const body = applyNoticeVars(await this.templateContent(category), { title, week: weekKey ?? "", date: new Date(ts).toISOString().slice(0, 10) });
		const file = await this.d.app.vault.create(path, body);
		// 템플릿이 프론트매터를 갖지 않거나 일부만 가져도, covault 마커·uid·초안 플래그를 보장한다.
		await this.d.app.fileManager.processFrontMatter(file, (fm) => {
			fm.covault = category;
			fm.uid = uid;
			if (typeof fm.title !== "string" || !fm.title.trim()) fm.title = title;
			if (fm.published === undefined) fm.published = false;
			if (category === "notice" && fm.pinned === undefined) fm.pinned = false;
			if (category === "notice" && fm.responses === undefined) fm.responses = true;
			if (category === "lesson") {
				fm.week = weekKey ?? "";
				// 시간표 칸의 요일/교시를 프론트매터에 기록 — 이후 이 값을 고치는 것이 곧 칸 이동/해제다.
				// 칸 없이 만든 수업도 키를 노출해(빈 값) 편집창에서 채우면 배치되도록 한다.
				fm.day = slot?.day ?? fm.day ?? "";
				fm.period = slot?.period ?? fm.period ?? "";
			}
		});
		await this.putNoticeDoc(uid, path, {
			category,
			title,
			published: false,
			pinned: false,
			allowResponses: true,
			weekKey: category === "lesson" ? weekKey : undefined,
		});
		return { uid, path };
	}

	/** 새 알림장: 초안 파일을 만들어 편집창에서 연다(프론트매터로 작성·게시). */
	async newNotice(): Promise<boolean> {
		const r = await this.createDraft("notice", this.defaultPostTitle("notice"));
		if (!r) return false;
		await openVaultPath(this.d, r.path);
		this.d.logger.ok(t("dashboard.notice_draft_created"), true);
		return true;
	}

	/** 새 수업 안내: 초안 파일을 만들어 편집창에서 연다. uid 반환(시간표 칸 연결용). slot=칸의 요일/교시 라벨(프론트매터에 기록). */
	async createLesson(title: string, weekKey?: string, slot?: { day: string; period: string }): Promise<string | null> {
		const r = await this.createDraft("lesson", title || this.defaultPostTitle("lesson"), weekKey, slot);
		if (!r) return null;
		await openVaultPath(this.d, r.path);
		return r.uid;
	}

	/** 게시 메타(NoticeDoc) upsert. 기존 게시시각/작성자는 보존, 나머지 프론트매터 필드를 반영. */
	private async putNoticeDoc(
		uid: string,
		filePath: string,
		f: { category: "notice" | "lesson"; title: string; published: boolean; pinned: boolean; allowResponses: boolean; weekKey?: string },
	): Promise<void> {
		const existing = await this.d.classroom.get<NoticeDoc>(noticeId(uid));
		const doc: NoticeDoc = {
			_id: noticeId(uid),
			_rev: existing?._rev,
			type: "notice",
			schemaVersion: 1,
			workspaceId: this.d.settings().workspaceId,
			uid,
			title: f.title,
			filePath,
			postedAtMs: existing?.postedAtMs ?? Date.now(),
			pinned: f.pinned,
			published: f.published,
			allowResponses: f.allowResponses,
			category: f.category,
			weekKey: f.weekKey,
			createdBy: existing?.createdBy ?? this.d.settings().userId,
			createdByRole: existing?.createdByRole ?? "manager",
			// 파일이 존재하고 covault 프론트매터가 유효하면 항상 살아있는 글로 취급(soft-delete된 글도 재저장으로 복구).
			deleted: undefined,
		};
		// 변경 없는 빈번한 metadataCache 이벤트에선 쓰기를 생략(동기화 잡음 방지). 단, soft-delete된 글은 반드시 되살린다.
		if (existing && !existing.deleted && existing.title === doc.title && existing.filePath === doc.filePath && !!existing.pinned === doc.pinned && (existing.published ?? false) === doc.published && (existing.allowResponses ?? true) === doc.allowResponses && (existing.weekKey ?? undefined) === doc.weekKey) {
			return;
		}
		await this.d.classroom.put(doc);
	}

	/** 편집창에서 알림장/수업 파일의 프론트매터가 바뀌면 게시 메타를 동기화(교사 전용). */
	async syncNoticeFromFile(file: TFile): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		const fm = this.d.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const uid = fm?.uid;
		// 실제 uid가 있는 글만(템플릿 원본의 {{uid}} 자리표시자는 무시).
		if (typeof uid !== "string" || !uid || uid.includes("{{")) return;
		const fields = noticeFieldsFromFrontmatter(fm, file.basename);
		if (!fields) return;
		await this.putNoticeDoc(uid, file.path, fields);
		// 직접 uid를 바꿔 생긴 중복(같은 파일을 가리키는 옛 uid 문서)을 폐기 — 다음 저장 때 자가 치유.
		await this.retireStaleNoticesForPath(file.path, uid);
		// 수업의 프론트매터 week/day/period가 시간표 배치의 원천 — 칸 배치·이동·주 변경·해제를 직접 반영한다.
		// day/period 키가 아예 없는 수업(구버전·외부 작성)은 건드리지 않아 대시보드에서 맺은 연결을 보존한다.
		if (fields.category === "lesson" && (fm.day !== undefined || fm.period !== undefined)) {
			await this.placeLessonInTimetable(uid, fields.weekKey, fm.day, fm.period);
		}
	}

	/** 같은 파일 경로를 가리키지만 uid가 다른 옛 게시 메타를 soft-delete(중복/고아 정리). */
	private async retireStaleNoticesForPath(path: string, keepUid: string): Promise<void> {
		const docs = await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix());
		for (const d of staleNoticesForPath(docs, path, keepUid)) await this.d.classroom.softDelete(d);
	}

	/**
	 * 중복/고아 학급 문서 정리(교사, 수동 명령). 반환: 정리 건수.
	 * - 중복: 같은 파일을 가리키는 게시 메타가 여럿이면 하나만 남기고 폐기(파일 프론트매터 uid 우선, 없으면 최신).
	 * - 고아: 파일이 더 이상 없는 게시 메타 폐기.
	 * - 끊긴 연결: 시간표 칸이 가리키는 수업 uid가 살아있지 않으면 칸 연결 제거.
	 * - 고아 과제 기록: 정의가 사라진(삭제된) 과제의 학생 상태 문서를 soft-delete(학생 대시보드 잔재 제거).
	 */
	async cleanupClassroomDocs(): Promise<{ duplicates: number; orphans: number; danglingLinks: number; orphanAssignments: number }> {
		const result = { duplicates: 0, orphans: 0, danglingLinks: 0, orphanAssignments: 0 };
		if (this.d.settings().role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return result;
		}
		if (!this.d.homeroomReady()) {
			this.d.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return result;
		}
		const live = (await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix())).filter((n) => !n.deleted);

		// 1) 같은 파일 경로 중복 → 하나만 남김.
		const byPath = new Map<string, NoticeDoc[]>();
		for (const n of live) (byPath.get(n.filePath) ?? byPath.set(n.filePath, []).get(n.filePath)!).push(n);
		for (const [path, group] of byPath) {
			if (group.length < 2) continue;
			const fm = frontmatterOf(this.d, path);
			const keepUid = typeof fm?.uid === "string" ? fm.uid : undefined;
			const keeper =
				(keepUid && group.find((n) => n.uid === keepUid)) ||
				group.slice().sort((a, b) => b.postedAtMs - a.postedAtMs)[0];
			for (const n of group) if (n.uid !== keeper.uid) {
				await this.d.classroom.softDelete(n);
				result.duplicates++;
			}
		}

		// 2) 파일이 사라진 고아 → 폐기.
		const surviving = (await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix())).filter((n) => !n.deleted);
		for (const n of surviving) {
			if (!this.d.app.vault.getAbstractFileByPath(n.filePath)) {
				await this.d.classroom.softDelete(n);
				result.orphans++;
			}
		}

		// 3) 시간표의 끊긴 수업 연결 제거.
		const liveUids = new Set(
			(await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix())).filter((n) => !n.deleted).map((n) => n.uid),
		);
		for (const tt of await this.d.classroom.listByPrefix<TimetableDoc>(TIMETABLE_ID_PREFIX)) {
			const lessons = { ...(tt.lessons ?? {}) };
			let changed = false;
			for (const [cell, uid] of Object.entries(lessons))
				if (!liveUids.has(uid)) {
					delete lessons[cell];
					changed = true;
					result.danglingLinks++;
				}
			if (changed) await this.d.classroom.put({ ...tt, lessons });
		}

		// 4) 삭제된(정의가 사라진) 과제의 학생 상태 문서 정리 — 학생 미러에 soft-delete를 써서 학생 대시보드 잔재 제거.
		const s = this.d.settings();
		const liveAssignmentUids = new Set((s.assignments ?? []).map((d) => d.uid));
		if (s.couchdbUrl && s.username && this.d.couchPassword()) {
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
			for (const m of s.members) {
				if (!m.memberId || !m.provisioned) continue;
				const sync = this.d.memberSyncByRemoteDb(m.remoteDb);
				if (!sync) continue;
				const states = await sync.ctx.pouch.allDocsByPrefix<AssignmentStateDoc>(ASSIGNMENT_STATE_ID_PREFIX);
				for (const st of states) {
					if (!st.deleted && !liveAssignmentUids.has(st.assignmentUid)) {
						await admin.putDoc(m.remoteDb, { ...st, deleted: true });
						result.orphanAssignments++;
					}
				}
			}
		}

		this.d.requestApply();
		this.d.logger.ok(t("command.cleanup_done", result), true);
		return result;
	}

	/**
	 * 수업(uid)의 시간표 배치를 프론트매터(week/day/period) 기준으로 동기화(교사).
	 * 가리키는 칸에 연결하고, 더 이상 가리키지 않는 칸(다른 주·다른 칸, 또는 값을 비운 경우)은 해제한다.
	 *
	 * 여러 수업 파일이 동시에 저장되면(예: 외부/Cowork가 한꺼번에 생성) 한 주의 TimetableDoc을 동시에
	 * read-modify-write 하다가 서로 덮어써 일부 배치가 유실된다(put이 충돌 시 last-write-wins). 이를 막기 위해
	 * 배치 쓰기를 **직렬화**해 항상 최신 문서를 읽고 한 칸씩 누적 반영한다.
	 */
	private placeQueue: Promise<unknown> = Promise.resolve();
	private placeLessonInTimetable(uid: string, weekKey: string | undefined, dayRaw: unknown, periodRaw: unknown): Promise<void> {
		const run = this.placeQueue.then(() => this.doPlaceLessonInTimetable(uid, weekKey, dayRaw, periodRaw));
		this.placeQueue = run.catch(() => {}); // 한 건 실패가 큐를 끊지 않도록
		return run;
	}

	private async doPlaceLessonInTimetable(uid: string, weekKey: string | undefined, dayRaw: unknown, periodRaw: unknown): Promise<void> {
		const existing = weekKey ? await this.d.classroom.get<TimetableDoc>(timetableId(weekKey)) : null;
		const days = existing?.days ?? defaultTimetableDays();
		const periods = existing?.periods ?? [...DEFAULT_PERIODS];
		// 칸을 못 정하면(week 누락, day/period 비움·오타) 목표 칸 없음 → 아래 정리에서 기존 연결만 해제.
		const cellKey = weekKey ? resolveTimetableSlot(dayRaw, periodRaw, days, periods) : null;
		// 1) 목표가 아닌 시간표에 남은 연결 해제 — 주(week) 이동, day/period 비움이 칸에 직접 반영되도록.
		for (const tt of await this.d.classroom.listByPrefix<TimetableDoc>(TIMETABLE_ID_PREFIX)) {
			if (cellKey && tt.weekKey === weekKey) continue; // 목표 주는 아래 배치가 처리(칸 이동 포함)
			const r = removeLessonSlot(tt.lessons ?? {}, uid);
			if (r.changed) await this.d.classroom.put({ ...tt, lessons: r.lessons, updatedAtMs: Date.now(), updatedBy: this.d.settings().userId });
		}
		if (!cellKey || !weekKey) return;
		const doc: TimetableDoc =
			existing ?? {
				_id: timetableId(weekKey),
				type: "timetable",
				schemaVersion: 1,
				workspaceId: this.d.settings().workspaceId,
				weekKey,
				days,
				periods,
				cells: {},
				lessons: {},
				updatedAtMs: 0,
				updatedBy: this.d.settings().userId,
			};
		const { lessons, changed } = placeLessonSlot(doc.lessons ?? {}, uid, cellKey);
		if (!changed) return;
		await this.d.classroom.put({ ...doc, lessons, updatedAtMs: Date.now(), updatedBy: this.d.settings().userId });
	}

	/** 파일 삭제 시 대응 게시 메타를 soft-delete(교사 전용). */
	async onNoticeFileDeleted(path: string): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		const docs = await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix());
		const doc = docs.find((d) => !d.deleted && d.filePath === path);
		if (doc) await this.d.classroom.softDelete(doc);
	}

	/** 파일 이름변경 시 게시 메타의 filePath를 갱신(교사 전용). */
	async onNoticeFileRenamed(file: TFile, oldPath: string): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		const docs = await this.d.classroom.listByPrefix<NoticeDoc>(noticePrefix());
		const doc = docs.find((d) => !d.deleted && d.filePath === oldPath);
		if (doc) await this.d.classroom.put({ ...doc, filePath: file.path });
	}

	/** 게시/게시 취소(교사): 메타 + 파일 프론트매터 published를 함께 갱신. */
	async setNoticePublished(notice: NoticeDoc, published: boolean): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		await this.d.classroom.put({ ...notice, published });
		const f = this.d.app.vault.getAbstractFileByPath(notice.filePath);
		if (f instanceof TFile) await this.d.app.fileManager.processFrontMatter(f, (fm) => (fm.published = published));
	}

	/** 유형별 기본 템플릿 파일을 생성하고(이미 있으면 그대로) 설정에 경로를 저장한 뒤 편집창에서 연다. */
	async createTemplateFile(kind: NoticeTemplateKind): Promise<void> {
		const s = this.d.settings();
		const key = kind === "lesson" ? "lessonTemplate" : kind === "assignment" ? "assignmentTemplate" : "noticeTemplate";
		const path = (s[key] as string) || defaultTemplatePath(kind);
		await writeFileIfAbsent(this.d, path, defaultTemplate(kind));
		(s as unknown as Record<string, unknown>)[key] = path;
		await this.d.saveSettings();
		await openVaultPath(this.d, path);
		this.d.logger.ok(t("settings.template_created", { path }), true);
	}

	async deleteNotice(notice: NoticeDoc): Promise<void> {
		await this.d.classroom.softDelete(notice);
		const f = this.d.app.vault.getAbstractFileByPath(notice.filePath);
		if (f instanceof TFile) {
			try {
				await this.d.app.vault.trash(f, false);
			} catch {
				await this.d.app.vault.delete(f).catch(() => {});
			}
		}
	}

	async openLesson(uid: string): Promise<void> {
		const doc = await this.d.classroom.get<NoticeDoc>(noticeId(uid));
		if (!doc) return;
		await openVaultPath(this.d, doc.filePath);
		if (this.d.settings().role === "member") {
			const now = Date.now();
			const r: ResponseDoc = {
				_id: responseId(doc._id, this.d.settings().userId, "read"),
				type: "response",
				schemaVersion: 1,
				workspaceId: this.d.settings().workspaceId,
				targetId: doc._id,
				kind: "read",
				byUser: this.d.settings().userId,
				byRole: "member",
				createdAtMs: now,
			};
			await this.d.classroom.put(r);
		}
	}

	// --- 응답(질문) ---

	/** 비공개 응답 기록 — 학생 본인 mirror에 저장(학생 질문 등). */
	async postPrivateResponse(doc: ResponseDoc): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		await sync.ctx.pouch.put(doc);
		return true;
	}

	/** 특정 구성원 mirror에 비공개 응답 기록(교사가 그 학생의 질문에 답글). */
	async postPrivateResponseTo(remoteDb: string, doc: ResponseDoc): Promise<boolean> {
		const sync = this.d.memberSyncByRemoteDb(remoteDb);
		if (!sync) return false;
		await sync.ctx.pouch.put(doc);
		return true;
	}

	/** 비공개 응답 수집(질문 + 교사 답글). 교사=전 구성원 mirror, 학생=본인 mirror. */
	async listPrivateResponses(): Promise<ResponseDoc[]> {
		const out: ResponseDoc[] = [];
		if (this.d.settings().role === "manager") {
			for (const m of this.d.settings().members) {
				if (!m.memberId) continue;
				const sync = this.d.memberSyncByRemoteDb(m.remoteDb);
				if (!sync) continue;
				out.push(...(await sync.ctx.pouch.allDocsByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX)));
			}
		} else {
			const sync = this.d.studentMirrorSync();
			if (sync) out.push(...(await sync.ctx.pouch.allDocsByPrefix<ResponseDoc>(RESPONSE_ID_PREFIX)));
		}
		return out.filter((d) => (d.kind === "question" || d.kind === "comment") && !d.deleted);
	}
}
