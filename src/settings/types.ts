import { AssignmentDoc } from "../core/model/types";

export type Role = "member" | "manager";

export type ConflictPolicy = "preserve-local";

/** 삭제/이름변경 시 상대 vault 처리. 기술문서 §15. */
export type DeletePolicy = "archive" | "propagate-delete" | "ignore-delete";

/** 공유 공간(모둠/학급 공유). 전용 DB를 멤버 학생들이 함께 동기화. */
export interface SharedSpace {
	id: string; // 고유 id
	name: string; // 표시명 (모둠1)
	remoteDb: string; // share_<id>
	folder: string; // 각 vault 내 폴더명
	members: string[]; // memberId[]
	provisioned?: boolean;
	/** 공간 종류. "homeroom"=학급 운영 대시보드(알림장·시간표·루틴 등)를 담는 전원 공유 공간. 미설정=일반 모둠 공유. */
	kind?: "homeroom";
	/** 이 공간의 실시간 서명 토큰(HMAC 모드). 실시간 사용 시 배포에서 발급되어 shares 문서로 학생에 전달된다. */
	token?: string;
	/** 마지막 배포 시각(epoch ms). */
	lastDeployedAt?: number;
	/** 마지막 배포 시점의 멤버 스냅샷 — 이후 멤버가 바뀌면 ‘재배포 필요’ 배지. */
	lastMemberSnapshot?: string[];
}

/** 명명 그룹(교사가 만든 구성원 묶음). 그룹 대화방 + 라이브 세션 참가자 지정에 재사용. */
export interface GroupConfig {
	id: string; // uid
	name: string;
	memberIds: string[];
	/** 임시 그룹(세션 카드에서 즉석 생성) — 그룹 관리 UI에는 숨기고 대화방 목록에서 삭제. */
	temp?: boolean;
}

/** 교사가 관리하는 학생 1명. 기술문서 §12.1. */
export interface MemberConfig {
	memberId: string;
	memberName: string;
	remoteDb: string; // 기본 mirror_<memberId>
	localRoot: string; // 교사 vault 내 학생 폴더 (예: 학생A)
	username: string; // 학생 CouchDB 계정명. 기본 memberId
	password?: string; // 프로비저닝 시 생성 (교사 기기 한정 비밀)
	provisioned?: boolean; // CouchDB 계정/DB/권한 생성 완료 여부
	/** 개인 mirror 1:1 실시간 서명 토큰(HMAC). 전역 실시간 사용 시 배포에서 발급되어 학생 shares로 전달(교사 기기 한정). */
	realtimeToken?: string;
	/** 이 구성원만 실시간 편집 차단(전역 실시간이 켜져 있어도 토큰 미발급 → 파일 동기화만, 라이브 세션 제외). */
	realtimeBlocked?: boolean;
}

/**
 * CoVault 설정. 기술문서 §5.1 / §11.1 / §12.1.
 * 학생 모드는 localRoot 1건(개인 vault), 교사 모드는 members[] 다중 링크 + sharedSpaces[]로 동작한다.
 */
export interface CoVaultSettings {
	/** 최초 1회 역할 선택 완료 여부. true면 역할이 잠긴다(기술문서 §5.4 보강). */
	setupComplete: boolean;
	/** 교사 온보딩 마법사 완료/닫기 여부. true면 역할 선택 후 마법사를 자동으로 띄우지 않는다. */
	managerOnboardingDone?: boolean;

	role: Role;
	workspaceId: string;
	userId: string;
	displayName: string;
	deviceId: string;

	couchdbUrl: string;
	/** Manager: 관리자 계정 / Member: 초대로 받은 학생 계정. */
	username: string;
	password: string;
	/** Member 전용: 자기 mirror DB. Manager는 members[]가 구동. */
	remoteDb: string;

	/**
	 * Member Mode: vault root 기준 동기화 root ("" = vault 전체)
	 * Manager Mode는 미사용(members[].localRoot 사용)
	 */
	localRoot: string;

	/** Manager Mode: 관리 학생 목록. 기술문서 §12.1. */
	members: MemberConfig[];

	/** Manager Mode: 공유 공간 목록(모둠/학급 공유). */
	sharedSpaces: SharedSpace[];

	/** Manager Mode: 명명 그룹(구성원 묶음). 그룹 대화방 + 라이브 세션 참가자 지정에 사용. */
	groups: GroupConfig[];

