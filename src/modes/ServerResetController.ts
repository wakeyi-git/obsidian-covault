import { Logger } from "../core/log/Logger";
import { CoVaultSettings, SharedSpace, MemberConfig } from "../settings/types";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { t } from "../i18n";

/**
 * 서버 데이터 삭제(파괴적) 컨트롤러(교사 전용). 구성원/공유 공간 서버 DB·계정 삭제 + 전체 초기화.
 * main.ts에 인라인이던 위험 로직을 한곳에 모아 안전 검토를 쉽게 한다(거동 동일).
 */
export interface ServerResetDeps {
	logger: Logger;
	settings(): CoVaultSettings;
	couchPassword(): string;
	saveSettings(): Promise<void>;
	openLog(): Promise<void>;
	/** mode?.stop() + mode=null (삭제 대상 DB로의 replication 차단). */
	stopMode(): Promise<void>;
	/** 대기 중 자동-적용(requestApply 디바운스) 취소. */
	cancelPendingApply(): void;
	/** 로컬 PouchDB(IndexedDB) 캐시 1개 제거(createPouch→destroyLocal→close). */
	destroyDbCache(db: string): Promise<void>;
	/** core.sharedSpaces를 비운다(계정까지 삭제 시 런타임 상태 초기화). */
	clearCoreSharedSpaces(): void;
}

export class ServerResetController {
	constructor(private d: ServerResetDeps) {}

	private admin(): CouchAdmin | null {
		const s = this.d.settings();
		if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
			this.d.logger.warn(t("command.enter_the_admin_account_first"), true);
			return null;
		}
		return new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
	}

	private async dropCache(db: string): Promise<void> {
		try {
			await this.d.destroyDbCache(db);
		} catch {
			/* 캐시 없음 등 무시 */
		}
	}

	/** 한 구성원의 서버 데이터(미러 DB + 계정) 삭제. 실패해도 가능한 만큼 진행. */
	async deleteMemberServer(member: MemberConfig): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		await this.d.openLog();
		const admin = this.admin();
		if (!admin) return;
		// 삭제 대상 DB로의 replication을 멈춘다(삭제 직후 재생성 방지). 호출측이 restartMode로 재구성.
		await this.d.stopMode();
		if (member.remoteDb) {
			const r = await admin.deleteDatabase(member.remoteDb);
			if (r.ok) this.d.logger.ok(t("command.db_deleted", { db: member.remoteDb }), true);
			else this.d.logger.error(t("command.failed_to_delete_db", { db: member.remoteDb, err: r.error ?? "" }), true);
			await this.dropCache(member.remoteDb);
		}
		if (member.username) {
			const r = await admin.deleteUser(member.username);
			if (r.ok) this.d.logger.ok(t("command.account_deleted", { user: member.username }), true);
			else this.d.logger.error(t("command.failed_to_delete_account", { user: member.username, err: r.error ?? "" }), true);
		}
	}

	/** 한 공동 공간의 서버 데이터(공유 DB) 삭제. */
	async deleteSharedServer(space: SharedSpace): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		await this.d.openLog();
		const admin = this.admin();
		if (!admin) return;
		await this.d.stopMode();
		if (space.remoteDb) {
			const r = await admin.deleteDatabase(space.remoteDb);
			if (r.ok) this.d.logger.ok(t("command.db_deleted", { db: space.remoteDb }), true);
			else this.d.logger.error(t("command.failed_to_delete_db", { db: space.remoteDb, err: r.error ?? "" }), true);
			await this.dropCache(space.remoteDb);
		}
	}

	/** 전체 서버 데이터 초기화. deleteAccounts면 계정·명단까지 비운다. */
	async resetServerData(deleteAccounts: boolean): Promise<void> {
		await this.d.openLog();
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		const admin = this.admin();
		if (!admin) return;
		const chk = await admin.checkAdmin();
		if (!chk.ok) {
			this.d.logger.error(t("command.admin_authentication_failed", { err: chk.error ?? "" }), true);
			return;
		}

		// 실행 중 엔진 정지(삭제할 DB로의 replication 차단). 대기 중 자동-적용도 취소.
		this.d.cancelPendingApply();
		await this.d.stopMode();

		const dbs = [
			...s.members.map((st) => st.remoteDb).filter((d) => d),
			...s.sharedSpaces.map((sp) => sp.remoteDb).filter((d) => d),
		];
		this.d.logger.info(t("command.starting_server_data_reset_db_s", { count: dbs.length, accounts: deleteAccounts ? t("command.member_accounts") : "" }), true);

		for (const db of dbs) {
			const r = await admin.deleteDatabase(db);
			if (r.ok) this.d.logger.ok(t("command.db_deleted", { db }));
			else this.d.logger.error(t("command.failed_to_delete_db", { db, err: r.error ?? "" }));
			await this.dropCache(db); // 로컬 PouchDB 캐시도 제거
		}

		if (deleteAccounts) {
			for (const st of s.members) {
				if (!st.username) continue;
				const r = await admin.deleteUser(st.username);
				if (r.ok) this.d.logger.ok(t("command.account_deleted", { user: st.username }));
				else this.d.logger.error(t("command.failed_to_delete_account", { user: st.username, err: r.error ?? "" }));
			}
		}

		// 로컬 상태 초기화
		if (deleteAccounts) {
			// 계정까지 삭제 → 학급 명단(학생·공유 공간)도 완전 비움(처음부터 다시 구성)
			s.members = [];
			s.sharedSpaces = [];
			this.d.clearCoreSharedSpaces();
		} else {
			// DB만 삭제 → 명단 유지, 프로비저닝 상태만 리셋(재초대로 복구)
			for (const st of s.members) st.provisioned = false;
			for (const sp of s.sharedSpaces) sp.provisioned = false;
		}
		s.lastSeqByDb = {};
		s.validatePolicyByDb = {}; // 서버가 비워졌으니 validate 배포 지문도 무효 — 재배포 강제
		await this.d.saveSettings();

		this.d.logger.warn(t("command.reset_yjs_realtime_data_manually_restart"), true);
		this.d.logger.ok(
			deleteAccounts ? t("command.server_data_and_accounts_reset_the") : t("command.server_data_reset_complete_invite_members"),
			true,
		);
	}
}
