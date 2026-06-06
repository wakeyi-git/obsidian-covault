/** PouchDB/CouchDB 문서 공통 베이스. */
export interface PouchDocBase {
	_id: string;
	_rev?: string;
}

/** note 문서. 기술문서 §8.1 / 삭제 시 tombstone(§8.3). */
export interface NoteDoc extends PouchDocBase {
	type: "note";
	schemaVersion: number;
	workspaceId: string;
	memberId: string;
	path: string; // 학생 vault 기준 상대 경로 (DB path)
	content: string;
	contentHash: string;
	mtime: number;
	deleted: boolean;
	version: number;
	lastModifiedBy: string;
	lastModifiedRole: "member" | "manager";
	lastModifiedDeviceId: string;
	updatedAt: string;

	// tombstone 메타데이터 (deleted=true일 때, 기술문서 §8.3)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: "member" | "manager";
	deleteMode?: "archive" | "propagate-delete" | "ignore-delete";
}

export function noteId(dbPath: string): string {
	return `note:${dbPath}`;
}

/** asset(첨부파일) 문서. 바이너리는 PouchDB attachment("data")로 저장. 기술문서 §8.2. */
export interface AssetDoc extends PouchDocBase {
	type: "asset";
	schemaVersion: number;
	workspaceId: string;
	memberId: string;
	path: string; // 학생 vault 기준 상대 경로 (DB path)
	mime: string;
	size: number;
	contentHash: string;
	mtime: number;
	deleted: boolean;
	version: number;
	lastModifiedBy: string;
	lastModifiedRole: "member" | "manager";
	lastModifiedDeviceId: string;
	updatedAt: string;

	// tombstone (deleted=true일 때)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: "member" | "manager";
	deleteMode?: "archive" | "propagate-delete" | "ignore-delete";
}

export function assetId(dbPath: string): string {
	return `asset:${dbPath}`;
}

/** 사용자용 버전 히스토리 스냅샷(마크다운 전용). 보고서 §1 P1. 링크 DB에 저장되어 복제된다. */
export type VersionKind = "modify" | "delete" | "conflict" | "restore" | "submit";

export interface VersionDoc extends PouchDocBase {
	type: "version";
	schemaVersion: number;
	workspaceId: string;
	memberId: string;
	path: string; // dbPath
	versionOf: number; // 스냅샷이 담은 note.version
	content: string;
	contentHash: string;
	kind: VersionKind;
	createdAt: string; // ISO
	createdAtMs: number;
	createdBy: string;
	role: "member" | "manager";
	deviceId: string;
}

/** 버전 문서 id: version:<dbPath>:<14자리 0패딩 ms>. prefix 조회·사전식 정렬 가능. */
export function versionId(dbPath: string, createdAtMs: number): string {
	return `version:${dbPath}:${String(createdAtMs).padStart(14, "0")}`;
}

/** 한 파일의 버전 문서 prefix(allDocsByPrefix용). */
export function versionPrefix(dbPath: string): string {
	return `version:${dbPath}:`;
}

/** 학생이 속한 공유 공간 목록. 교사가 학생 개인 mirror DB에 기록 → 학생이 자동으로 공유 링크 생성. */
export interface SharesDoc extends PouchDocBase {
	type: "shares";
	spaces: Array<{
		id: string;
		name: string;
		remoteDb: string;
		folder: string;
		token?: string;
		/**
		 * 공간 종류. "share"(기본)=공유 공간(별도 share_* DB·폴더 링크 생성).
		 * "mirror"=학생 개인 mirror 자체의 1:1 실시간 공간 — 학생은 이미 개인 mirror를 동기화하므로
		 * 별도 링크를 만들지 않고 실시간(room/token) 용도로만 쓴다.
		 */
		kind?: "share" | "mirror";
		/** 이 공간에서 실시간 공동 편집을 쓸지(미설정/true=사용, false=끔). 파일 동기화와 무관. */
		realtime?: boolean;
	}>;
}

export const SHARES_DOC_ID = "shares";

/** 실시간(Yjs) 서버 설정. 교사가 학생 mirror DB에 기록 → 학생이 자동 수신. */
export interface RtConfigDoc extends PouchDocBase {
	type: "rtconfig";
	enabled: boolean;
	url: string;
	token: string;
	/** 실시간 세션 중 CouchDB 스냅샷 주기(초). 0/미설정=끔(§19.2). */
	snapshotSec?: number;
}

export const RTCONFIG_DOC_ID = "rtconfig";

/**
 * 피드백 앵커(판별 유니온). 마크다운 본문은 텍스트 범위, Excalidraw 드로잉은 요소 id/좌표에 앵커한다.
 * 하위호환: 기존 문서는 `kind`가 없으므로 text로 간주한다(isTextAnchor 참조).
 */
