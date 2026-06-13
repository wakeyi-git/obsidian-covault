import { App } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace, accountsOf } from "../settings/types";
import { Logger } from "../core/log/Logger";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { InviteModal } from "../ui/InviteModal";
import { BulkInviteModal } from "../ui/BulkInviteModal";
import { InvitePayload, genPassword } from "../core/invite/invite";
import { getMemberPassword, setMemberPassword, getBearerToken, memberMirrorTokenId } from "../core/secret";
import { isValidCouchName } from "../core/path/path";
import { SHARES_DOC_ID, RTCONFIG_DOC_ID, SharesDoc } from "../core/model/types";
import { t } from "../i18n";

/**
 * MemberController 의존성. settings는 load/import에서 교체되므로 getter로 제공.
 * mintMirror는 RealtimeController에 위임(개인 mirror 실시간 토큰 발급).
 */
export interface MemberDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	couchPassword(): string;
	saveSettings(): Promise<void>;
	requestApply(): void;
	openLog(): Promise<void>;
	mintMirror(member: MemberConfig): Promise<void>;
	/** 공유 공간의 구성원용 실시간 토큰 발급(RealtimeController.mintMemberToken). 발급 불가면 undefined. */
	mintMemberToken(space: SharedSpace, memberId: string): Promise<string | undefined>;
	/** validate 정책 재배포(DeploymentController). 기기 계정 추가/회수 시 acct 맵 갱신용(평가 S-2). */
	redeployValidate(opts?: { dbs?: string[] }): Promise<void>;
}

/**
 * 구성원(학생) 계정 생애주기 컨트롤러 — 초대(프로비저닝)·비밀번호 회전·shares/rtconfig 배포.
 * main.ts에서 분리(동작 불변). 서버 작업은 CouchAdmin(admin 자격증명)으로 수행.
 */
export class MemberController {
	constructor(private d: MemberDeps) {}

