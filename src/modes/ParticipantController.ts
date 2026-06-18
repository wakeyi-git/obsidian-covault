import { App } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";
import { RealtimeManager } from "../core/realtime/RealtimeManager";
import { RtPartDoc, rtPartId, RTPART_ID_PREFIX, RtRequestDoc, rtRequestId, RTREQUEST_ID_PREFIX } from "../core/model/types";
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
	/** 실시간 인가 기본값(rtcontrol)을 공유 공간 DB에 기록 — Hocuspocus 서버가 즉시 재인가. */
	writeRtControl(): Promise<void>;
	/** validate(v3) 전체 재배포 — 읽기전용 토글을 서버 쓰기 규칙에 반영(지문 비교로 멱등). */
	redeployValidate(): Promise<void>;
	/** 한 DB의 validate 재배포를 디바운스 예약(참여자 변경 → 임베드 허용 명단 갱신). */
	requestValidateRedeploy(db: string): void;
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
	 * 파일별 실시간 참여 가능 여부(게이트).
	 * - 개인 mirror(교사↔구성원 1:1): **옵트인(rtpart 지정)이 있을 때만** 실시간. 없으면 파일 동기화만 한다 —
	 *   mirror 폴더 전체가 자동 실시간이 되어 텍스트↔CRDT 재조정으로 노트가 중복 누적되던 문제를 차단(교사·학생 동일).
	 * - 공유/홈룸: 교사 전원 허용, 구성원은 참여자 지정 문서가 허용 명단(없으면 읽기전용=아무도/해제=전원).
	 */
	async canEditRealtime(path: string): Promise<boolean> {
		const s = this.d.settings();
		const sync = this.d.findSyncOwning(path);
		if (!sync) return true; // 동기화 대상 아님(로컬 전용) — 게이팅 없음
		const dbPath = sync.ctx.toDbPath(path);
		if (!dbPath) return true;

		if (this.d.realtime().isMirrorPath(path)) {
			const doc = await sync.ctx.pouch.get<RtPartDoc>(rtPartId(dbPath)).catch(() => null);
			if (!doc || doc.deleted || !Array.isArray(doc.memberIds) || doc.memberIds.length === 0) return false; // 미옵트인
			return s.role === "manager" || doc.memberIds.includes(s.userId); // 교사는 지정되면 참여, 학생은 명단에 있을 때만
		}

		if (s.role === "manager") return true; // 공유 파일: 교사는 모든 세션 참관/편집 가능
		try {
			const doc = await sync.ctx.pouch.get<RtPartDoc>(rtPartId(dbPath));
			return memberAllowed(doc, s.userId, !!s.sharedReadOnly);
		} catch {
			return memberAllowed(null, s.userId, !!s.sharedReadOnly); // 지정 문서 없음 → 기본값
		}
	}

	/** 파일이 개인 mirror(1:1) 공간 파일인가 — 패널이 1:1 토글 카드를 띄울지 판단. */
	isMirrorFile(path: string): boolean {
		return this.d.realtime().isMirrorPath(path);
	}

	/**
	 * mirror(1:1) 파일의 실시간 옵트인 토글(교사). on=해당 구성원을 참여자로 지정해 라이브 지도 시작(학생 자동 합류),
	 * off=지정 해제(즉시 종료). 공유 파일 참여자 지정과 같은 rtpart 경로를 쓴다.
	 */
	async setMirrorRealtime(path: string, on: boolean): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") return false;
		const memberId = this.d.realtime().mirrorMemberIdFor(path);
		if (!memberId) {
			this.d.logger.warn(t("realtime.one_to_one_not_mirror"), true);
			return false;
		}
		await this.setFileRealtimeParticipants(path, on ? [memberId] : null);
		return true;
	}

	/**
	 * mirror 1:1 세션을 이 기기의 마지막 참여자가 닫아 종료했을 때 호출(RealtimeManager.onMirrorClosedAlone).
	 * 교사면 rtpart 옵트인을 해제해 1:1을 끝낸다(자동 만료, 유예 0). rtpart는 교사 전용 쓰기라 학생 측에선 무동작.
	 */
	async onMirrorSessionClosedAlone(path: string): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const cur = await this.getFileRealtimeParticipants(path);
		if (cur && cur.length > 0) await this.setFileRealtimeParticipants(path, null);
	}

	/**
	 * 1:1 라이브 지도 요청 토글(구성원). on=내 mirror 파일에 요청(rtrequest)을 남긴다 — 교사 기기가 rtpart로 자동 승인해
	 * 세션이 시작되고 양쪽이 자동 합류한다. off=요청 취소. 교사 전용인 rtpart를 학생이 못 쓰므로 요청 문서를 거친다.
	 */
	async requestMirrorRealtime(path: string, on: boolean): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "member") return false;
		const sync = this.d.findSyncOwning(path);
		if (!sync) return false;
		const dbPath = sync.ctx.toDbPath(path);
		if (!dbPath) return false;
		const id = rtRequestId(dbPath);
		if (!on) {
			const ex = await sync.ctx.pouch.get<RtRequestDoc>(id).catch(() => null);
			if (ex && !ex.deleted) await sync.ctx.pouch.put({ ...ex, deleted: true });
		} else {
			await sync.ctx.pouch.put({
				_id: id,
				type: "rtrequest",
				schemaVersion: 1,
				workspaceId: s.workspaceId,
				dbPath,
				byUser: s.userId,
				byUsername: s.username,
				createdAtMs: Date.now(),
			} as RtRequestDoc);
		}
		sync.ctx.notifyLocalWrite?.();
		return true;
	}

	/** 내가 1:1 지도를 요청한(대기 중) 파일 경로 목록(구성원 UI 상태). */
	async listMyMirrorRequests(): Promise<string[]> {
		const s = this.d.settings();
		const out: string[] = [];
		for (const sync of this.d.getSyncs()) {
			let docs: RtRequestDoc[];
			try {
				docs = await sync.ctx.pouch.allDocsByPrefix<RtRequestDoc>(RTREQUEST_ID_PREFIX);
			} catch {
				continue;
			}
			for (const d of docs) {
				if (!d || d.deleted || d.byUser !== s.userId || !d.dbPath) continue;
				out.push(sync.ctx.toLocalPath(d.dbPath));
			}
		}
		return out;
	}

	/**
	 * 대기 중인 1:1 라이브 지도 요청 처리(교사) — 각 요청을 rtpart 참여자 지정으로 승인하고 요청 문서를 정리한다.
	 * onRtRequestChange(수신)·시작 시 호출. 고아 요청(파일 없음)은 승인 없이 정리만.
	 */
	async processMirrorRequests(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		for (const sync of this.d.getSyncs()) {
			let docs: RtRequestDoc[];
			try {
				docs = await sync.ctx.pouch.allDocsByPrefix<RtRequestDoc>(RTREQUEST_ID_PREFIX);
			} catch {
				continue;
			}
			for (const d of docs) {
				if (!d || d.deleted || !d.byUser || !d.dbPath) continue;
				const path = sync.ctx.toLocalPath(d.dbPath);
				if (this.d.app.vault.getAbstractFileByPath(path)) {
					const cur = await this.getFileRealtimeParticipants(path);
					if (!cur || !cur.includes(d.byUser)) await this.setFileRealtimeParticipants(path, [d.byUser]);
				}
				await sync.ctx.pouch.put({ ...d, deleted: true }).catch(() => {}); // 승인(또는 고아) 후 요청 정리
			}
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
		await this.d.writeRtControl(); // 서버 인가 기본값 갱신(rtcontrol) → 활성 연결 재인가
		// 서버 쓰기 규칙(validate)에도 반영 — 켜면 비참여자의 note/asset 쓰기가 서버에서 거부된다(H-5).
		// 켜는 방향도 즉시 안전: 세션 참여자(rtpart)는 임베드 허용 명단에 있어 보증 업로드가 통과한다.
		await this.d.redeployValidate();
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
		sync.ctx.notifyLocalWrite?.(); // 이벤트 구동 동기화: rtpart 변경을 바로 원격에 push
		// 읽기전용일 때만 의미 있음 — validate 임베드 허용 명단 갱신(20초 디바운스, 원격 전파 유예 겸함).
		if (s.sharedReadOnly) this.d.requestValidateRedeploy(sync.ctx.remoteDb);
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
		oldSync.ctx.notifyLocalWrite?.();
		newSync?.ctx.notifyLocalWrite?.();
		if (s.sharedReadOnly) {
			this.d.requestValidateRedeploy(oldSync.ctx.remoteDb);
			if (newSync && newSync.ctx.remoteDb !== oldSync.ctx.remoteDb) this.d.requestValidateRedeploy(newSync.ctx.remoteDb);
		}
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
		sync.ctx.notifyLocalWrite?.();
		if (s.sharedReadOnly && doc && !doc.deleted) this.d.requestValidateRedeploy(sync.ctx.remoteDb);
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
