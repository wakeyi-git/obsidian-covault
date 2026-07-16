import { CouchAdmin } from "../../core/couch/CouchAdmin";
import { VersionStore } from "../../core/sync/VersionStore";
import { defaultTemplate, applyNoticeVars } from "../../core/classroom/templates";
import { assignmentWorkDir, assignmentFileName, substituteTemplate, slugify, rubricMax } from "../../core/classroom/assignments";
import {
	AssignmentDoc,
	AssignmentStateDoc,
	AssignmentGrade,
	assignmentId,
	assignmentStateId,
	ASSIGNMENT_STATE_ID_PREFIX,
	RubricCriterion,
} from "../../core/model/types";
import { t } from "../../i18n";
import { ClassroomDeps, readVaultText, writeFileIfAbsent, openVaultPath, collectFromMemberMirrors } from "./deps";

/**
 * 과제 도메인 — 정의 CRUD, 학생 미러 배포, 제출/채점/반환, 보관. 평가 P2-3: ClassroomController에서 분리(거동 불변).
 */
export class AssignmentController {
	constructor(private d: ClassroomDeps) {}

	/** vault 경로를 편집창에서 연다(과제 작업 파일 열기 등 — PanelHost.openVaultPath). */
	async openVaultPath(path: string): Promise<void> {
		await openVaultPath(this.d, path);
	}

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
	async updateAssignment(uid: string, input: Parameters<AssignmentController["createAssignment"]>[0]): Promise<boolean> {
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
				await admin.updateDoc<AssignmentStateDoc>(member.remoteDb, assignmentStateId(uid, memberId), (cur) =>
					cur && !cur.deleted ? { ...cur, deleted: true } : null,
				);
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
		const templateContent = tplPath ? (await readVaultText(this.d, tplPath)) ?? defaultTemplate("assignment") : defaultTemplate("assignment");
		const templateName = tplPath?.split("/").pop() || `${t("dashboard.template_name_assignment")}.md`;
		const fileName = assignmentFileName(slug, templateName);
		const subst = (memberId: string, memberName: string): string =>
			substituteTemplate(applyNoticeVars(templateContent, { title: def.title, date }), { memberId, memberName, workspaceId: s.workspaceId, date });
		const homeFolder = this.d.homeroomFolder() ?? "";
		const workLabel = t("dashboard.subfolder_assignment"); // 현지화된 과제 폴더명(평가 P1-1)

		let sharedWorkPath: string | null = null;
		if (def.privacy === "shared") {
			sharedWorkPath = `${assignmentWorkDir("shared", "", homeFolder, workLabel)}/${fileName}`;
			await writeFileIfAbsent(this.d, sharedWorkPath, subst("", ""));
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
				// 학생 경로(root="")는 상태 문서에 저장, 교사 경로(member.localRoot)에는 작업 파일을 만든다.
				await writeFileIfAbsent(this.d, `${assignmentWorkDir("mirror", member.localRoot, homeFolder, workLabel)}/${fileName}`, subst(member.memberId, member.memberName));
				workPaths = [`${assignmentWorkDir("mirror", "", homeFolder, workLabel)}/${fileName}`];
			}
			const id = assignmentStateId(def.uid, memberId);
			const assignedAtMs = Date.now();
			const r = await admin.updateDoc<AssignmentStateDoc>(member.remoteDb, id, (remoteCurrent) => {
				const base: AssignmentStateDoc = remoteCurrent && !remoteCurrent.deleted ? remoteCurrent : {
					_id: id,
					type: "assignment-state",
					schemaVersion: 1,
					workspaceId: s.workspaceId,
					assignmentUid: def.uid,
					memberId,
					title: def.title,
					workPaths,
					state: "assigned",
					assignedAtMs,
				};
				return {
					...base,
					title: def.title,
					workPaths: remoteCurrent && !remoteCurrent.deleted && remoteCurrent.workPaths?.length ? remoteCurrent.workPaths : workPaths,
					dueAt: def.dueAt,
					maxPoints: def.rubric ? rubricMax(def.rubric) : def.points,
					deleted: undefined,
					archivedAtMs: def.archivedAtMs,
				};
			});
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
			const content = await readVaultText(this.d, p);
			if (dbPath && content != null) await vs.snapshot(dbPath, content, "submit", 0);
		}
		const submittedAtMs = Date.now();
		const updated = await sync.ctx.pouch.update<AssignmentStateDoc>(stateDoc._id, (current) => {
			const base = current ?? stateDoc;
			if (base.deleted || base.state === "returned") return null;
			return { ...base, state: "submitted", submittedAtMs };
		});
		if (!updated) return false;
		this.d.logger.ok(t("dashboard.assignment_submitted", { title: stateDoc.title }), true);
		return true;
	}

	async unsubmitAssignment(stateDoc: AssignmentStateDoc): Promise<boolean> {
		const sync = this.d.studentMirrorSync();
		if (!sync) return false;
		const updated = await sync.ctx.pouch.update<AssignmentStateDoc>(stateDoc._id, (current) => {
			if (!current || current.deleted || current.state === "returned") return null;
			return { ...current, state: "assigned", submittedAtMs: undefined };
		});
		return updated !== null;
	}

	/**
	 * 과제 보관/해제(교사) — 정의에 archivedAtMs 기록 + 각 학생 상태 문서에 전파(복제로 도달).
	 * 미동기화 학생(상태 문서 미수신)은 건너뛰고 경고만 — 이후 편집·재배포 시 정의 기준으로 재수렴된다.
	 */
	async archiveAssignment(uid: string, archived: boolean): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return false;
		}
		const defs = s.assignments ?? [];
		const def = defs.find((d) => d.uid === uid);
		if (!def) return false;
		const archivedAtMs = archived ? Date.now() : undefined;
		s.assignments = defs.map((d) => (d.uid === uid ? { ...d, archivedAtMs } : d));
		await this.d.saveSettings();
		let failed = 0;
		for (const memberId of def.targetMembers) {
			const member = s.members.find((m) => m.memberId === memberId);
			const sync = member ? this.d.memberSyncByRemoteDb(member.remoteDb) : null;
			if (!sync) {
				failed++;
				continue;
			}
			const updated = await sync.ctx.pouch.update<AssignmentStateDoc>(assignmentStateId(uid, memberId), (cur) =>
				cur && !cur.deleted ? { ...cur, archivedAtMs } : null,
			);
			if (!updated) failed++;
		}
		this.d.requestApply();
		this.d.logger.ok(archived ? t("dashboard.assignment_archived", { title: def.title }) : t("dashboard.assignment_unarchived", { title: def.title }), true);
		if (failed > 0) this.d.logger.warn(t("dashboard.archive_partial", { n: failed }), true);
		return true;
	}

	async returnAssignment(uid: string, memberId: string, grade: AssignmentGrade): Promise<boolean> {
		if (this.d.settings().role !== "manager") return false;
		const member = this.d.settings().members.find((m) => m.memberId === memberId);
		if (!member) return false;
		const sync = this.d.memberSyncByRemoteDb(member.remoteDb);
		if (!sync) return false;
		const returnedAtMs = Date.now();
		const updated = await sync.ctx.pouch.update<AssignmentStateDoc>(assignmentStateId(uid, memberId), (cur) =>
			cur && !cur.deleted ? { ...cur, grade, state: "returned", returnedAtMs } : null,
		);
		if (!updated) return false;
		this.d.requestApply();
		this.d.logger.ok(t("dashboard.assignment_returned", { name: member.memberName || memberId }), true);
		return true;
	}

	async listAllAssignmentStates(): Promise<AssignmentStateDoc[]> {
		return collectFromMemberMirrors<AssignmentStateDoc>(this.d, ASSIGNMENT_STATE_ID_PREFIX);
	}
}