	/** 구성원별 실시간 허용/차단(교사). 차단=토큰 미발급·shares realtime:false → 파일 동기화만. */
	async setMemberRealtime(memberId: string, allowed: boolean): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			this.d.logger.warn(t("command.available_in_manager_mode_only"), true);
			return;
		}
		const m = s.members.find((x) => x.memberId === memberId);
		if (!m) return;
		m.realtimeBlocked = !allowed;
		await this.d.mintMirror(m); // 차단이면 mirror 토큰 삭제, 허용이면 재발급
		await this.d.saveSettings();
		const adminPw = this.d.couchPassword();
		if (m.provisioned && s.couchdbUrl && s.username && adminPw) {
			const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
			await this.writeMemberSync(admin, m); // 갱신된 shares를 학생 mirror에 기록 → 학생이 자동 반영
		}
		this.d.logger.ok(
			allowed
				? t("realtime.member_allowed", { name: m.memberName || memberId })
				: t("realtime.member_blocked", { name: m.memberName || memberId }),
			true,
		);
	}

	async inviteMember(member: MemberConfig): Promise<boolean> {
		await this.d.openLog();
		const payload = await this.provision(member);
		if (!payload) return false;
		new InviteModal(this.d.app, payload).open();
		return true;
	}

	/**
	 * 프로비저닝되지 않은 모든 구성원을 한 번에 초대(프로비저닝)한다. 구성원별 모달을 N개 띄우지 않고
	 * 끝에 BulkInviteModal로 모든 초대 코드를 한곳에 보여준다. 프로비저닝된 구성원 수를 반환.
	 */
	async inviteAllMembers(): Promise<number> {
		await this.d.openLog();
		const s = this.d.settings();
		if (s.role !== "manager") return 0;
		const targets = s.members.filter((m) => m.memberId && !m.provisioned);
		if (targets.length === 0) {
			this.d.logger.warn(t("command.no_members_to_invite"), true);
			return 0;
		}
		const payloads: InvitePayload[] = [];
		for (const m of targets) {
			const p = await this.provision(m);
			if (p) payloads.push(p);
		}
		this.d.logger.ok(t("command.bulk_invite_complete", { n: payloads.length, total: targets.length }), true);
		if (payloads.length > 0) new BulkInviteModal(this.d.app, payloads).open();
		return payloads.length;
	}

	/**
	 * 서버 프로비저닝 + shares/rtconfig 기록 + 로컬 상태 갱신. 성공 시 초대 페이로드, 실패 시 null.
	 * 단건/일괄 초대가 공유하는 코어(초대 UI는 호출자가 띄운다).
	 */
	private async provision(member: MemberConfig): Promise<InvitePayload | null> {
		const s = this.d.settings();
		const adminPw = this.d.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) {
			this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return null;
		}
		if (!member.memberId) {
			this.d.logger.warn(t("command.enter_a_member_id"), true);
			return null;
		}
		if (!member.username) member.username = member.memberId;
		if (!member.remoteDb) member.remoteDb = `mirror_${member.memberId}`;
		if (!member.localRoot) member.localRoot = member.memberName || member.memberId;
		if (!isValidCouchName(member.memberId) || !isValidCouchName(member.username) || !isValidCouchName(member.remoteDb)) {
			this.d.logger.warn(t("command.invalid_id_or_db_name", { id: member.memberId }), true);
			return null;
		}
		// 재초대 = 항상 회전(평가 S-2). 첫 적용 기기가 비밀번호를 스스로 회전하므로 저장된 비밀번호는
		// 이미 무효일 수 있다 — 죽은 초대를 발급하지 않도록 프로비저닝된 구성원은 새로 생성한다.
		// (그 구성원의 기존 기기는 새 초대를 다시 적용해야 한다. 기기 추가는 inviteDevice가 담당.)
		let memberPw = member.provisioned ? genPassword() : getMemberPassword(this.d.app, member.memberId, member.password);
		if (!memberPw) memberPw = genPassword();
		if (member.provisioned) this.d.logger.warn(t("command.reinvite_rotates_password"), true);

		this.d.logger.info(t("command.provisioning_member", { id: member.memberId, db: member.remoteDb }));
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		// 실시간 서비스 계정이 설정돼 있으면 mirror DB _security에 함께 넣는다(미러 룸 시드/스냅샷용).
		// 기기 계정도 함께(평가 S-2) — 재프로비저닝이 기존 기기 계정의 접근을 끊지 않도록.
		const svc = s.rtServiceUsername?.trim();
		const deviceUsers = (member.deviceAccounts ?? []).map((a) => a.username);
		const res = await admin.provisionMember({
			username: member.username,
			password: memberPw,
			remoteDb: member.remoteDb,
			extraMembers: [...deviceUsers, ...(svc ? [svc] : [])],
		});
		if (!res.ok) {
			this.d.logger.error(t("command.provisioning_failed", { err: res.error ?? "" }), true);
			return null;
		}
		if (setMemberPassword(this.d.app, member.memberId, memberPw)) member.password = undefined;
		else member.password = memberPw;
		member.provisioned = true;
		await this.d.mintMirror(member);
		await this.d.saveSettings();
		await this.writeMemberSync(admin, member);
		// mirror DB에도 validate 배포(평가 P1-1) — DM 사칭·임의 타입 주입 차단. 지문 비교로 멱등.
		await this.d.redeployValidate({ dbs: [member.remoteDb] });
		this.d.requestApply();
		this.d.logger.ok(t("command.provisioning_complete_account_db_permissions", { id: member.memberId }), true);

		const iat = Math.floor(Date.now() / 1000);
		const ttlDays = s.inviteTtlDays ?? 0;
		return {
			v: 1,
			couchdbUrl: s.couchdbUrl,
			workspaceId: s.workspaceId,
			memberId: member.memberId,
			memberName: member.memberName,
			remoteDb: member.remoteDb,
			username: member.username,
			password: memberPw,
			iat,
			...(ttlDays > 0 ? { exp: iat + ttlDays * 86400 } : {}),
		};
	}

	async rotateMemberPassword(member: MemberConfig): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		if (!member.memberId) {
			this.d.logger.warn(t("command.enter_a_member_id"), true);
			return;
		}
		const prev = getMemberPassword(this.d.app, member.memberId, member.password);
		const next = genPassword();
		if (!setMemberPassword(this.d.app, member.memberId, next)) member.password = next;
		this.d.logger.info(t("invite.reissuing_password_previous_invite_invalidated", { id: member.memberId }), true);
		const ok = await this.inviteMember(member);
		if (!ok) {
			if (!setMemberPassword(this.d.app, member.memberId, prev)) member.password = prev;
			else member.password = undefined;
			this.d.logger.warn(t("invite.password_reissue_failed_keeping_the_previous"), true);
		}
	}

	/**
	 * 기기 추가 초대(평가 S-2 — 기기별 계정). 전용 계정 <memberId>-d<n>을 만들어 초대를 발급한다.
	 * 적용 기기가 비밀번호를 즉시 회전하므로 초대는 일회성이고, 기존 기기에는 영향이 없다.
	 */
	async inviteDevice(member: MemberConfig): Promise<boolean> {
		const s = this.d.settings();
		const adminPw = this.d.couchPassword();
		if (s.role !== "manager" || !s.couchdbUrl || !s.username || !adminPw) {
			this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return false;
		}
		if (!member.provisioned || !member.memberId) {
			this.d.logger.warn(t("device.invite_needs_provisioned"), true);
			return false;
		}
		await this.d.openLog();
		const username = this.nextDeviceUsername(member);
		if (!isValidCouchName(username)) {
			this.d.logger.warn(t("command.invalid_id_or_db_name", { id: username }), true);
			return false;
		}
		const pw = genPassword();
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		const user = await admin.ensureUser(username, pw);
		if (!user.ok) {
			this.d.logger.error(t("command.provisioning_failed", { err: user.error ?? "" }), true);
			return false;
		}
		member.deviceAccounts = [...(member.deviceAccounts ?? []), { username, createdAt: Date.now() }];
		await this.refreshAccountAccess(admin, member);
		await this.d.saveSettings();
		this.d.logger.ok(t("device.invite_issued", { username }), true);
		const iat = Math.floor(Date.now() / 1000);
		const ttlDays = s.inviteTtlDays ?? 0;
		new InviteModal(this.d.app, {
			v: 1,
			couchdbUrl: s.couchdbUrl,
			workspaceId: s.workspaceId,
			memberId: member.memberId,
			memberName: member.memberName,
			remoteDb: member.remoteDb,
			username,
			password: pw,
			iat,
			...(ttlDays > 0 ? { exp: iat + ttlDays * 86400 } : {}),
		}).open();
		return true;
	}

	/** 기기 계정 회수(평가 S-2). 계정 삭제 + _security/validate에서 제거 — 그 기기의 동기화가 중단된다. */
	async revokeDevice(member: MemberConfig, username: string): Promise<boolean> {
		const s = this.d.settings();
		const adminPw = this.d.couchPassword();
		if (s.role !== "manager" || !s.couchdbUrl || !s.username || !adminPw) {
			this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return false;
		}
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		const del = await admin.deleteUser(username);
		if (!del.ok) {
			this.d.logger.error(t("device.revoke_failed", { username, err: del.error ?? "" }), true);
			return false;
		}
		member.deviceAccounts = (member.deviceAccounts ?? []).filter((a) => a.username !== username);
		await this.refreshAccountAccess(admin, member);
		await this.d.saveSettings();
		this.d.logger.ok(t("device.revoked", { username }), true);
		return true;
	}

	/** 다음 기기 계정명 <memberId>-d<n>(기존과 충돌하지 않는 첫 번호, d2부터). */
	private nextDeviceUsername(member: MemberConfig): string {
		const taken = new Set(accountsOf(member));
		for (let n = 2; ; n++) {
			const candidate = `${member.memberId}-d${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	/** 계정 구성 변경 후 접근 재설정: mirror·공유 공간 _security + validate acct 맵(평가 S-2). */
	private async refreshAccountAccess(admin: CouchAdmin, member: MemberConfig): Promise<void> {
		const s = this.d.settings();
		const svc = s.rtServiceUsername?.trim();
		if (member.remoteDb) {
			await admin.setSecurity(member.remoteDb, [...accountsOf(member), ...(svc ? [svc] : [])]);
		}
		for (const sp of s.sharedSpaces) {
			if (!sp.provisioned || !sp.remoteDb || !sp.members.includes(member.memberId)) continue;
			const users = sp.members.flatMap((sid) => {
				const st = s.members.find((x) => x.memberId === sid);
				return st ? accountsOf(st) : [];
			});
			await admin.setSecurity(sp.remoteDb, [...users, ...(svc ? [svc] : [])]);
		}
		await this.d.redeployValidate(); // acct 맵 갱신(지문 비교로 멱등)
	}

	/** 한 학생의 shares + rtconfig 문서 기록(공유 공간 멤버십 + 개인 mirror 실시간 공간). */
	async writeMemberSync(admin: CouchAdmin, st: MemberConfig): Promise<void> {
		const s = this.d.settings();
		// 이 구성원에게 실시간을 켤지(전역 on + 개별 차단 아님). 차단이면 토큰 미전달·realtime:false → 파일 동기화만.
		const rtOn = s.realtimeEnabled && !st.realtimeBlocked;
		const spaces: SharesDoc["spaces"] = [];
		for (const sp of s.sharedSpaces) {
			if (!sp.members.includes(st.memberId)) continue;
			// 토큰은 멤버별 발급(m/r 클레임) — 교사용 sp.token을 그대로 내려보내면 구성원이 manager 권한이 된다.
			spaces.push({
				id: sp.id,
				name: sp.name,
				remoteDb: sp.remoteDb,
				folder: sp.folder,
				token: rtOn ? await this.d.mintMemberToken(sp, st.memberId) : undefined,
				kind: sp.kind === "homeroom" ? ("homeroom" as const) : ("share" as const),
				realtime: rtOn,
			});
		}
		// 구성원 mirror 토큰은 Secret Storage 우선·평문 폴백으로 읽는다(평가 S-1).
		const mirrorToken = getBearerToken(this.d.app, memberMirrorTokenId(st.memberId), st.realtimeToken);
		if (rtOn && mirrorToken) {
			spaces.push({ id: `mirror-${st.memberId}`, name: st.memberName, remoteDb: st.remoteDb, folder: "", token: mirrorToken, kind: "mirror", realtime: true });
		}
		const r = await admin.putDoc(st.remoteDb, { _id: SHARES_DOC_ID, type: "shares", spaces });
		if (!r.ok) this.d.logger.error(t("command.failed_to_write_shares", { id: st.memberId, err: r.error ?? "" }));
		// 레거시 전역 토큰은 더 이상 배포하지 않는다(실시간 인증은 공간별 HMAC 토큰만).
		// snapshotSec은 더 이상 배포하지 않는다 — 세션 중 스냅샷은 Hocuspocus 서버(디바운스)가 담당.
		const rc = await admin.putDoc(st.remoteDb, {
			_id: RTCONFIG_DOC_ID,
			type: "rtconfig",
			enabled: s.realtimeEnabled,
			url: s.yjsServerUrl,
			sharedReadOnly: !!s.sharedReadOnly,
		});
		if (!rc.ok) this.d.logger.error(t("command.failed_to_write_rtconfig", { id: st.memberId, err: rc.error ?? "" }));
	}

	/** 모든 프로비저닝된 구성원의 shares 문서를 다시 기록(교사). 공동 공간 변경 반영. */
	async refreshMemberShares(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		if (!s.couchdbUrl || !s.username || !this.d.couchPassword()) {
			this.d.logger.warn(t("command.enter_the_admin_account_first"), true);
			return;
		}
		const admin = new CouchAdmin(s.couchdbUrl, s.username, this.d.couchPassword());
		for (const st of s.members) {
			if (st.provisioned && st.remoteDb) await this.writeMemberSync(admin, st);
		}
	}
}
