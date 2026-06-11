import { App, TFile, TFolder } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings, SharedSpace, MemberConfig } from "../settings/types";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import {
	ValidatePolicy,
	buildValidateSource,
	policyFingerprint,
	allowMapFromRtParts,
	VALIDATE_SOURCE_WARN_BYTES,
} from "../core/couch/validatePolicy";
import { isValidCouchName } from "../core/path/path";
import { setHomeroom } from "../core/classroom/homeroom";
import { BulkCopy, CopyOptions, CopyResult, CopyPlan } from "./manager/BulkCopy";
import { errMessage } from "../core/util/err";
import { getYjsSecret, getRtServicePassword } from "../core/secret";
import { RTCONTROL_DOC_ID, RTPART_ID_PREFIX, RtPartDoc } from "../core/model/types";
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
	/** 한 DB의 연결/권한 테스트(core/sync/connectionTest — core 결합을 main에 남기는 람다). */
	testDb(db: string): Promise<void>;
}

export class DeploymentController {
	constructor(private d: DeploymentDeps) {}

	/**
	 * 실시간 서버 서비스 계정 보장(설정 시). 계정을 생성/갱신하고 username을 반환한다 —
	 * 호출측이 _security 멤버 목록에 추가해 Hocuspocus 서버가 admin 없이 DB를 읽고 쓰게 한다.
	 * 비밀번호 미설정이면 계정 생성은 건너뛰고 username만 반환(이미 만들어 둔 계정 재사용 허용).
	 */
	private async ensureRtServiceAccount(admin: CouchAdmin): Promise<string | undefined> {
		const s = this.d.settings();
		const username = s.rtServiceUsername?.trim();
		if (!username) return undefined;
		const pw = getRtServicePassword(this.d.app);
		if (pw) {
			const res = await admin.ensureUser(username, pw);
			if (!res.ok) this.d.logger.warn(t("command.rt_service_account_failed", { err: res.error ?? "" }), true);
		}
		return username;
	}

