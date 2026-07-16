import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			// 통합 테스트 하니스: 엔진이 import하는 obsidian/pouchdb-browser를 인메모리 대체물로.
			// 정규식으로 정확히 일치시켜 깊은 경로(pouchdb-browser/lib/...)는 건드리지 않는다.
			{ find: /^obsidian$/, replacement: path.resolve(root, "test/harness/obsidian.ts") },
			{ find: /^pouchdb-browser$/, replacement: path.resolve(root, "test/harness/pouchdb-memory.ts") },
			// server/hocuspocus/node_modules가 설치된 상태에서도 서버 모듈과 테스트가 Yjs 한 사본을 공유해야 한다.
			// 두 사본이 섞이면 instanceof/구조체 등록이 갈라져 update 적용이 무시되고 CRDT 테스트가 거짓 실패한다.
			{ find: /^yjs$/, replacement: path.resolve(root, "node_modules/yjs/dist/yjs.mjs") },
		],
	},
	test: {
		setupFiles: [path.resolve(root, "test/harness/setup.ts")],
		// 기존 순수 테스트(src/**)와 신규 통합 테스트(test/**) 모두 수집.
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
	},
});
