import { App } from "obsidian";
import { CoVaultSettings, MemberConfig } from "../settings/types";
import { Logger } from "../core/log/Logger";
import { CouchAdmin } from "../core/couch/CouchAdmin";
import { InviteModal } from "../ui/InviteModal";
import { InvitePayload, genPassword } from "../core/invite/invite";
import { getMemberPassword, setMemberPassword } from "../core/secret";
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
}

/**
 * 구성원(학생) 계정 생애주기 컨트롤러 — 초대(프로비저닝)·비밀번호 회전·shares/rtconfig 배포.
 * main.ts에서 분리(동작 불변). 서버 작업은 CouchAdmin(admin 자격증명)으로 수행.
 */
export class MemberController {
	constructor(private d: MemberDeps) {}

	async inviteMember(member: MemberConfig): Promise<boolean> {
		await this.d.openLog();
		const s = this.d.settings();
		const adminPw = this.d.couchPassword();
		if (!s.couchdbUrl || !s.username || !adminPw) {
			this.d.logger.warn(t("command.enter_the_admin_account_couchdb_url"), true);
			return false;
		}
		if (!member.memberId) {
			this.d.logger.warn(t("command.enter_a_member_id"), true);
			return false;
		}
		if (!member.username) member.username = member.memberId;
		if (!member.remoteDb) member.remoteDb = `mirror_${member.memberId}`;
		if (!member.localRoot) member.localRoot = member.memberName || member.memberId;
		if (!isValidCouchName(member.memberId) || !isValidCouchName(member.username) || !isValidCouchName(member.remoteDb)) {
			this.d.logger.warn(t("command.invalid_id_or_db_name", { id: member.memberId }), true);
			return false;
		}
		let memberPw = getMemberPassword(this.d.app, member.memberId, member.password);
		if (!memberPw) memberPw = genPassword();

		this.d.logger.info(t("command.provisioning_member", { id: member.memberId, db: member.remoteDb }));
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		const res = await admin.provisionMember({
			username: member.username,
			password: memberPw,
			remoteDb: member.remoteDb,
		});
		if (!res.ok) {
			this.d.logger.error(t("command.provisioning_failed", { err: res.error ?? "" }), true);
			return false;
		}
		if (setMemberPassword(this.d.app, member.memberId, memberPw)) member.password = undefined;
		else member.password = memberPw;
		member.provisioned = true;
		await this.d.mintMirror(member);
		await this.d.saveSettings();
		await this.writeMemberSync(admin, member);
		this.d.requestApply();
		this.d.logger.ok(t("command.provisioning_complete_account_db_permissions", { id: member.memberId }), true);

		const iat = Math.floor(Date.now() / 1000);
		const ttlDays = s.inviteTtlDays ?? 0;
		const payload: InvitePayload = {
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
		new InviteModal(this.d.app, payload).open();
		return true;
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

	/** 한 학생의 shares + rtconfig 문서 기록(공유 공간 멤버십 + 개인 mirror 실시간 공간). */
	async writeMemberSync(admin: CouchAdmin, st: MemberConfig): Promise<void> {
		const s = this.d.settings();
		const spaces: SharesDoc["spaces"] = s.sharedSpaces
			.filter((sp) => sp.members.includes(st.memberId))
			.map((sp) => ({
				id: sp.id,
				name: sp.name,
				remoteDb: sp.remoteDb,
				folder: sp.folder,
				token: sp.token,
				kind: sp.kind === "homeroom" ? ("homeroom" as const) : ("share" as const),
				realtime: s.realtimeEnabled,
			}));
		if (s.realtimeEnabled && st.realtimeToken) {
			spaces.push({ id: `mirror-${st.memberId}`, name: st.memberName, remoteDb: st.remoteDb, folder: "", token: st.realtimeToken, kind: "mirror", realtime: true });
		}
		const r = await admin.putDoc(st.remoteDb, { _id: SHARES_DOC_ID, type: "shares", spaces });
		if (!r.ok) this.d.logger.error(t("command.failed_to_write_shares", { id: st.memberId, err: r.error ?? "" }));
		// 레거시 전역 토큰은 더 이상 배포하지 않는다(실시간 인증은 공간별 HMAC 토큰만).
		const rc = await admin.putDoc(st.remoteDb, {
			_id: RTCONFIG_DOC_ID,
			type: "rtconfig",
			enabled: s.realtimeEnabled,
			url: s.yjsServerUrl,
			snapshotSec: s.realtimeSnapshotSec,
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
