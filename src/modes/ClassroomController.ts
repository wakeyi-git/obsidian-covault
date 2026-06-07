import { App, TFile } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { ClassroomStore } from "../core/classroom/ClassroomStore";
import { MirrorSync } from "../core/sync/MirrorSync";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { VersionStore } from "../core/sync/VersionStore";
import { ensureParentFolders } from "../core/vault/folders";
import { noticeFilePath } from "../core/classroom/notices";
import {
	defaultTemplate,
	defaultTemplatePath,
	applyNoticeVars,
	noticeFieldsFromFrontmatter,
	NoticeTemplateKind,
} from "../core/classroom/templates";
import { assignmentWorkDir, substituteTemplate, slugify, rubricMax } from "../core/classroom/assignments";
import {
	NoticeDoc,
	noticeId,
	noticePrefix,
	ResponseDoc,
	responseId,
	RESPONSE_ID_PREFIX,
	AssignmentDoc,
	AssignmentStateDoc,
	AssignmentGrade,
	assignmentId,
	assignmentStateId,
	ASSIGNMENT_STATE_ID_PREFIX,
	RoutineDoc,
	RoutineStateDoc,
	routineId,
	routinePrefix,
	routineStateId,
	routineStatePrefix,
	ROUTINE_STATE_ID_PREFIX,
	RubricCriterion,
} from "../core/model/types";
import { t } from "../i18n";

/**
 * ClassroomController가 플러그인에 요구하는 의존성. `settings`는 loadSettings/import에서
 * 객체가 교체되므로 반드시 getter로 제공한다(값 캡처 금지). classroom/app/logger는 1회 생성되어 안정적.
 */
export interface ClassroomDeps {
	app: App;
	logger: Logger;
	classroom: ClassroomStore;
	settings(): CoVaultSettings;
	couchPassword(): string;
	homeroomReady(): boolean;
	homeroomFolder(): string | null;
	saveSettings(): Promise<void>;
	requestApply(): void;
	memberSyncByRemoteDb(db: string): MirrorSync | undefined;
	studentMirrorSync(): MirrorSync | undefined;
}

/**
 * 학급 운영(대시보드) 도메인 컨트롤러 — 알림장·수업 안내·과제·루틴·응답·통계 수집.
 * main.ts에서 분리(동작 불변). 콘텐츠=파일, 상태=PouchDoc 원칙은 그대로.
 */
export class ClassroomController {
	constructor(private d: ClassroomDeps) {}

	private async readVaultText(path: string): Promise<string | null> {
		const f = this.d.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? await this.d.app.vault.read(f) : null;
	}
	private async writeFileIfAbsent(path: string, body: string): Promise<void> {
		await ensureParentFolders(this.d.app, path);
		if (!this.d.app.vault.getAbstractFileByPath(path)) await this.d.app.vault.create(path, body);
	}

	// --- 알림장 / 수업 안내 (편집창 + 프론트매터) ---

