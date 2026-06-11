import { Role } from "../settings/types";
import { SyncDirection } from "../core/sync/FullSync";
import { MirrorSync } from "../core/sync/MirrorSync";

/** 역할별 mode 공통 인터페이스. 기술문서 §23.3. Manager는 다중 학생이므로 메서드로 노출. */
export interface CoVaultMode {
	readonly role: Role;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 수동 전체 동기화 (Manager는 전체 학생에 적용). */
	fullSync(direction: SyncDirection): Promise<void>;
	/** 이 모드의 동기화 링크들 (Member=1, Manager=학생 수). 충돌 목록 집계 등에 사용. */
	getSyncs(): MirrorSync[];
	/** remoteDb로 동기화 링크 찾기(복구·DM·홈룸·스냅샷 등 공용). */
	findSyncByDb(db: string): MirrorSync | undefined;
	/** 로컬 경로를 담당(owns)하는 동기화 링크 찾기. */
	findSyncOwning(localPath: string): MirrorSync | undefined;
	/** 공유 공간 shares 재조회(Member 전용). Manager는 미구현(undefined). */
	refreshShares?(): Promise<void>;
	/** 백그라운드 전환 알림(선택). Manager의 통합 변경 감지 연결을 함께 멈추고/재개한다. */
	onVisibility?(hidden: boolean): void;
}