	/**
	 * 실시간 인가 기본값(rtcontrol)을 모든 프로비저닝된 공유 공간 DB에 기록.
	 * Hocuspocus 서버가 rtpart(파일별 지정) 없는 파일의 기본 허용을 판단하고, _changes로 변경을 감지해
	 * 활성 연결을 재인가한다. 읽기전용 정책·실시간 토글이 바뀔 때마다 호출된다.
	 */
	async writeRtControl(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const adminPw = this.d.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) return;
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		for (const sp of s.sharedSpaces) {
			if (!sp.provisioned || !sp.remoteDb) continue;
			const r = await admin.putDoc(sp.remoteDb, {
				_id: RTCONTROL_DOC_ID,
				type: "rtcontrol",
				enabled: s.realtimeEnabled,
				sharedReadOnly: !!s.sharedReadOnly,
				updatedAtMs: Date.now(),
			});
			if (!r.ok) this.d.logger.error(t("command.failed_to_write_rtcontrol", { db: sp.remoteDb, err: r.error ?? "" }));
		}
	}

	/** DB별 validate 재배포 디바운스 타이머(requestValidateRedeploy). */
	private validateTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * validate_doc_update(v3 — 정책 임베드형)를 프로비저닝된 공유 DB에 재배포(지문 비교, 멱등).
	 * DB마다 원격 rtpart(권위 소스)를 읽어 정책(읽기전용 + 파일별 참여자 username)을 만들고,
	 * 마지막 성공 배포 지문(settings.validatePolicyByDb)과 다를 때만 PUT한다.
	 * 실패 DB는 지문 미기록 → 다음 트리거/시작에서 자동 재시도(기존 validateDocVersion 패턴의 일반화).
	 */
	async redeployValidate(opts?: { dbs?: string[] }): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const adminPw = this.d.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) return;
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		const targets = s.sharedSpaces.filter(
			(sp) => sp.provisioned && sp.remoteDb && (!opts?.dbs || opts.dbs.includes(sp.remoteDb)),
		);
		let changed = 0;
		for (const sp of targets) {
			try {
				const rtparts = await admin.listDocsByPrefix<RtPartDoc>(sp.remoteDb, RTPART_ID_PREFIX);
				const policy: ValidatePolicy = {
					readOnly: !!s.sharedReadOnly,
					svcUsername: s.rtServiceUsername?.trim() || undefined,
					allowByPath: allowMapFromRtParts(rtparts, s.members),
				};
				const fp = await policyFingerprint(policy);
				if ((s.validatePolicyByDb ?? {})[sp.remoteDb] === fp) continue; // 이미 최신
				const source = buildValidateSource(policy);
				if (source.length > VALIDATE_SOURCE_WARN_BYTES) {
					this.d.logger.warn(t("command.validate_source_too_large", { db: sp.remoteDb, kb: Math.round(source.length / 1024) }));
				}
				const r = await admin.putValidateDesignDoc(sp.remoteDb, source);
				if (!r.ok) {
					this.d.logger.warn(t("command.validate_redeploy_failed", { db: sp.remoteDb, err: r.error ?? "" }));
					continue;
				}
				s.validatePolicyByDb = { ...(s.validatePolicyByDb ?? {}), [sp.remoteDb]: fp };
				changed++;
			} catch (e) {
				this.d.logger.warn(t("command.validate_redeploy_failed", { db: sp.remoteDb, err: errMessage(e) }));
			}
		}
		if (changed > 0) {
			await this.d.saveSettings();
			this.d.logger.info(t("command.validate_redeployed"));
		}
	}

	/**
	 * 한 DB의 validate 재배포를 디바운스 예약(기본 20초). 연속 참여자 변경을 코얼레싱하고,
	 * 참여자 제거 직후 그 구성원의 마지막 세션 종료 보증 업로드가 도달할 시간을 벌어준다.
	 * rtpart는 로컬 pouch → replication으로 원격에 닿으므로 유예가 전파 시간도 겸한다.
	 */
	requestValidateRedeploy(db: string, delayMs = 20_000): void {
		const prev = this.validateTimers.get(db);
		if (prev) clearTimeout(prev);
		this.validateTimers.set(
			db,
			setTimeout(() => {
				this.validateTimers.delete(db);
				void this.redeployValidate({ dbs: [db] });
			}, delayMs),
		);
	}

	/** 대기 중인 validate 재배포 타이머 정리(플러그인 언로드 시). */
	dispose(): void {
		for (const tm of this.validateTimers.values()) clearTimeout(tm);
		this.validateTimers.clear();
	}

	/** 연결 테스트(설정 버튼) — 관리자는 프로비저닝 권한(_users)부터, 이후 역할별 DB 전체 검사. */
	async testConnection(): Promise<void> {
		await this.d.openLog();
		const s = this.d.settings();
		if (s.role === "manager") {
			// 빈 설정에서 누르면 잘못된 요청/예외가 나므로 URL/계정/비밀번호 필수값을 먼저 확인한다.
			if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
				this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
				return;
			}
			const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
			const chk = await admin.checkAdmin();
			if (chk.ok) this.d.logger.ok(t("command.admin_provisioning_access_ok"), true);
			else this.d.logger.error(chk.error ?? t("command.admin_provisioning_access_failed"), true);
		}
		const dbs = s.role === "manager" ? s.members.map((m) => m.remoteDb).filter((d) => d) : [s.remoteDb];
		if (dbs.length === 0) {
			this.d.logger.warn(t("command.no_mirror_db_to_test_manager"), true);
			return;
		}
		for (const db of dbs) await this.d.testDb(db);
	}

	// --- 교사 편의: 경로(파일/폴더)를 학생에게 복사 (기술문서 §12.5 / §20). 배포 탭에서 호출. ---
	async bulkCopy(sourcePath: string, opts: CopyOptions, memberIds: string[]): Promise<CopyResult & { error?: string }> {
		const r = this.resolveCopy(sourcePath, opts, memberIds);
		if ("error" in r) return { written: 0, skipped: 0, details: [], error: r.error };
		try {
			return r.src instanceof TFolder
				? await r.bulk.copyFolder(r.src, r.targets, r.opts)
				: await r.bulk.copyFile(r.src, r.targets, r.opts);
		} catch (e) {
			return { written: 0, skipped: 0, details: [], error: errMessage(e) };
		}
	}

	/** 배포 미리보기(dry-run) — 아무것도 쓰지 않고 학생별 대상/동작 예상. 배포 탭에서 호출. */
	async bulkCopyPreview(sourcePath: string, opts: CopyOptions, memberIds: string[]): Promise<CopyPlan & { error?: string }> {
		const r = this.resolveCopy(sourcePath, opts, memberIds);
		if ("error" in r) return { members: [], error: r.error };
		try {
			return await r.bulk.preview(r.src, r.targets, r.opts);
		} catch (e) {
			return { members: [], error: errMessage(e) };
		}
	}

	/** 복사/미리보기 공통: 경로·대상 학생 해석 + 파일일 때 빈 대상경로 보정. */
	private resolveCopy(
		sourcePath: string,
		opts: CopyOptions,
		memberIds: string[],
	): { src: TFile | TFolder; targets: MemberConfig[]; bulk: BulkCopy; opts: CopyOptions } | { error: string } {
		const s = this.d.settings();
		if (s.role !== "manager") return { error: t("command.available_in_manager_mode_only") };
		const src = this.d.app.vault.getAbstractFileByPath(sourcePath);
		if (!(src instanceof TFile) && !(src instanceof TFolder))
			return { error: t("deploy.path_not_found", { path: sourcePath }) };
		const targets = s.members.filter((st) => memberIds.includes(st.memberId));
		if (targets.length === 0) return { error: t("deploy.no_target_members") };
		// 파일: 대상 경로가 비어 있으면 원본 파일명으로.
		const finalOpts = src instanceof TFile && !opts.destPath ? { ...opts, destPath: src.name } : opts;
		return { src, targets, bulk: new BulkCopy(this.d.app, s), opts: finalOpts };
	}

	/** 공유 공간 프로비저닝 + 전원 shares 갱신 + 토큰 재발급 + 모드 재시작(교사). quiet=패널 전환 없이(자동 승인용). */
	async deployShared(space: SharedSpace, opts?: { quiet?: boolean }): Promise<void> {
		if (!opts?.quiet) await this.d.openLog();
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
		// 실시간 서버 서비스 계정을 _security에 포함 → Hocuspocus가 rtpart 조회·note 스냅샷을 admin 없이 수행.
		const svc = await this.ensureRtServiceAccount(admin);
		if (svc) memberUsers.push(svc);

		this.d.logger.info(t("command.deploying_shared_space_members", { name: space.name, db: space.remoteDb, count: memberUsers.length }));
		const res = await admin.provisionSharedSpace(space.remoteDb, memberUsers);
		if (!res.ok) {
			this.d.logger.error(t("command.shared_space_provisioning_failed", { err: res.error ?? "" }), true);
			return;
		}
		space.provisioned = true;
		space.lastDeployedAt = Date.now();
		space.lastMemberSnapshot = [...space.members].sort();

		// validate(v3)는 프로비저닝과 분리 배포 — 재배포(서버 리셋 후 포함)에서 디자인 문서가 빠지지 않게
		// 이 DB의 지문을 무효화하고 즉시 배포한다(멤버십 변경에 따른 참여자 username 갱신도 반영).
		if (s.validatePolicyByDb) delete s.validatePolicyByDb[space.remoteDb];
		await this.redeployValidate({ dbs: [space.remoteDb] });

		// 배포 때마다 모든 실시간 토큰을 재발급한다(공유: realtime 플래그, 개인 mirror: member.realtime).
		// 이 배포에서 모든 학생의 shares가 다시 기록되므로, 시크릿/멤버/플래그 변경 시 구 토큰 재유출을 막는다.
		await this.d.mintRealtimeTokens();
		await this.d.saveSettings();

		// 실시간 인가 기본값(rtcontrol)을 이 공간 DB에 기록(Hocuspocus 서버가 읽음).
		await this.writeRtControl();

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
		// 서비스 계정이 설정돼 있으면 기존 share/mirror DB의 _security에 반영(배포 이후 계정을 만든 경우 포함).
		const svc = await this.ensureRtServiceAccount(admin);
		if (svc) {
			for (const sp of s.sharedSpaces) {
				if (!sp.provisioned || !sp.remoteDb) continue;
				const memberUsers = sp.members
					.map((sid) => s.members.find((st) => st.memberId === sid)?.username)
					.filter((u): u is string => !!u);
				await admin.setSecurity(sp.remoteDb, [...memberUsers, svc]);
			}
			for (const st of s.members) {
				if (st.provisioned && st.remoteDb && st.username) await admin.setSecurity(st.remoteDb, [st.username, svc]);
			}
		}
		// 실시간 인가 기본값(rtcontrol) 전파 — 서버가 즉시 재인가한다.
		await this.writeRtControl();
		for (const st of s.members) {
			if (st.provisioned && st.remoteDb) await this.d.writeMemberSync(admin, st);
		}
		// 서비스 계정·멤버 구성 변경이 validate 임베드 정책에 반영되도록 전체 재배포(지문 비교로 멱등).
		await this.redeployValidate();
		this.d.logger.ok(t("command.realtime_settings_applied"), true);
		await this.d.restartMode();
	}
}