	/** 유형별 본문 템플릿(설정 경로 우선, 없으면 내장 기본). */
	private async templateContent(kind: NoticeTemplateKind): Promise<string> {
		const s = this.d.settings();
		const path = kind === "lesson" ? s.lessonTemplate : kind === "assignment" ? s.assignmentTemplate : s.noticeTemplate;
		const tpl = path ? await this.readVaultText(path) : null;
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
	private async createDraft(category: "notice" | "lesson", title: string, weekKey?: string): Promise<{ uid: string; path: string } | null> {
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
		const path = noticeFilePath(folder, ts, title, category === "lesson" ? "수업" : "알림장");
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
			if (category === "lesson") fm.week = weekKey ?? "";
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
		await this.openVaultPath(r.path);
		this.d.logger.ok(t("dashboard.notice_draft_created"), true);
		return true;
	}

	/** 새 수업 안내: 초안 파일을 만들어 편집창에서 연다. uid 반환(시간표 칸 연결용). */
	async createLesson(title: string, weekKey?: string): Promise<string | null> {
		const r = await this.createDraft("lesson", title || this.defaultPostTitle("lesson"), weekKey);
		if (!r) return null;
		await this.openVaultPath(r.path);
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
			deleted: existing?.deleted,
		};
		// 변경 없는 빈번한 metadataCache 이벤트에선 쓰기를 생략(동기화 잡음 방지).
		if (existing && existing.title === doc.title && existing.filePath === doc.filePath && !!existing.pinned === doc.pinned && (existing.published ?? false) === doc.published && (existing.allowResponses ?? true) === doc.allowResponses && (existing.weekKey ?? undefined) === doc.weekKey) {
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
		await this.writeFileIfAbsent(path, defaultTemplate(kind));
		(s as unknown as Record<string, unknown>)[key] = path;
		await this.d.saveSettings();
		await this.openVaultPath(path);
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
		await this.openVaultPath(doc.filePath);
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

	// --- 과제(assignments) ---

	assignmentDefs(): AssignmentDoc[] {
		return this.d.settings().assignments ?? [];
	}

	async createAssignment(input: {
		title: string;
		instructions: string;
		dueAt?: number;
		points?: number;
		privacy: "mirror" | "shared";
		targetMembers: string[];
		templatePath?: string;
		rubric?: RubricCriterion[];
	}): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
			this.d.logger.warn(t("command.enter_the_admin_account_first"), true);
			return false;
		}
		if (input.privacy === "shared" && !this.d.homeroomReady()) {
			this.d.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return false;
		}
		const uid = `${Date.now().toString(36)}`;
		const def: AssignmentDoc = {
			_id: assignmentId(uid),
			type: "assignment",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			uid,
			title: input.title,
			instructions: input.instructions,
			templatePaths: input.templatePath ? [input.templatePath] : [],
			privacy: input.privacy,
			targetMembers: [...input.targetMembers],
			dueAt: input.dueAt,
			points: input.points,
			rubric: input.rubric && input.rubric.length > 0 ? input.rubric : undefined,
			createdBy: s.userId,
			createdAtMs: Date.now(),
		};
		s.assignments = [...(s.assignments ?? []), def];
		await this.d.saveSettings();
		await this.distributeAssignment(def);
		return true;
	}

