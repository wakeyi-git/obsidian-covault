import { App, Notice } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { InvitePayload, parseInvite, isInviteExpired } from "../core/invite/invite";
import { persistCouchPassword } from "../core/secret";
import { t } from "../i18n";

/**
 * 학생 온보딩 컨트롤러. 초대 코드/딥링크 적용(ingestInvite)과 역할 재설정(resetSetup)을 담당.
 * 역할 선택 모달(promptRoleSetup)·마법사는 UI라 main에 남기고, 여기선 설정 변형/시작만 한다.
 */
export interface OnboardingDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	saveSettings(): Promise<void>;
	stopMode(): Promise<void>;
	startMode(): Promise<void>;
	destroyLocalCaches(): Promise<void>;
	openLog(): Promise<void>;
	/** 역할 선택 모달 재노출(resetSetup 마무리). UI라 main이 구현. */
	promptRoleSetup(): void;
	/** remoteDb 인증/도달 상태(HTTP status). 도달 실패면 null. */
	probeStatus(db: string): Promise<number | null>;
	/** 범용 확인 모달(Promise) — ui/ConfirmModal.confirm. 컨트롤러는 모달을 직접 import하지 않는다. */
	confirm(opts: { title: string; message: string; confirmText?: string; warning?: boolean }): Promise<boolean>;
}

export class OnboardingController {
	constructor(private d: OnboardingDeps) {}

	/** 초대 코드/딥링크로 학생 설정 자동 구성 + 동기화 시작. */
	async ingestInvite(input: string): Promise<void> {
		const payload = parseInvite(input);
		if (!payload) {
			new Notice(t("command.covault_could_not_parse_the"));
			this.d.logger.error(t("command.failed_to_parse_invite_code"));
			return;
		}
		// 만료된 초대는 적용하지 않는다 — 새 초대를 요청하도록 안내(설정을 건드리지 않음).
		if (isInviteExpired(payload, Math.floor(Date.now() / 1000))) {
			new Notice(t("command.invite_expired_request_new"));
			this.d.logger.error(t("command.invite_expired_request_new"));
			return;
		}
		// 적용 전 명시적 확인 — 역할·서버·자격증명(Secret Storage의 활성 비밀번호 포함)을 덮어쓰는
		// 파괴적 동작이다. 악성 딥링크가 운영자 설정을 클릭 한 번으로 갈아치우는 것을 막는다.
		if (!(await this.confirmInvite(payload))) {
			this.d.logger.info(t("command.invite_apply_canceled"));
			return;
		}
		await this.d.stopMode();

		const s = this.d.settings();
		s.role = "member";
		s.setupComplete = true;
		s.couchdbUrl = payload.couchdbUrl;
		s.workspaceId = payload.workspaceId;
		s.userId = payload.memberId;
		s.displayName = payload.memberName;
		s.username = payload.username;
		// 받은 학생 비밀번호는 Secret Storage에 보관(data.json 평문 회피). 미지원 환경만 평문 폴백.
		persistCouchPassword(this.d.app, s, payload.password);
		s.remoteDb = payload.remoteDb;
		s.localRoot = ""; // 학생 vault 전체
		s.lastSeqByDb = {};
		await this.d.saveSettings();

		await this.d.openLog();
		this.d.logger.ok(t("command.invite_applied_starting_sync", { name: payload.memberName, db: payload.remoteDb }), true);

		// 파싱 성공 ≠ 인증 성공. 즉시 인증을 확인해 옛/무효 초대를 명확히 안내한다(네트워크 실패는 startMode가 재시도).
		const status = await this.d.probeStatus(s.remoteDb);
		if (status === 401) {
			new Notice(t("panel.covault_invite_auth_failed_your"));
			this.d.logger.error(t("panel.invite_auth_failed_401_your_manager"), true);
		} else if (status === 403) {
			this.d.logger.warn(t("panel.invite_permission_error_403_check_this"), true);
		}

		await this.d.startMode();
	}

	/**
	 * 초대 적용 전 확인(평가 H-3). 대상 서버·계정을 보여주고, 이미 설정된 기기는 역할·자격증명이
	 * 덮어써짐을(운영자는 더 강하게) 경고한다. 닫기만 해도 취소로 처리해 설정을 건드리지 않는다.
	 */
	private confirmInvite(payload: InvitePayload): Promise<boolean> {
		const s = this.d.settings();
		const lines = [
			t("command.invite_confirm_member_line", { name: payload.memberName || payload.memberId, id: payload.username }),
			t("command.invite_confirm_server_line", { url: payload.couchdbUrl }),
		];
		if (payload.couchdbUrl.startsWith("http://")) lines.push(t("command.invite_confirm_http_warning"));
		const configured = s.setupComplete;
		if (configured) {
			const role = s.role === "manager" ? t("common.manager") : t("common.member");
			lines.push(t("command.invite_confirm_overwrite_warning", { role }));
		}
		return this.d.confirm({
			title: t("command.invite_confirm_title"),
			message: lines.join("\n"),
			confirmText: t("common.apply"),
			warning: configured,
		});
	}

	/** 역할 재설정(데이터 초기화). 로컬 캐시까지 비우고 역할 선택 모달을 다시 띄운다. */
	async resetSetup(): Promise<void> {
		await this.d.stopMode();
		await this.d.destroyLocalCaches();
		const s = this.d.settings();
		s.setupComplete = false;
		s.lastSeqByDb = {};
		await this.d.saveSettings();
		this.d.logger.warn(t("command.reset_the_role_sync_state_and"), true);
		this.d.promptRoleSetup();
	}
}
