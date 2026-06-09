import { App } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";
import { RealtimeManager } from "../core/realtime/RealtimeManager";
import { RtPartDoc, rtPartId, RTPART_ID_PREFIX } from "../core/model/types";
import { memberAllowed, visibleToUser, memberNameMap, nameBackfillNeeded } from "../core/realtime/participants";
import { t } from "../i18n";

/**
 * 실시간 참여 게이트 + 파일별 참여자 + 공유 읽기전용 + 세션 조회 컨트롤러.
 * RtPartDoc(파일별 참여자 지정)를 읽고 쓰며, 순수 판단은 core/realtime/participants에 위임한다(거동 동일).
 */
export interface ParticipantDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	realtime(): RealtimeManager;
	getSyncs(): MirrorSync[];
	findSyncOwning(localPath: string): MirrorSync | undefined;
	/** 현재 사용자의 공유 공간(토큰 수신 판단용). */
	sharedSpaces(): Array<{ token?: string }>;
	saveSettings(): Promise<void>;
	/** 공유 읽기전용 변경을 rtconfig로 구성원에 전파. */
	refreshMemberShares(): Promise<void>;
}

export class ParticipantController {
	constructor(private d: ParticipantDeps) {}

	/** 실시간 공간 토큰을 하나라도 수신했는지(구성원: shares로 자동 전달됨). */
	realtimeTokenReceived(): boolean {
		return this.d.sharedSpaces().some((sp) => !!sp.token);
	}

	/** 현재(이 기기) 활성 실시간 세션 목록. */
	realtimeSessions(): Array<{ path: string; participants: number }> {
		return this.d.realtime().activeSessions();
	}

	/** 현재 활성 파일의 실시간 세션 정보(없으면 null). */
	realtimeActiveFile(): { path: string; participants: number } | null {
		const f = this.d.app.workspace.getActiveFile();
		const rt = this.d.realtime();
		if (!f || !rt.isActive(f.path)) return null;
		return { path: f.path, participants: rt.presenceFor(f.path) };
	}

	/**
	 * 파일별 실시간 참여 가능 여부(게이트). 교사·개인 mirror(1:1)는 항상 허용.
	 * 공유 공간 파일은 '참여자 지정 문서'가 허용 명단 — 없으면 읽기전용=아무도/해제=전원.
	 */
	async canEditRealtime(path: string): Promise<boolean> {
		const s = this.d.settings();
		if (s.role === "manager") return true; // 교사는 모든 세션 참관/편집 가능
		const sync = this.d.findSyncOwning(path);
		if (!sync) return true;
		if (sync.ctx.remoteDb === s.remoteDb) return true; // 개인 mirror(교사 1:1)는 게이팅 없음
		const dbPath = sync.ctx.toDbPath(path);
		if (!dbPath) return true;
		try {
			const doc = await sync.ctx.pouch.get<RtPartDoc>(rtPartId(dbPath));
			return memberAllowed(doc, s.userId, !!s.sharedReadOnly);
		} catch {
			return memberAllowed(null, s.userId, !!s.sharedReadOnly); // 지정 문서 없음 → 기본값
		}
	}

	/** 파일의 실시간 참여자 명단(null=전원/미지정). */
	async getFileRealtimeParticipants(path: string): Promise<string[] | null> {
		const sync = this.d.findSyncOwning(path);
		if (!sync) return null;
		const dbPath = sync.ctx.toDbPath(path);
		if (!dbPath) return null;
		try {
			const doc = await sync.ctx.pouch.get<RtPartDoc>(rtPartId(dbPath));
			return doc && !doc.deleted ? doc.memberIds : null;
		} catch {
			return null;
		}
	}

	/**
	 * 참여자가 지정된 공유 파일 목록(닫혀 있어도 유지해 재오픈). 교사는 전부, 구성원은 자신 지정분만.
	 */
	async listRealtimeFiles(): Promise<Array<{ path: string; memberIds: string[]; memberNames?: Record<string, string> }>> {
		const s = this.d.settings();
		const out: Array<{ path: string; memberIds: string[]; memberNames?: Record<string, string> }> = [];
		const seen = new Set<string>();
		for (const sync of this.d.getSyncs()) {
			let docs: RtPartDoc[];
			try {
				docs = await sync.ctx.pouch.allDocsByPrefix<RtPartDoc>(RTPART_ID_PREFIX);
			} catch {
				continue;
			}
			for (const d of docs) {
				if (!d || d.deleted || !Array.isArray(d.memberIds)) continue;
				if (!visibleToUser(d.memberIds, s.userId, s.role)) continue;
				const path = sync.ctx.toLocalPath(d.dbPath);
				if (seen.has(path)) continue;
				// 존재하지 않는 파일(이름변경·삭제로 생긴 고아 지정 문서)은 유령 카드가 되므로 제외.
				if (!this.d.app.vault.getAbstractFileByPath(path)) continue;
				seen.add(path);
				out.push({ path, memberIds: d.memberIds, memberNames: d.memberNames });
			}
		}
		return out;
	}