	/** Manager Mode: 내 볼트 개인 동기화 사용 여부(개별/공동 공간·제외 폴더 제외한 나머지 노트·첨부). */
	personalSyncEnabled?: boolean;
	/** Manager Mode: 개인 동기화 DB명(기본 personal_<userId>). */
	personalRemoteDb?: string;

	/** Manager Mode: 과제 정의 목록(교사 기기 보관, 동기화 안 함). 배포 시 학생 미러에 상태 문서 생성. */
	assignments?: AssignmentDoc[];

	/** 새 알림장 본문 템플릿 파일 경로(vault 기준). 비우면 내장 기본 템플릿 사용. */
	noticeTemplate?: string;
	/** 새 수업 안내 본문 템플릿 파일 경로(vault 기준). 비우면 내장 기본 템플릿 사용. */
	lessonTemplate?: string;
	/** 과제 작업 파일 템플릿 파일 경로(vault 기준). 비우면 내장 기본 템플릿 사용. 모달에서 변경 가능. */
	assignmentTemplate?: string;

	/** 동기화 root 밖으로 취급해 제외할 폴더 (기술문서 §11.1). */
	excludeFolders: string[];

	/**
	 * 삭제 보관 폴더(보이는 폴더). 점(.)으로 시작하면 Obsidian이 추적하지 않으므로 보이는 이름을 쓴다.
	 * deletePolicy=archive일 때 삭제 파일이 여기로 이동하고, 이 폴더에서 지우면 DB에서도 purge된다.
	 */
	archiveFolder: string;

	/** 충돌 시 원격 버전을 꺼내 두는 보이는 폴더. 동기화 대상에서 제외된다. 기술문서 §14.3. */
	conflictFolder: string;

	/** 자동 동기화(로컬 watch + 원격 구독) 활성 여부. */
	autoSync: boolean;

	/** 첨부파일(비markdown) 동기화 여부. 기술문서 §8.2 / §24.6. */
	syncAssets: boolean;

	/** 첨부파일 최대 크기(MB). 초과 시 동기화 생략(모바일 보호). 0=무제한. */
	maxAttachmentMB: number;

	/** 편집 중 업로드 debounce(ms). 기술문서 §11.3. */
	debounceMs: number;

	/** 모바일에서의 업로드 debounce(ms). 배터리/네트워크 절감용으로 더 길게. 기술문서 §24.6. */
	mobileDebounceMs: number;

	/** 앱/창이 백그라운드로 가면 원격 replication을 일시정지(배터리/네트워크 절감). 기술문서 §24.6. */
	pauseWhenHidden: boolean;

	/** mirror DB별 로컬 changes 체크포인트(local seq). vault 적용 증분 재개에 사용. */
	lastSeqByDb: Record<string, string>;

	/** 충돌 정책: preserve-local(로컬 유지 + 원격본을 _충돌/에 보존, 충돌 목록 UI로 해소). */
	conflictPolicy: ConflictPolicy;

	/** 실시간 공동 편집(Yjs) — 공유 폴더 문서에만 적용. 기술문서 §19. */
	realtimeEnabled: boolean;
	yjsServerUrl: string; // wss://yjs.example.com
	/** Yjs 공간 시크릿(교사 전용, HMAC 키). 설정 시 공유 공간별 서명 토큰을 발급한다. 서버 YJS_SECRET와 동일. */
	yjsSecret?: string;
	/** 비밀값이 secretStorage에 저장됐는지 표시(평문 아님, data.json에 안전). UI/검증용. */
	yjsSecretSet?: boolean;
	/** CouchDB 비밀번호가 Secret Storage로 이전됨(평문 비움). UI 표시용. */
	passwordSet?: boolean;
	/** 공간 토큰 만료(일). 0/미설정=무만료. 주기적 재배포로 폐기하려면 값을 둔다. */
	yjsTokenTtlDays?: number;

	/**
	 * 실시간 서버 전용 CouchDB 서비스 계정명(교사). 배포 시 계정을 생성하고 모든 share/mirror DB의
	 * _security 멤버로 추가한다 → Hocuspocus 서버가 admin 비밀번호 없이 인가 조회·스냅샷 저장을 한다.
	 * 비밀번호는 Secret Storage(RT_SERVICE_PASSWORD_ID) 보관, 서버에는 env로 전달.
	 */
	rtServiceUsername?: string;
	/** 서비스 계정 비밀번호가 Secret Storage에 저장됐는지(UI 표시용). */
	rtServicePasswordSet?: boolean;

