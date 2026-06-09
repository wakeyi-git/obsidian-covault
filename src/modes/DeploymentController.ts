import { App } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings, SharedSpace, MemberConfig } from "../settings/types";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { isValidCouchName } from "../core/path/path";
import { setHomeroom } from "../core/classroom/homeroom";
import { getYjsSecret } from "../core/secret";
import { t } from "../i18n";

/**
 * 배포·프로비저닝 컨트롤러(교사 전용). main.ts에 인라인이던 공유 공간 배포 / 학급 공동 공간 지정 /
 * 개인 동기화 토글 / 실시간 재배포 오케스트레이션을 모은다(거동 동일).
 * settings는 load/import에서 교체되므로 getter로 받는다.
 */
export interface DeploymentDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	couchPassword(): string;
	saveSettings(): Promise<void>;
	restartMode(): Promise<void>;
	openLog(): Promise<void>;
	openDashboard(): Promise<void>;
	/** 학생 mirror DB에 shares + rtconfig 기록(MemberController.writeMemberSync). */
	writeMemberSync(admin: CouchAdmin, member: MemberConfig): Promise<void>;
	/** 모든 실시간 토큰 재발급(RealtimeController.mintAll). */
	mintRealtimeTokens(): Promise<void>;
	/** 전 구성원 shares 재전파(MemberController.refreshMemberShares). */
	refreshMemberShares(): Promise<void>;
}

export class DeploymentController {
	constructor(private d: DeploymentDeps) {}

	/** 공유 공간 프로비저닝 + 전원 shares 갱신 + 토큰 재발급 + 모드 재시작(교사). */
	async deployShared(space: SharedSpace): Promise<void> {
		await this.d.openLog();
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
			this.d.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		if (!space.remoteDb) space.remoteDb = `share_${space.id}`;
		if (!space.folder) space.folder = space.name || space.id;
		if (!isValidCouchName(space.remoteDb)) {
			this.d.logger.warn(t("command.invalid_share_db_name", { db: space.remoteDb }), true);
			return;
		}

		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
		const memberUsers = space.members
			.map((sid) => s.members.find((st) => st.memberId === sid)?.username)
			.filter((u): u is string => !!u);

		this.d.logger.info(t("command.deploying_shared_space_members", { name: space.name, db: space.remoteDb, count: memberUsers.length }));
		const res = await admin.provisionSharedSpace(space.remoteDb, memberUsers);
		if (!res.ok) {
			this.d.logger.error(t("command.shared_space_provisioning_failed", { err: res.error ?? "" }), true);
			return;
		}
		space.provisioned = true;
		space.lastDeployedAt = Date.now();
		space.lastMemberSnapshot = [...space.members].sort();

		// 배포 때마다 모든 실시간 토큰을 재발급한다(공유: realtime 플래그, 개인 mirror: member.realtime).
		// 이 배포에서 모든 학생의 shares가 다시 기록되므로, 시크릿/멤버/플래그 변경 시 구 토큰 재유출을 막는다.
		await this.d.mintRealtimeTokens();
		await this.d.saveSettings();

		// 모든 학생의 shares + rtconfig 문서 갱신(추가/제거 학생 모두 반영)
		for (const st of s.members) await this.d.writeMemberSync(admin, st);

		this.d.logger.ok(t("command.shared_space_deployment_complete", { name: space.name }), true);
		await this.d.restartMode();
	}

	/** 공유 공간 하나를 학급 공동 공간으로 지정/해제(교사). */
	async setHomeroomSpace(space: SharedSpace, on: boolean): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		s.sharedSpaces = setHomeroom(s.sharedSpaces, on ? space.id : null);
		await this.d.saveSettings();
		const hr = s.sharedSpaces.find((sp) => sp.id === space.id);
		// 지정한 공간이 미배포면 배포(프로비저닝 + 전원 shares 갱신 + 모드 재시작 포함), 아니면 shares 전파 + 모드 재구성.
		if (on && hr && !hr.provisioned) {
			await this.deployShared(hr);
		} else {
			await this.d.refreshMemberShares();
			await this.d.restartMode();
		}
		// 학급 공동 공간을 켜면 대시보드를 열어 학급 운영 기능을 바로 사용하게 한다.
		if (on) await this.d.openDashboard();
	}

	/** 내 볼트 개인 동기화 켜기/끄기(교사). 켜면 개인 DB 프로비저닝 후 모드 재시작. */
	async setPersonalSync(on: boolean): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		if (on) {
			if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
				this.d.logger.warn(t("command.enter_the_admin_account_first"), true);
				return;
			}
			const db = s.personalRemoteDb || `personal_${s.userId.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "vault"}`;
			await this.d.openLog();
			this.d.logger.info(t("command.provisioning_personal_db", { db }));
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
			const res = await admin.provisionPersonalDb(db, s.username);
			if (!res.ok) {
				this.d.logger.error(t("command.personal_provision_failed", { err: res.error ?? "" }), true);
				return;
			}
			s.personalRemoteDb = db;
			s.personalSyncEnabled = true;
			await this.d.saveSettings();
			await this.d.restartMode();
			this.d.logger.ok(t("command.personal_sync_on", { db }), true);
		} else {
			s.personalSyncEnabled = false;
			await this.d.saveSettings();
			await this.d.restartMode();
			this.d.logger.info(t("command.personal_sync_off"), true);
		}
	}

	/**
	 * 실시간 토글(학생 개인 폴더/공유 공간/전체) 적용. 토큰 재발급 + 프로비저닝된 모든 학생의 shares/rtconfig
	 * 재기록 + 모드 재시작. 공유 공간을 재배포(재프로비저닝)하지 않고 실시간 설정만 전파한다.
	 */
	async redeployRealtime(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const adminPw = this.d.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) {
			this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return;
		}
		const wantsRealtime = s.members.length > 0 || s.sharedSpaces.length > 0;
		if (s.realtimeEnabled && wantsRealtime && !getYjsSecret(this.d.app, s.yjsSecret)) {
			this.d.logger.warn(t("command.realtime_needs_yjs_secret"), true);
		}
		await this.d.mintRealtimeTokens();
		await this.d.saveSettings();
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		for (const st of s.members) {
			if (st.provisioned && st.remoteDb) await this.d.writeMemberSync(admin, st);
		}
		this.d.logger.ok(t("command.realtime_settings_applied"), true);
		await this.d.restartMode();
	}
}
