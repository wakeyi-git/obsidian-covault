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
	/** 공유 공간 shares 재조회(Member 전용). Manager는 미구현(undefined). */
	refreshShares?(): Promise<void>;
}
