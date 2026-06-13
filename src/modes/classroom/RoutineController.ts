import {
	RoutineDoc,
	RoutineStateDoc,
	routineId,
	routinePrefix,
	routineStateId,
	routineStatePrefix,
	ROUTINE_STATE_ID_PREFIX,
} from "../../core/model/types";
import { t } from "../../i18n";
import { ClassroomDeps, collectFromMemberMirrors } from "./deps";

/**
 * 루틴(체크리스트) 도메인 — 루틴 CRUD + 일일/주간 체크 상태. 평가 P2-3: ClassroomController에서 분리(거동 불변).
 */
export class RoutineController {
	constructor(private d: ClassroomDeps) {}

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

	async listAllRoutineStates(): Promise<RoutineStateDoc[]> {
		return collectFromMemberMirrors<RoutineStateDoc>(this.d, ROUTINE_STATE_ID_PREFIX, { includeDeleted: true });
	}
}
