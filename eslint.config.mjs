// eslint(평가 C-3) — 수동 규율로 지켜오던 비동기 위생을 CI에서 강제한다.
// 의도적으로 최소 규칙만 켠다: 목적은 floating promise·잘못 전달된 promise의 회귀 차단이지
// 스타일 통일이 아니다(스타일은 기존 코드 관례를 따른다).
import tseslint from "typescript-eslint";

export default tseslint.config({
	files: ["src/**/*.ts"],
	ignores: ["src/**/*.test.ts"],
	languageOptions: {
		parser: tseslint.parser,
		parserOptions: {
			projectService: true,
			tsconfigRootDir: import.meta.dirname,
		},
	},
	plugins: { "@typescript-eslint": tseslint.plugin },
	rules: {
		// 처리되지 않은 promise는 조용한 미실행/미보고 오류가 된다 — `void` 접두(의도 표시)만 허용.
		"@typescript-eslint/no-floating-promises": "error",
		// 조건식·콜백 자리에 promise를 잘못 넘기는 흔한 실수(if (isX()) 등) 차단.
		"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
	},
});