	/** 공유 파일 읽기 전용 정책 토글(교사). 켜면 구성원은 실시간 세션 활성 파일만 편집 가능. */
	async setSharedReadOnly(on: boolean): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		s.sharedReadOnly = on;
		await this.d.saveSettings();
		await this.d.refreshMemberShares(); // rtconfig로 전 구성원에 전파
		this.d.realtime().syncOpenEditors();
	}

	/** 파일별 실시간 참여자 지정(교사). null=전원(지정 해제). */
	async setFileRealtimeParticipants(path: string, memberIds: string[] | null): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const sync = this.d.findSyncOwning(path);
		if (!sync) {
			this.d.logger.warn(t("realtime.part_not_shared"), true);
			return;
		}
		const dbPath = sync.ctx.toDbPath(path);
		if (!dbPath) return;
		const id = rtPartId(dbPath);
		if (memberIds === null) {
			const existing = await sync.ctx.pouch.get<RtPartDoc>(id).catch(() => null);
			if (existing && !existing.deleted) await sync.ctx.pouch.put({ ...existing, deleted: true, updatedAtMs: Date.now() });
		} else {
			// 이름도 함께 저장 — 학생은 동료 명단이 없으므로 문서의 이름으로 카드에 표시.
			const memberNames = memberNameMap(memberIds, s.members);
			await sync.ctx.pouch.put({
				_id: id,
				type: "rtpart",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				dbPath,
				memberIds,
				memberNames,
				updatedAtMs: Date.now(),
				updatedBy: s.userId,
			} as RtPartDoc);
		}
		this.d.realtime().invalidateParticipants(path);
	}

	/** 파일 이름 변경 시 지정 문서를 옛 dbPath → 새 dbPath로 이전(멤버/이름 보존). 교사만. */
	async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return; // 지정은 교사가 관리. 다른 기기엔 동기화로 전달됨.
		const oldSync = this.d.findSyncOwning(oldPath);
		const oldDbPath = oldSync?.ctx.toDbPath(oldPath);
		if (!oldSync || !oldDbPath) return;
		const oldDoc = await oldSync.ctx.pouch.get<RtPartDoc>(rtPartId(oldDbPath)).catch(() => null);
		if (!oldDoc || oldDoc.deleted || !Array.isArray(oldDoc.memberIds)) return;

		// 새 위치에 먼저 기록(실패해도 옛 지정을 잃지 않게), 그다음 옛 문서 정리.
		const newSync = this.d.findSyncOwning(newPath);
		const newDbPath = newSync?.ctx.toDbPath(newPath);
		if (newSync && newDbPath) {
			await newSync.ctx.pouch.put({
				_id: rtPartId(newDbPath),
				type: "rtpart",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				dbPath: newDbPath,
				memberIds: oldDoc.memberIds,
				memberNames: oldDoc.memberNames,
				updatedAtMs: Date.now(),
				updatedBy: s.userId,
			} as RtPartDoc);
		}
		await oldSync.ctx.pouch.put({ ...oldDoc, deleted: true, updatedAtMs: Date.now() }).catch(() => {});
		this.d.realtime().invalidateParticipants(oldPath);
		this.d.realtime().invalidateParticipants(newPath);
	}

	/** 파일 삭제 시 지정 문서 정리(soft-delete). 교사만. */
	async onFileDeleted(path: string): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const sync = this.d.findSyncOwning(path);
		const dbPath = sync?.ctx.toDbPath(path);
		if (!sync || !dbPath) return;
		const doc = await sync.ctx.pouch.get<RtPartDoc>(rtPartId(dbPath)).catch(() => null);
		if (doc && !doc.deleted) await sync.ctx.pouch.put({ ...doc, deleted: true, updatedAtMs: Date.now() }).catch(() => {});
		this.d.realtime().invalidateParticipants(path);
	}

	/** 이전 버전 rtpart 문서(memberNames 없음)에 이름을 채운다(교사). 학생은 동료 명단이 없어 문서 이름에 의존. */
	async backfillRtPartNames(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		for (const sync of this.d.getSyncs()) {
			let docs: RtPartDoc[];
			try {
				docs = await sync.ctx.pouch.allDocsByPrefix<RtPartDoc>(RTPART_ID_PREFIX);
			} catch {
				continue;
			}
			for (const d of docs) {
				if (!d || d.deleted || !Array.isArray(d.memberIds)) continue;
				const names = memberNameMap(d.memberIds, s.members);
				if (nameBackfillNeeded(d.memberIds, d.memberNames, names)) {
					await sync.ctx.pouch.put({ ...d, memberNames: names, updatedAtMs: Date.now() }).catch(() => {});
				}
			}
		}
	}
}
