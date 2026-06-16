// 무제한(maxAttachmentMB=0)이어도 적용되는 내부 안전 상한 검증 —
// 단일 거대 첨부의 동기 base64 인코딩이 메인스레드를 멈추는 현장 프리즈를 막는다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { assetId } from "../../src/core/model/types";
import {
	HARD_ATTACHMENT_CAP_MB,
	effectiveMaxAttachmentMB,
	isInternalCap,
	exceedsAttachmentLimit,
	attachmentMemoryAdvisory,
} from "../../src/core/sync/attachment";

const MB = 1024 * 1024;

describe("첨부 내부 안전 상한 헬퍼", () => {
	it("무제한(0)은 내부 상한으로, 사용자 상한은 그대로 매핑한다", () => {
		expect(effectiveMaxAttachmentMB(0)).toBe(HARD_ATTACHMENT_CAP_MB);
		expect(effectiveMaxAttachmentMB(-1)).toBe(HARD_ATTACHMENT_CAP_MB);
		expect(effectiveMaxAttachmentMB(5)).toBe(5);
	});

	it("isInternalCap은 사용자가 무제한을 골랐는지 구분한다(메시지 분기용)", () => {
		expect(isInternalCap(0)).toBe(true);
		expect(isInternalCap(5)).toBe(false);
	});

	it("내부 상한 적용 시 상한 초과 크기는 한도 초과로 판정된다", () => {
		const eff = effectiveMaxAttachmentMB(0); // = HARD_ATTACHMENT_CAP_MB
		expect(exceedsAttachmentLimit((HARD_ATTACHMENT_CAP_MB + 100) * MB, eff)).toBe(true);
		expect(exceedsAttachmentLimit((HARD_ATTACHMENT_CAP_MB - 100) * MB, eff)).toBe(false);
	});
});

describe("첨부 메모리 안전 경고", () => {
	it("시스템 메모리 미상이면 판정하지 않는다(경고 없음)", () => {
		expect(attachmentMemoryAdvisory(1024, null)).toBeNull();
		expect(attachmentMemoryAdvisory(1024, 0)).toBeNull();
	});

	it("피크(원본×4)가 시스템 메모리의 절반을 넘으면 경고한다", () => {
		// 1GB 설정 → 피크 ~4GB. 4GB 기기(절반 2GB)에선 경고.
		expect(attachmentMemoryAdvisory(1024, 4 * 1024)?.level).toBe("warn");
		// 1GB 설정, 16GB 기기(절반 8GB)에선 피크 4GB < 8GB → 안전.
		expect(attachmentMemoryAdvisory(1024, 16 * 1024)?.level).toBe("ok");
		// 작은 설정(20MB)은 어떤 기기에서도 안전.
		expect(attachmentMemoryAdvisory(20, 4 * 1024)?.level).toBe("ok");
	});
});

describe("무제한 설정에서 내부 상한이 거대 첨부를 막는다", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("업로드: stat.size가 내부 상한을 넘으면 바이너리를 읽기 전에 스킵한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 0 } });

		// 작은 실제 바이너리를 심고 stat.size만 내부 상한 초과로 위장(1GB 실제 할당 회피).
		const f = a.vault.seedBinary("img/huge.png", new ArrayBuffer(8));
		f.stat.size = (HARD_ATTACHMENT_CAP_MB + 100) * MB;

		const res = await a.uploader.uploadPath("img/huge.png");
		expect(res).toBe("skipped-toolarge");
		// DB에 asset 문서가 올라가지 않았다(복제 진입 차단).
		expect(await a.ctx.pouch.get(assetId("img/huge.png"))).toBeNull();
	});

	it("업로드: 내부 상한 이하 파일은 무제한 설정에서도 정상 업로드된다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 0 } });

		a.vault.seedBinary("img/ok.png", new TextEncoder().encode("작은 첨부").buffer);
		const res = await a.uploader.uploadPath("img/ok.png");
		expect(res).toBe("uploaded");
	});

	it("수신: 원격 메타 size가 내부 상한을 넘으면 다운로드를 건너뛴다", async () => {
		cluster = new Cluster();
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 0 } });

		// 다른 기기가 (구버전 등으로) 올려 원격에 박힌 거대 첨부 문서를 가정 — size 메타만으로 판정.
		const doc: any = {
			_id: assetId("img/remote-huge.png"),
			path: "img/remote-huge.png",
			type: "asset",
			mime: "image/png",
			contentHash: "x",
			size: (HARD_ATTACHMENT_CAP_MB + 100) * MB,
			deleted: false,
			version: 1,
			lastModifiedDeviceId: "a",
		};
		const res = await b.applier.applyAsset(doc);
		expect(res).toBe("skipped-too-large");
		expect(await b.ctx.readVaultBinary("img/remote-huge.png")).toBeNull();
	});
});