	/**
	 * 초대 코드 만료(일). 0=무만료. 발급 시 payload에 exp를 넣어, 만료된 QR/딥링크 적용을 차단한다.
	 * 장기 유효 비밀번호가 든 오래된 초대 노출을 줄인다(보고서 P2 완화).
	 */
	inviteTtlDays?: number;

	/** @deprecated 세션 중 스냅샷은 Hocuspocus 서버(STORE_DEBOUNCE_MS)가 담당 — 더는 사용되지 않음(설정 호환용 유지). */
	realtimeSnapshotSec: number;
	/** 공유 공간 파일을 구성원에게 읽기 전용으로 강제(실시간 세션 활성 파일만 편집 가능). 교사 설정 → rtconfig 전파. */
	sharedReadOnly?: boolean;

	/** UI 언어. auto=Obsidian 따름. */
	language: "auto" | "ko" | "en";

	/** 삭제/이름변경 시 상대 vault 처리 정책. 기술문서 §15. 기본 archive. */
	deletePolicy: DeletePolicy;

	/**
	 * 전체 동기화 시 한 번에 자동 tombstone(삭제 전파)할 최대 파일 수. 초과하면 보류하고 경고(폴더 오설정 사고 방지).
	 * 0/미설정 = 자동(max(5, manifest의 50%)). 의도적으로 많은 파일을 삭제했다면 값을 올린다.
	 */
	deleteReconcileMax?: number;

	/** 사용자용 버전 히스토리(마크다운 스냅샷) 사용 여부. 보고서 §1 P1. */
	versionHistory?: boolean;
	/** 파일당 최대 보존 버전 수(0=무제한 아님, 기본 10). */
	versionMaxCount?: number;
	/** 버전 최대 보존 일수(기본 30). 최근 N개 또는 N일 합집합으로 유지. */
	versionMaxAgeDays?: number;

	/** 학급 대시보드: 알림장/과제 한 화면 표시 개수(이후 "더 보기"). 기본 10. */
	dashboardPageSize?: number;
	/** 학급 대시보드: 모듈 카드 표시 순서(모듈 키 배열). 비면 기본 순서. */
	dashboardOrder?: string[];
	/** 학급 운영 모듈 활성화 플래그(학급 공동 공간 사용 시). 미설정=전부 활성. */
	classroomModules?: {
		notices?: boolean;
		lessons?: boolean;
		assignments?: boolean;
		routines?: boolean;
		gradebook?: boolean;
	};
}

export const DEFAULT_SETTINGS: CoVaultSettings = {
	setupComplete: false,

	role: "member",
	workspaceId: "ws_2026_1",
	userId: "member_a",
	displayName: "구성원A",
	deviceId: generateDeviceId(),

	couchdbUrl: "",
	username: "",
	password: "",
	remoteDb: "mirror_member_a",

	localRoot: "",
	members: [],
	sharedSpaces: [],
	groups: [],

	excludeFolders: [".obsidian", ".trash"],
	archiveFolder: "_삭제됨",
	conflictFolder: "_충돌",
	autoSync: true,
	syncAssets: true,
	maxAttachmentMB: 20,
	debounceMs: 2000,
	mobileDebounceMs: 4000,
	pauseWhenHidden: true,
	lastSeqByDb: {},
	conflictPolicy: "preserve-local",
	deletePolicy: "archive",
	deleteReconcileMax: 0,
	inviteTtlDays: 14,
	versionHistory: true,
	versionMaxCount: 10,
	versionMaxAgeDays: 30,
	realtimeEnabled: false,
	yjsServerUrl: "",
	realtimeSnapshotSec: 0,
	language: "auto",
	dashboardPageSize: 10,
	// 실시간 공간 토큰은 기본 30일 만료(주기 재배포로 회전). 0=무만료(설정에서 변경 가능).
	yjsTokenTtlDays: 30,
};

/** 기기별 고유 ID. 기술문서 §16.3 deviceId 기반 무시에 사용. */
export function generateDeviceId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `device_${Date.now().toString(36)}_${rand}`;
}