export type TextAnchor = { kind?: "text"; textQuote: string; start: number; end: number };
export type ExcalidrawAnchor = {
	kind: "excalidraw";
	elementIds: string[];
	point?: { x: number; y: number }; // 요소 삭제/이동 대비 캔버스 좌표 fallback
	label?: string; // 표시용(요소 종류/텍스트 일부)
};
export type FeedbackAnchor = TextAnchor | ExcalidrawAnchor;

export function isExcalidrawAnchor(a: FeedbackAnchor): a is ExcalidrawAnchor {
	return (a as ExcalidrawAnchor).kind === "excalidraw";
}
export function isTextAnchor(a: FeedbackAnchor): a is TextAnchor {
	return !isExcalidrawAnchor(a);
}

/**
 * 피드백 레이어 문서. 기술문서 §19.5. 본문을 직접 고치지 않고 앵커 기반 댓글을 남긴다.
 * 대상 노트가 사는 DB(mirror_<id> 또는 share_<id>)에 함께 저장되어 기존 replication으로 동기화된다.
 * 파일이 아니라 메타데이터이므로 vault에는 쓰지 않는다(FeedbackStore만 처리).
 */
export interface FeedbackDoc extends PouchDocBase {
	type: "feedback";
	schemaVersion: number;
	workspaceId: string;
	memberId: string; // 대상 노트가 속한 링크의 memberId(공유 공간은 spaceId 대용)
	targetPath: string; // 대상 노트의 dbPath (해당 DB 기준 상대경로)
	content: string;
	anchor: FeedbackAnchor;
	createdBy: string; // userId
	createdByRole: "member" | "manager";
	createdAt: string;
	updatedAt: string;
	resolved: boolean;
	deleted?: boolean;
}

export const FEEDBACK_ID_PREFIX = "feedback:";

/** 피드백 문서 _id: feedback:<dbPath>:<uid>. dbPath 기준으로 노트별 prefix 조회 가능. */
export function feedbackId(dbPath: string, uid: string): string {
	return `${FEEDBACK_ID_PREFIX}${dbPath}:${uid}`;
}

// =====================================================================================
// 학급 운영(Classroom) 문서들 — 대시보드(알림장·시간표/수업·과제·체크리스트)의 경량 상태.
// 콘텐츠 본문은 마크다운/excalidraw 파일(note/asset)로 별도 동기화되고, 여기 문서는 메타·상태만 담는다.
// 학급 공통(notice/timetable/routine 정의/response)=학급 공유 DB, 학생 개인 상태(assignment-state/
// routine-state)=학생 개인 mirror DB(비공개). 모두 기존 replication으로 동기화된다.
// =====================================================================================

/** 알림장 항목 메타. 본문은 `_학급/알림장/<...>.md` 파일(filePath). 학급 공유 DB에 저장. */
export interface NoticeDoc extends PouchDocBase {
	type: "notice";
	schemaVersion: number;
	workspaceId: string;
	uid: string;
	title: string;
	filePath: string; // 본문 마크다운 파일의 dbPath(학급 공유 폴더 기준)
	postedAtMs: number;
	pinned?: boolean;
	allowResponses?: boolean; // 양방향 응답 허용(기본 true)
	createdBy: string;
	createdByRole: "member" | "manager";
	deleted?: boolean;
}

export const NOTICE_ID_PREFIX = "notice:";
export function noticeId(uid: string): string {
	return `${NOTICE_ID_PREFIX}${uid}`;
}
export function noticePrefix(): string {
	return NOTICE_ID_PREFIX;
}

/** 게시물 응답: 읽음확인/댓글/질문. 학급 공유 DB. id에 byUser 포함 → 사용자별 분리(자기 소유만 쓰기). */
export type ResponseKind = "read" | "comment" | "question";
export interface ResponseDoc extends PouchDocBase {
	type: "response";
	schemaVersion: number;
	workspaceId: string;
	targetId: string; // 대상 게시물 id(noticeId 등)
	kind: ResponseKind;
	body?: string; // comment/question 본문
	byUser: string;
	byRole: "member" | "manager";
	createdAtMs: number;
	deleted?: boolean;
}

export const RESPONSE_ID_PREFIX = "response:";
/** read=사용자당 1개(idempotent), comment/question=uid로 분리. */
export function responseId(targetId: string, byUser: string, kind: ResponseKind, uid?: string): string {
	return kind === "read"
		? `${RESPONSE_ID_PREFIX}${targetId}:read:${byUser}`
		: `${RESPONSE_ID_PREFIX}${targetId}:${kind}:${byUser}:${uid ?? ""}`;
}
export function responsePrefix(targetId: string): string {
	return `${RESPONSE_ID_PREFIX}${targetId}:`;
}

