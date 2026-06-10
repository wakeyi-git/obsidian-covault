import { MirrorContext } from "./MirrorContext";
import { errMessage } from "../util/err";
import { MirrorApplier } from "./MirrorApplier";
import { LiveHandle } from "../couch/PouchService";
import { NoteDoc } from "../model/types";
import { t } from "../../i18n";

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

	constructor(
		private ctx: MirrorContext,
		private applier: MirrorApplier,
		private onConfigChange?: () => void,
	) {}

	start(): void {
		if (this.handle) return;
		this.stalled = false;
		const since = this.parseSince(this.ctx.getLastSeq());
		this.ctx.logger.info(
			t("sync.localapplier_started_since", {
				db: this.ctx.remoteDb,
				since: since === 0 ? t("sync.start") : since,
			}),
		);

		this.handle = this.ctx.pouch.localChanges<NoteDoc & { _conflicts?: string[] }>(
			async (change) => {
				let ok = true;
				try {
					if (change.deleted) {
						// PouchDB hard-remove(purge)가 전파됨 → 아카이브 사본 정리
						await this.applier.applyPurge(change.id);
					} else if (change.doc && (change.doc as any).type === "note") {
						await this.applier.applyDoc(change.doc);
					} else if (change.doc && (change.doc as any).type === "asset") {
						await this.applier.applyAsset(change.doc as any);
					} else if (change.doc && ((change.doc as any).type === "shares" || (change.doc as any).type === "rtconfig")) {
						this.onConfigChange?.(); // 공유 공간/실시간 설정 변경 → reconcile
					} else if (change.doc && (change.doc as any).type === "rtpart") {
						// 파일별 실시간 참여자 변경 → 게이트 재평가(활성 세션도 취소 시 종료)
						this.ctx.core.onParticipantsChange();
					} else if (change.doc && (change.doc as any).type === "grouprequest") {
						// 그룹 신청 변경 → 교사: 대기 신청 처리, 구성원: 신청 상태 갱신
						this.ctx.core.onGroupRequestChange();
					} else if (change.doc && (change.doc as any).type === "feedback") {
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
			},
			{
				since,
				onError: (e) => this.ctx.logger.error(t("sync.local_changes_error", { err: e.message })),
			},
		);
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