	/** 과제 정의 수정(교사) — 정의 갱신 후 재배포(기존 제출/성적 보존, 새 대상은 신규 배포). */
	async updateAssignment(uid: string, input: Parameters<ClassroomController["createAssignment"]>[0]): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		const defs = s.assignments ?? [];
		const idx = defs.findIndex((d) => d.uid === uid);
		if (idx < 0) return false;
		const next: AssignmentDoc = {
			...defs[idx],
			title: input.title,
			instructions: input.instructions,
			templatePaths: input.templatePath ? [input.templatePath] : [],
			privacy: input.privacy,
			targetMembers: [...input.targetMembers],
			dueAt: input.dueAt,
			points: input.points,
			rubric: input.rubric && input.rubric.length > 0 ? input.rubric : undefined,
		};
		s.assignments = defs.map((d, i) => (i === idx ? next : d));
		await this.d.saveSettings();
		await this.distributeAssignment(next);
		return true;
	}

	/** 과제 삭제(교사) — 정의 제거 + 각 학생 미러의 상태 문서 soft-delete(작업 파일은 보존). */
	async deleteAssignment(uid: string): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		const defs = s.assignments ?? [];
		const def = defs.find((d) => d.uid === uid);
		if (!def) return false;
		s.assignments = defs.filter((d) => d.uid !== uid);
		await this.d.saveSettings();
		if (s.couchdbUrl && s.username && this.d.couchPassword()) {
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
			for (const memberId of def.targetMembers) {
				const member = s.members.find((m) => m.memberId === memberId && m.provisioned);
				if (!member) continue;
				const cur = await this.d.memberSyncByRemoteDb(member.remoteDb)?.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(uid, memberId));
				if (cur && !cur.deleted) await admin.putDoc(member.remoteDb, { ...cur, deleted: true });
			}
		}
		this.d.requestApply();
		this.d.logger.ok(t("dashboard.assignment_deleted", { title: def.title }), true);
		return true;
	}

	private async distributeAssignment(def: AssignmentDoc): Promise<void> {
		const s = this.d.settings();
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
		const slug = slugify(def.title);
		const date = new Date().toISOString().slice(0, 10);
		const tplPath = def.templatePaths[0] || s.assignmentTemplate;
		const templateContent = tplPath ? (await this.readVaultText(tplPath)) ?? defaultTemplate("assignment") : defaultTemplate("assignment");
		const templateName = tplPath?.split("/").pop() || "과제.md";
		const subst = (memberId: string, memberName: string): string =>
			substituteTemplate(applyNoticeVars(templateContent, { title: def.title, date }), { memberId, memberName, workspaceId: s.workspaceId, date });
		const homeFolder = this.d.homeroomFolder() ?? "";

		let sharedWorkPath: string | null = null;
		if (def.privacy === "shared") {
			sharedWorkPath = `${assignmentWorkDir("shared", "", homeFolder, slug)}/${templateName}`;
			await this.writeFileIfAbsent(sharedWorkPath, subst("", ""));
		}

		let count = 0;
		for (const memberId of def.targetMembers) {
			const member = s.members.find((m) => m.memberId === memberId && m.provisioned);
			if (!member) continue;
			// 기존 상태가 있으면 생애주기(state/grade/제출시각)와 작업 경로를 보존(수정 재배포 시 제출 초기화 방지).
			const existing = await this.d.memberSyncByRemoteDb(member.remoteDb)?.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(def.uid, memberId));
			let workPaths: string[];
			if (existing && !existing.deleted && existing.workPaths?.length) {
				workPaths = existing.workPaths;
			} else if (def.privacy === "shared") {
				workPaths = sharedWorkPath ? [sharedWorkPath] : [];
			} else {
				const studentPath = `${assignmentWorkDir("mirror", "", homeFolder, slug)}/${templateName}`;
				const teacherPath = `${assignmentWorkDir("mirror", member.localRoot, homeFolder, slug)}/${templateName}`;
				await this.writeFileIfAbsent(teacherPath, subst(member.memberId, member.memberName));
				workPaths = [studentPath];
			}
			const base: AssignmentStateDoc = existing && !existing.deleted ? existing : {
				_id: assignmentStateId(def.uid, memberId),
				type: "assignment-state",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				assignmentUid: def.uid,
				memberId,
				title: def.title,
				workPaths,
				state: "assigned",
				assignedAtMs: Date.now(),
			};
			const stateDoc: AssignmentStateDoc = {
				...base,
				title: def.title,
				workPaths,
				dueAt: def.dueAt,
				maxPoints: def.rubric ? rubricMax(def.rubric) : def.points,
				deleted: undefined,
			};
			const r = await admin.putDoc(member.remoteDb, stateDoc);
			if (!r.ok) this.d.logger.error(t("dashboard.assignment_distribute_failed", { id: memberId, err: r.error ?? "" }));
			else count++;
		}
		this.d.logger.ok(t("dashboard.assignment_distributed", { title: def.title, count }), true);
		this.d.requestApply();
	}

	async listMyAssignments(): Promise<AssignmentStateDoc[]> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return [];
		const docs = await sync.ctx.pouch.allDocsByPrefix<AssignmentStateDoc>(ASSIGNMENT_STATE_ID_PREFIX);
		return docs.filter((d) => !d.deleted);
	}

	async listAssignmentStates(uid: string): Promise<AssignmentStateDoc[]> {
		const def = this.assignmentDefs().find((d) => d.uid === uid);
		if (!def) return [];
		const out: AssignmentStateDoc[] = [];
		for (const memberId of def.targetMembers) {
			const member = this.d.settings().members.find((m) => m.memberId === memberId);
			if (!member) continue;
			const sync = this.d.memberSyncByRemoteDb(member.remoteDb);
			if (!sync) continue;
			const doc = await sync.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(uid, memberId));
			if (doc && !doc.deleted) out.push(doc);
		}
		return out;
	}

	async submitAssignment(stateDoc: AssignmentStateDoc): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		const vs = new VersionStore(sync.ctx);
		for (const p of stateDoc.workPaths) {
			const dbPath = sync.ctx.toDbPath(p);
			const content = await this.readVaultText(p);
			if (dbPath && content != null) await vs.snapshot(dbPath, content, "submit", 0);
		}
		const current = (await sync.ctx.pouch.get<AssignmentStateDoc>(stateDoc._id)) ?? stateDoc;
		await sync.ctx.pouch.put({ ...current, state: "submitted", submittedAtMs: Date.now() });
		this.d.logger.ok(t("dashboard.assignment_submitted", { title: stateDoc.title }), true);
		return true;
	}

	async unsubmitAssignment(stateDoc: AssignmentStateDoc): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		const current = await sync.ctx.pouch.get<AssignmentStateDoc>(stateDoc._id);
		if (!current || current.state === "returned") return false;
		await sync.ctx.pouch.put({ ...current, state: "assigned", submittedAtMs: undefined });
		return true;
	}

	async openVaultPath(path: string): Promise<void> {
		const f = this.d.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.d.app.workspace.getLeaf(false).openFile(f, { active: true });
	}

	async returnAssignment(uid: string, memberId: string, grade: AssignmentGrade): Promise<boolean> {
		if (this.d.settings().role !== "manager") return false;
		const member = this.d.settings().members.find((m) => m.memberId === memberId);
		if (!member) return false;
		const sync = this.d.memberSyncByRemoteDb(member.remoteDb);
		if (!sync) return false;
		const cur = await sync.ctx.pouch.get<AssignmentStateDoc>(assignmentStateId(uid, memberId));
		if (!cur) return false;
		await sync.ctx.pouch.put({ ...cur, grade, state: "returned", returnedAtMs: Date.now() });
		this.d.requestApply();
		this.d.logger.ok(t("dashboard.assignment_returned", { name: member.memberName || memberId }), true);
		return true;
	}

	// --- 루틴(체크리스트) ---

	async listRoutines(): Promise<RoutineDoc[]> {
		const docs = await this.d.classroom.listByPrefix<RoutineDoc>(routinePrefix());
		const ord = (r: RoutineDoc): number => r.order ?? Number.MAX_SAFE_INTEGER;
		return docs.filter((d) => !d.deleted).sort((a, b) => ord(a) - ord(b) || a.createdAtMs - b.createdAtMs);
	}

	async reorderRoutines(orderedUids: string[]): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		for (let i = 0; i < orderedUids.length; i++) {
			const doc = await this.d.classroom.get<RoutineDoc>(routineId(orderedUids[i]));
			if (doc && doc.order !== i) await this.d.classroom.put({ ...doc, order: i });
		}
	}

	async createRoutine(input: {
		title: string;
		items: Array<{ label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }>;
	}): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		if (!this.d.homeroomReady()) {
			this.d.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return false;
		}
		const uid = `${Date.now().toString(36)}`;
		const doc: RoutineDoc = {
			_id: routineId(uid),
			type: "routine",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			uid,
			title: input.title,
			items: input.items.map((it, i) => ({
				id: `i${i}`,
				label: it.label,
				recurrence: it.recurrence,
				weekdays: it.recurrence === "weekly" ? it.weekdays : undefined,
			})),
			createdBy: s.userId,
			createdAtMs: Date.now(),
		};
		return this.d.classroom.put(doc);
	}

	async updateRoutine(
		uid: string,
		input: { title: string; items: Array<{ id?: string; label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }> },
	): Promise<boolean> {
		if (this.d.settings().role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		const existing = await this.d.classroom.get<RoutineDoc>(routineId(uid));
		if (!existing) return false;
		const used = new Set<string>();
		const items = input.items.map((it, idx) => {
			const id = it.id && !used.has(it.id) ? it.id : `g${Date.now().toString(36)}${idx}`;
			used.add(id);
			return {
				id,
				label: it.label,
				recurrence: it.recurrence,
				weekdays: it.recurrence === "weekly" ? it.weekdays : undefined,
			};
		});
		return this.d.classroom.put({ ...existing, title: input.title, items });
	}

	async deleteRoutine(uid: string): Promise<void> {
		const doc = await this.d.classroom.get<RoutineDoc>(routineId(uid));
		if (doc) await this.d.classroom.softDelete(doc);
	}

	async myRoutineState(uid: string, day: string): Promise<RoutineStateDoc | null> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return null;
		return sync.ctx.pouch.get<RoutineStateDoc>(routineStateId(uid, this.d.settings().userId, day));
	}

	async toggleRoutineItem(uid: string, day: string, itemId: string, checked: boolean): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		const id = routineStateId(uid, this.d.settings().userId, day);
		const cur = await sync.ctx.pouch.get<RoutineStateDoc>(id);
		const set = new Set(cur?.checked ?? []);
		if (checked) set.add(itemId);
		else set.delete(itemId);
		const doc: RoutineStateDoc = {
			_id: id,
			_rev: cur?._rev,
			type: "routine-state",
			schemaVersion: 1,
			workspaceId: this.d.settings().workspaceId,
			routineUid: uid,
			memberId: this.d.settings().userId,
			day,
			checked: [...set],
			updatedAtMs: Date.now(),
		};
		await sync.ctx.pouch.put(doc);
		return true;
	}

	async myRoutineDays(uid: string): Promise<RoutineStateDoc[]> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return [];
		return sync.ctx.pouch.allDocsByPrefix<RoutineStateDoc>(routineStatePrefix(uid, this.d.settings().userId));
	}

	async listRoutineStates(uid: string, day: string): Promise<RoutineStateDoc[]> {
		const out: RoutineStateDoc[] = [];
		for (const m of this.d.settings().members) {
			if (!m.memberId) continue;
			const sync = this.d.memberSyncByRemoteDb(m.remoteDb);
			if (!sync) continue;
			const doc = await sync.ctx.pouch.get<RoutineStateDoc>(routineStateId(uid, m.memberId, day));
			if (doc) out.push(doc);
		}
		return out;
	}

	// --- 응답(질문) + 통계 수집 ---

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

	async listAllAssignmentStates(): Promise<AssignmentStateDoc[]> {
		const out: AssignmentStateDoc[] = [];
		for (const m of this.d.settings().members) {
			if (!m.memberId) continue;
			const sync = this.d.memberSyncByRemoteDb(m.remoteDb);
			if (!sync) continue;
			out.push(...(await sync.ctx.pouch.allDocsByPrefix<AssignmentStateDoc>(ASSIGNMENT_STATE_ID_PREFIX)));
		}
		return out.filter((d) => !d.deleted);
	}

	async listAllRoutineStates(): Promise<RoutineStateDoc[]> {
		const out: RoutineStateDoc[] = [];
		for (const m of this.d.settings().members) {
			if (!m.memberId) continue;
			const sync = this.d.memberSyncByRemoteDb(m.remoteDb);
			if (!sync) continue;
			out.push(...(await sync.ctx.pouch.allDocsByPrefix<RoutineStateDoc>(ROUTINE_STATE_ID_PREFIX)));
		}
		return out;
	}
}
