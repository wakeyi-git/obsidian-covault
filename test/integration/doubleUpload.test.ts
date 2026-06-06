// P1 시나리오 5: 공유 폴더가 학생 폴더 아래 중첩될 때, 개인 mirror가 공유 파일을 이중 업로드하지 않는지.
import { describe, it, expect, afterEach } from "vitest";
import { createCore, buildLink } from "../harness/env";
import { noteId } from "../../src/core/model/types";

describe("이중 업로드 방지 (중첩 공유 폴더)", () => {
	let core: { core: any; vault: any };
	afterEach(async () => {
		await core?.core.dispose();
	});

	it("개인 링크는 childRoots(공유 폴더) 아래 파일을 업로드 대상에서 제외한다", async () => {
		const c = createCore("nestNS", "manager1");
		core = c;

		// 한 vault 안에 두 링크: 개인(members/alice) + 공유(members/alice/shared, 개인의 하위).
		const personal = buildLink(c.core, {
			localRoot: "members/alice",
			remoteDb: "mirror_alice",
			childRoots: ["members/alice/shared"],
		});
		const shared = buildLink(c.core, {
			localRoot: "members/alice/shared",
			remoteDb: "share_g1",
		});

		// 개인 파일 + 공유 폴더 안 파일.
		c.vault.seed("members/alice/notes/p.md", "personal");
		c.vault.seed("members/alice/shared/group.md", "shared-doc");

		// 직접 업로드 시도: 개인 링크는 공유 파일을 제외해야 한다.
		expect(await personal.uploader.uploadPath("members/alice/shared/group.md")).toBe("skipped-excluded");
		expect(await shared.uploader.uploadPath("members/alice/shared/group.md")).toBe("uploaded");

		// 전체 동기화(업로드)에서도 동일: 개인 DB엔 공유 파일 문서가 없어야 한다.
		await personal.fullSync.run("up");

		// 개인 DB: 개인 파일만 존재, 공유 파일(dbPath="shared/group.md")은 없음.
		expect(await personal.ctx.pouch.get(noteId("notes/p.md"))).toBeTruthy();
		expect(await personal.ctx.pouch.get(noteId("shared/group.md"))).toBeNull();

		// 공유 DB: 공유 파일(dbPath="group.md")만 담당.
		expect(await shared.ctx.pouch.get(noteId("group.md"))).toBeTruthy();
	});
});
