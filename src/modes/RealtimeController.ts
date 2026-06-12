import { App, Notice } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace } from "../settings/types";
import { RealtimeManager } from "../core/realtime/RealtimeManager";
import { mintSpaceToken, tokenExp } from "../core/realtime/spaceToken";
import { t } from "../i18n";
import {
	getYjsSecret,
	getBearerToken,
	persistBearerToken,
	clearBearerToken,
	spaceTokenId,
	memberMirrorTokenId,
	managerMirrorTokenId,
} from "../core/secret";

/**
 * RealtimeController 의존성. settings는 load/import에서 교체되므로 getter로 제공.
 * realtime(RealtimeManager)·openLog는 안정적인 동작을 위임받는다.
 */
export interface RealtimeDeps {
	app: App;
	settings(): CoVaultSettings;
	realtime(): RealtimeManager;
	openLog(): Promise<void>;
}

/**
 * 실시간(Yjs) 도메인 컨트롤러 — 공간/개인 mirror 서명 토큰 발급·회수 + 상태 진단.
 * main.ts에서 분리(동작 불변). 토큰 값은 settings(sp.token / member.realtimeToken)에 기록한다.
 */
export class RealtimeController {
	constructor(private d: RealtimeDeps) {}

	/** 토큰 만료(epoch sec). TTL 미설정(0)이면 무만료. */
	private ttl(s: CoVaultSettings): number | undefined {
		return s.yjsTokenTtlDays && s.yjsTokenTtlDays > 0 ? Math.floor(Date.now() / 1000) + s.yjsTokenTtlDays * 86400 : undefined;
	}

