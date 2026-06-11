import { MirrorContext } from "./MirrorContext";
import { errMessage } from "../util/err";
import { MirrorApplier } from "./MirrorApplier";
import { ChangeEvent, LiveHandle } from "../couch/PouchService";
import { NoteDoc, docType, isNoteDoc, isAssetDoc } from "../model/types";
import { t } from "../../i18n";

/** 수신 시 학급 패널(대시보드·학급 채널)을 갱신해야 하는 문서 타입 — core.onClassroomChange로 알린다. */
const CLASSROOM_NOTIFY_TYPES = new Set(["notice", "timetable", "response", "routine", "routine-state", "assignment", "assignment-state", "message", "chatgroup"]);

/**
 * 로컬 PouchDB changes 구독 → vault 반영. 기술문서 §10 / §17.2.
 *
 * replication이 원격 변경을 로컬 DB에 가져오면 로컬 changes로 흘러들어오고, 이를 vault에 적용한다.
 * 내 업로드(vault→로컬 DB)도 여기로 돌아오지만 Applier가 deviceId/해시로 무시한다.
 * 저장된 local seq부터 재개(증분)하고, 처리 후 seq를 체크포인트한다(영속).
 */
export class LocalApplier {
	private handle: LiveHandle | null = null;
	/** 적용 실패가 한 번 발생하면 이후 체크포인트 전진을 멈춘다(실패 지점 이후를 재시작 시 재처리 → 유실 방지). 적용은 멱등. */
	private stalled = false;
	/**
	 * 변경 적용 직렬화 큐. changes feed는 핸들러를 await하지 않으므로(fire-and-forget) 그냥 적용하면
	 * 느린 변경 A와 빠른 후속 변경 B가 동시 실행되고, B가 먼저 성공해 체크포인트를 seqB로 전진시킨 뒤
	 * A가 실패하면 재시작이 seqB부터 재개되어 A가 영구 누락된다. 큐로 도착 순서·완료를 보장한다.
	 */
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private ctx: MirrorContext,
		private applier: MirrorApplier,
		private onConfigChange?: () => void,
	) {}

	start(): void {
		if (this.handle) return;
		this.stalled = false;
		this.queue = Promise.resolve();
		const since = this.parseSince(this.ctx.getLastSeq());
		this.ctx.logger.info(
			t("sync.localapplier_started_since", {
				db: this.ctx.remoteDb,
				since: since === 0 ? t("sync.start") : since,
			}),
		);

		this.handle = this.ctx.pouch.localChanges<NoteDoc & { _conflicts?: string[] }>(
			(change) => {
				// applyChange는 내부에서 모든 오류를 잡지만, 만에 하나 reject되면 체인이 끊겨
				// 이후 변경이 조용히 무시된다 — stalled 표시 후 큐를 살린다.
				this.queue = this.queue
					.then(() => this.applyChange(change))
					.catch((e) => {
						this.stalled = true;
						this.ctx.logger.error(t("sync.failed_to_apply_local_change", { id: change.id, err: errMessage(e) }));
					});
			},
			{
				since,
				onError: (e) => this.ctx.logger.error(t("sync.local_changes_error", { err: e.message })),
			},
		);
	}

	/** 변경 1건 적용 + 체크포인트. 큐에서 순서대로 실행되므로 seq는 단조 증가한다. 절대 reject하지 않는다(큐 보존). */
	private async applyChange(change: ChangeEvent<NoteDoc & { _conflicts?: string[] }>): Promise<void> {
		let ok = true;
		// changes feed의 doc은 어떤 타입의 문서든 올 수 있다 — `as any` 캐스팅 대신 타입 가드로 좁힌다.
		const doc: unknown = change.doc;
		const type = docType(doc);
		try {
			if (change.deleted) {
				// PouchDB hard-remove(purge)가 전파됨 → 아카이브 사본 정리
				await this.applier.applyPurge(change.id);
			} else if (isNoteDoc(doc)) {
				await this.applier.applyDoc(doc);
			} else if (isAssetDoc(doc)) {
				await this.applier.applyAsset(doc);
			} else if (type === "shares" || type === "rtconfig") {
				this.onConfigChange?.(); // 공유 공간/실시간 설정 변경 → reconcile
			} else if (type === "rtpart") {
				// 파일별 실시간 참여자 변경 → 게이트 재평가(활성 세션도 취소 시 종료)
				this.ctx.core.onParticipantsChange();
			} else if (type === "grouprequest") {
				// 그룹 신청 변경 → 교사: 대기 신청 처리, 구성원: 신청 상태 갱신
				this.ctx.core.onGroupRequestChange();
			} else if (type === "plugindeploy") {
				// 함께 쓰는 플러그인 배포 수신 → 구성원: 설치 안내, 교사: 배포 패널 갱신
				this.ctx.core.onPluginDeployChange();
			} else if (type != null && CLASSROOM_NOTIFY_TYPES.has(type)) {
				// 학급 운영 문서(알림장·응답·루틴·메시지 등) 수신 → 대시보드 허브/학급 채널 갱신.
				// (이전엔 onClassroomChange가 어디서도 호출되지 않아 원격 변경에 패널이 멈춰 있었다.)
				this.ctx.core.onClassroomChange();
			} else if (type === "feedback") {
				// 피드백(§19.5)은 파일이 아니라 메타데이터 → vault에 쓰지 않고 패널만 갱신
				this.ctx.core.onFeedbackChange();
			}
		} catch (e) {
			ok = false;
			this.ctx.logger.error(
				t("sync.failed_to_apply_local_change", {
					id: change.id,
					err: errMessage(e),
				}),
			);
		}
		// 성공한 변경만 체크포인트 전진. 한 번 실패하면(stalled) 이후 전진을 멈춰,
		// 재시작 시 실패 지점부터 다시 처리되게 한다(applyDoc/Asset은 멱등).
		if (ok && !this.stalled) this.ctx.setLastSeq(String(change.seq));
		else if (!ok) this.stalled = true;
	}

	stop(): void {
		this.handle?.cancel();
		this.handle = null;
	}

	/** 로컬 seq는 숫자다. (구버전에 저장된 원격 seq 문자열은 0으로 폴백 → 안전하게 재처리.) */
	private parseSince(raw: string | undefined): number {
		if (raw && /^\d+$/.test(raw)) return Number(raw);
		return 0;
	}
}