/** 주간 시간표(학급 공유 DB의 단일 문서). 수업안내는 `_학급/수업/<date>.md` 파일 + notice류 메타로 처리. */
export interface TimetableDoc extends PouchDocBase {
	type: "timetable";
	schemaVersion: number;
	workspaceId: string;
	days: string[]; // 요일 라벨(예: ["월","화",...])
	periods: string[]; // 교시 라벨(예: ["1","2",...])
	cells: Record<string, string>; // "<dayIndex>:<periodIndex>" → 과목/내용
	updatedAtMs: number;
	updatedBy: string;
}

export const TIMETABLE_DOC_ID = "timetable";

/** 루브릭(채점 기준표): 기준 × 수준 × 배점. */
export interface RubricLevel {
	label: string;
	points: number;
}
export interface RubricCriterion {
	id: string;
	title: string;
	levels: RubricLevel[];
}

/** 과제 정의. 교사 상태(미동기화)에 보관 + 배포 시 학생 상태 문서 생성. */
export interface AssignmentDoc extends PouchDocBase {
	type: "assignment";
	schemaVersion: number;
	workspaceId: string;
	uid: string;
	title: string;
	instructions: string; // 마크다운 안내
	templatePaths: string[]; // 배포할 템플릿 파일(교사 vault 기준 경로)
	privacy: "mirror" | "shared";
	spaceId?: string; // privacy=shared일 때 대상 공유 공간
	targetMembers: string[]; // memberId[]
	dueAt?: number; // epoch ms
	points?: number;
	rubric?: RubricCriterion[];
	createdBy: string;
	createdAtMs: number;
	deleted?: boolean;
}

export const ASSIGNMENT_ID_PREFIX = "assignment:";
export function assignmentId(uid: string): string {
	return `${ASSIGNMENT_ID_PREFIX}${uid}`;
}

export type AssignmentState = "assigned" | "submitted" | "returned";
export interface AssignmentGrade {
	score?: number;
	rubricScores?: Record<string, number>; // criterionId → points
	comment?: string;
}

/** per-(과제,학생) 진행 상태. 학생 개인 mirror DB에 저장 → 성적 비공개·교사 1:1 가시. */
export interface AssignmentStateDoc extends PouchDocBase {
	type: "assignment-state";
	schemaVersion: number;
	workspaceId: string;
	assignmentUid: string;
	memberId: string;
	title: string;
	workPaths: string[]; // 학생 작업 파일 dbPath(학생 vault 기준)
	dueAt?: number;
	state: AssignmentState;
	assignedAtMs: number;
	submittedAtMs?: number;
	submittedSnapshotIds?: string[]; // VersionDoc id(제출 스냅샷)
	grade?: AssignmentGrade;
	returnedAtMs?: number;
	deleted?: boolean;
}

export const ASSIGNMENT_STATE_ID_PREFIX = "assignment-state:";
export function assignmentStateId(assignmentUid: string, memberId: string): string {
	return `${ASSIGNMENT_STATE_ID_PREFIX}${assignmentUid}:${memberId}`;
}
export function assignmentStatePrefix(): string {
	return ASSIGNMENT_STATE_ID_PREFIX;
}

/** 체크리스트/루틴 정의(학급 공유 DB). */
export interface RoutineItem {
	id: string;
	label: string;
}
export type RoutineRecurrence = "daily" | "weekly";
export interface RoutineDoc extends PouchDocBase {
	type: "routine";
	schemaVersion: number;
	workspaceId: string;
	uid: string;
	title: string;
	items: RoutineItem[];
	recurrence: RoutineRecurrence;
	weekdays?: number[]; // recurrence=weekly일 때 적용 요일(0=일..6=토)
	createdBy: string;
	createdAtMs: number;
	deleted?: boolean;
}

export const ROUTINE_ID_PREFIX = "routine:";
export function routineId(uid: string): string {
	return `${ROUTINE_ID_PREFIX}${uid}`;
}
export function routinePrefix(): string {
	return ROUTINE_ID_PREFIX;
}

/** per-(루틴,학생,날짜) 체크 상태. 학생 개인 mirror DB. */
export interface RoutineStateDoc extends PouchDocBase {
	type: "routine-state";
	schemaVersion: number;
	workspaceId: string;
	routineUid: string;
	memberId: string;
	day: string; // YYYY-MM-DD(로컬)
	checked: string[]; // 체크된 itemId
	updatedAtMs: number;
}

export const ROUTINE_STATE_ID_PREFIX = "routine-state:";
export function routineStateId(routineUid: string, memberId: string, day: string): string {
	return `${ROUTINE_STATE_ID_PREFIX}${routineUid}:${memberId}:${day}`;
}