	/**
	 * 모든 실시간 서명 토큰 재발급/회수(교사). 전역 실시간 + 시크릿이 있으면 모든 공유 공간과 개인 mirror에
	 * 발급하고, 꺼져 있거나 시크릿이 없으면 모두 비운다(stale 재배포 방지). 시크릿은 Secret Storage에서 읽는다.
	 *
	 * sp.token은 **교사 본인용**(r=manager) 토큰이다. 구성원용 토큰은 멤버별 클레임이 들어가므로
	 * 설정에 저장하지 않고 shares 배포 시 mintMemberToken으로 그때그때 발급한다.
	 */
	async mintAll(): Promise<void> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		const on = s.realtimeEnabled && !!yjsSecret;
		const ttl = this.ttl(s);
		for (const sp of s.sharedSpaces) {
			if (on) {
				const tok = await mintSpaceToken(yjsSecret, {
					workspaceId: s.workspaceId,
					spaceId: sp.id,
					remoteDb: sp.remoteDb || `share_${sp.id}`,
					memberId: s.userId,
					role: "manager",
					exp: ttl,
				});
				// 베어러 토큰은 data.json 평문 대신 Secret Storage에 저장(평가 S-1). 미지원이면 평문 폴백.
				if (persistBearerToken(this.d.app, spaceTokenId(sp.id), tok)) {
					sp.token = undefined;
					sp.tokenSet = true;
				} else {
					sp.token = tok;
					sp.tokenSet = false;
				}
			} else {
				clearBearerToken(this.d.app, spaceTokenId(sp.id));
				delete sp.token;
				delete sp.tokenSet;
			}
		}
		for (const st of s.members) await this.mintMirror(st);
	}

	/**
	 * 공유 공간의 구성원용 토큰 발급(교사 → shares 배포 시 호출). 멤버별 m/r 클레임이 들어가
	 * 서버가 파일 단위 인가(rtpart)를 그 구성원 기준으로 수행한다. 발급 불가 조건이면 undefined.
	 */
	async mintMemberToken(space: SharedSpace, memberId: string): Promise<string | undefined> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		if (!s.realtimeEnabled || !yjsSecret || !memberId) return undefined;
		return mintSpaceToken(yjsSecret, {
			workspaceId: s.workspaceId,
			spaceId: space.id,
			remoteDb: space.remoteDb || `share_${space.id}`,
			memberId,
			role: "member",
			exp: this.ttl(s),
		});
	}

	/**
	 * 개인 mirror 실시간 토큰 발급/회수(교사). 전역 실시간 + yjsSecret 있을 때 발급, 아니면 비운다.
	 * spaceId=mirror-<memberId>이라 서버의 share 룸 prefix(<workspaceId>/share/<spaceId>/) 검증을 통과한다.
	 * mirror 룸은 1:1(교사+구성원)이라 서버가 rtpart 인가를 건너뛰므로, 교사도 이 토큰을 함께 쓴다.
	 */
	async mintMirror(member: MemberConfig): Promise<void> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		if (s.realtimeEnabled && yjsSecret && member.memberId && !member.realtimeBlocked) {
			const claims = {
				workspaceId: s.workspaceId,
				spaceId: `mirror-${member.memberId}`,
				remoteDb: member.remoteDb || `mirror_${member.memberId}`,
			};
			const memberTok = await mintSpaceToken(yjsSecret, {
				...claims,
				memberId: member.memberId,
				role: "member",
				exp: this.ttl(s),
			});
			// 운영자 본인은 별도 클레임 토큰을 쓴다 — 스냅샷 주체(lastModifiedBy)가 올바르게 찍히고,
			// 유출 시 주체 식별이 가능해진다(평가 L-10).
			const managerTok = await mintSpaceToken(yjsSecret, {
				...claims,
				memberId: s.userId,
				role: "manager",
				exp: this.ttl(s),
			});
			// data.json 평문 대신 Secret Storage(평가 S-1). 미지원이면 평문 폴백.
			if (persistBearerToken(this.d.app, memberMirrorTokenId(member.memberId), memberTok)) {
				member.realtimeToken = undefined;
				member.realtimeTokenSet = true;
			} else {
				member.realtimeToken = memberTok;
				member.realtimeTokenSet = false;
			}
			if (persistBearerToken(this.d.app, managerMirrorTokenId(member.memberId), managerTok)) {
				member.managerMirrorToken = undefined;
				member.managerMirrorTokenSet = true;
			} else {
				member.managerMirrorToken = managerTok;
				member.managerMirrorTokenSet = false;
			}
		} else {
			if (member.memberId) {
				clearBearerToken(this.d.app, memberMirrorTokenId(member.memberId));
				clearBearerToken(this.d.app, managerMirrorTokenId(member.memberId));
			}
			delete member.realtimeToken;
			delete member.realtimeTokenSet;
			delete member.managerMirrorToken;
			delete member.managerMirrorTokenSet;
		}
	}

	/** 공유 공간의 교사 본인용 토큰 조회(Secret Storage 우선, 평문 폴백). */
	spaceToken(sp: SharedSpace): string | undefined {
		return getBearerToken(this.d.app, spaceTokenId(sp.id), sp.token);
	}

	/** 구성원 mirror 토큰 조회(shares 배포용). */
	memberMirrorToken(member: MemberConfig): string | undefined {
		if (!member.memberId) return undefined;
		return getBearerToken(this.d.app, memberMirrorTokenId(member.memberId), member.realtimeToken);
	}

	/** 운영자 본인용 mirror 토큰 조회(실시간 공간 목록용). 없으면 구성원 토큰으로 폴백하지 않는다 — 호출측 판단. */
	managerMirrorToken(member: MemberConfig): string | undefined {
		if (!member.memberId) return undefined;
		return getBearerToken(this.d.app, managerMirrorTokenId(member.memberId), member.managerMirrorToken);
	}

	/**
	 * 발급된 토큰 중 가장 이른 만료가 임박(기본 3일)했거나 지났으면 경고 — 재배포를 유도한다.
	 * 만료는 서버가 활성 연결까지 강퇴하므로(주기 점검), 미리 갱신하지 않으면 실시간이 끊긴다(평가 M-9).
	 */
	warnExpiringTokens(days = 3): void {
		const s = this.d.settings();
		if (!s.realtimeEnabled || s.role !== "manager") return;
		const exps: number[] = [];
		for (const sp of s.sharedSpaces) {
			const e = tokenExp(this.spaceToken(sp));
			if (e != null) exps.push(e);
		}
		for (const st of s.members) {
			for (const tk of [this.memberMirrorToken(st), this.managerMirrorToken(st)]) {
				const e = tokenExp(tk);
				if (e != null) exps.push(e);
			}
		}
		if (exps.length === 0) return;
		const nowSec = Math.floor(Date.now() / 1000);
		const min = Math.min(...exps);
		if (min - nowSec > days * 86400) return;
		const left = Math.max(0, Math.ceil((min - nowSec) / 86400));
		new Notice(min <= nowSec ? t("realtime.tokens_expired_redeploy") : t("realtime.tokens_expiring_redeploy", { days: left }));
	}

	/** 실시간 진단(로그 패널로 상태 출력). */
	async realtimeStatus(): Promise<void> {
		await this.d.openLog();
		this.d.realtime().syncOpenEditors();
		this.d.realtime().diagnose();
	}
}
