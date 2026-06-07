import { App, TFile } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { ClassroomStore } from "../core/classroom/ClassroomStore";
import { MirrorSync } from "../core/sync/MirrorSync";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { VersionStore } from "../core/sync/VersionStore";
import { ensureParentFolders } from "../core/vault/folders";
import { noticeFilePath } from "../core/classroom/notices";
import { assignmentWorkDir, substituteTemplate, slugify, rubricMax } from "../core/classroom/assignments";
import {
	NoticeDoc,
	noticeId,
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

	// --- 알림장 / 수업 안내 ---

	/** 게시 본문 파일 + NoticeDoc 생성(교사). 성공 시 uid, 실패 시 null. weekKey는 수업 안내 주간 태그. */
	private async createPost(title: string, body: string, category: "notice" | "lesson", weekKey?: string): Promise<string | null> {
		if (this.d.settings().role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return null;
		}
		if (!this.d.homeroomReady()) {
			this.d.logger.warn(t("dashboard.homeroom_not_ready"), true);
			return null;
		}
		const folder = this.d.homeroomFolder();
		if (!folder) {
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
		await this.d.app.vault.create(path, `# ${title}\n\n${body}\n`);
		const uid = `${ts.toString(36)}`;
		const doc: NoticeDoc = {
			_id: noticeId(uid),
			type: "notice",
			schemaVersion: 1,
			workspaceId: this.d.settings().workspaceId,
			uid,
			title,
			filePath: path,
			postedAtMs: ts,
			allowResponses: true,
			category,
			weekKey: category === "lesson" ? weekKey : undefined,
			createdBy: this.d.settings().userId,
			createdByRole: "manager",
		};
		const ok = await this.d.classroom.put(doc);
		if (!ok) return null;
		this.d.logger.ok(t("dashboard.notice_posted", { title }), true);
		return uid;
	}

	async postNotice(title: string, body: string, category: "notice" | "lesson" = "notice", weekKey?: string): Promise<boolean> {
		return (await this.createPost(title, body, category, weekKey)) != null;
	}

	async createLesson(title: string, weekKey?: string): Promise<string | null> {
		return this.createPost(title, "", "lesson", weekKey);
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

	private async distributeAssignment(def: AssignmentDoc): Promise<void> {
		const s = this.d.settings();
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
		const slug = slugify(def.title);
		const date = new Date().toISOString().slice(0, 10);
		const templateContent = def.templatePaths[0] ? await this.readVaultText(def.templatePaths[0]) : null;
		const templateName = def.templatePaths[0]?.split("/").pop() || "과제.md";
		const fallback = `# ${def.title}\n\n${def.instructions || ""}\n`;
		const homeFolder = this.d.homeroomFolder() ?? "";

		let sharedWorkPath: string | null = null;
		if (def.privacy === "shared") {
			sharedWorkPath = `${assignmentWorkDir("shared", "", homeFolder, slug)}/${templateName}`;
			const body = templateContent != null ? substituteTemplate(templateContent, { memberId: "", memberName: "", workspaceId: s.workspaceId, date }) : fallback;
			await this.writeFileIfAbsent(sharedWorkPath, body);
		}

		let count = 0;
		for (const memberId of def.targetMembers) {
			const member = s.members.find((m) => m.memberId === memberId && m.provisioned);
			if (!member) continue;
			let workPaths: string[];
			if (def.privacy === "shared") {
				workPaths = sharedWorkPath ? [sharedWorkPath] : [];
			} else {
				const studentPath = `${assignmentWorkDir("mirror", "", homeFolder, slug)}/${templateName}`;
				const teacherPath = `${assignmentWorkDir("mirror", member.localRoot, homeFolder, slug)}/${templateName}`;
				const body = templateContent != null ? substituteTemplate(templateContent, { memberId: member.memberId, memberName: member.memberName, workspaceId: s.workspaceId, date }) : fallback;
				await this.writeFileIfAbsent(teacherPath, body);
				workPaths = [studentPath];
			}
			const stateDoc: AssignmentStateDoc = {
				_id: assignmentStateId(def.uid, memberId),
				type: "assignment-state",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				assignmentUid: def.uid,
				memberId,
				title: def.title,
				workPaths,
				dueAt: def.dueAt,
				state: "assigned",
				assignedAtMs: Date.now(),
				maxPoints: def.rubric ? rubricMax(def.rubric) : def.points,
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

	async postPrivateResponse(doc: ResponseDoc): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		await sync.ctx.pouch.put(doc);
		return true;
	}

	async listPrivateQuestions(): Promise<ResponseDoc[]> {
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
		return out.filter((d) => d.kind === "question" && !d.deleted);
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
