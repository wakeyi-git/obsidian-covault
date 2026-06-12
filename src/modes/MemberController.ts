import { App } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace } from "../settings/types";
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
		let memberPw = getMemberPassword(this.d.app, member.memberId, member.password);
		if (!memberPw) memberPw = genPassword();

		this.d.logger.info(t("command.provisioning_member", { id: member.memberId, db: member.remoteDb }));
		const admin = new CouchAdmin(s.couchdbUrl, s.username, adminPw);
		// 실시간 서비스 계정이 설정돼 있으면 mirror DB _security에 함께 넣는다(미러 룸 시드/스냅샷용).
		const svc = s.rtServiceUsername?.trim();
		const res = await admin.provisionMember({
			username: member.username,
			password: memberPw,
			remoteDb: member.remoteDb,
			extraMembers: svc ? [svc] : [],
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
