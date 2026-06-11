import { requestUrl } from "obsidian";
import { utf8ToB64 } from "../util/b64";

/**
 * Obsidian requestUrl 기반 fetch 구현.
 *
 * PouchDB-http 어댑터는 내부적으로 fetch를 호출하는데, Obsidian 모바일(Android)에서
 * 표준 fetch는 CORS 제약에 걸린다. requestUrl은 네이티브 계층에서 요청하므로 CORS를
 * 우회한다. PouchDB의 { fetch } 옵션에 이 함수를 넘겨 데스크톱/모바일 모두에서 동작시킨다.
 *
 * requestUrl 응답을 표준 Response 객체로 감싸 반환하므로 PouchDB가 기대하는
 * .ok / .status / .json() / .text() / .arrayBuffer() / headers.get() 이 모두 동작한다.
 * (Response 전역은 Electron 렌더러와 모바일 웹뷰 모두에 존재한다.)
 */
export function createObsidianFetch(username: string, password: string): typeof fetch {
	const authHeader = basicAuth(username, password);

	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? "GET").toUpperCase();

		const headers: Record<string, string> = {};
		const incoming = new Headers(init?.headers as HeadersInit | undefined);
		incoming.forEach((value, key) => {
			headers[key] = value;
		});
		if (authHeader && !headers["Authorization"] && !headers["authorization"]) {
			headers["Authorization"] = authHeader;
		}

		const body = await normalizeBody(init?.body);

		const resp = await requestUrl({
			url,
			method,
			headers,
			body,
			throw: false, // PouchDB가 상태 코드(404/409 등)를 직접 처리하도록
		});

		return new Response(resp.arrayBuffer, {
			status: resp.status,
			statusText: statusText(resp.status),
			headers: sanitizeResponseHeaders(resp.headers as Record<string, string>),
		});
	}) as typeof fetch;
}

/**
 * 응답 헤더 정리.
 *
 * requestUrl은 gzip 등으로 인코딩된 body를 자동으로 디코딩해서 주지만
 * Content-Encoding / Content-Length 헤더는 원본 그대로 남긴다. 그 헤더를 Response에
 * 그대로 넘기면 (특히 iOS WKWebView에서) 이미 디코딩된 body를 다시 디코딩하려다
 * body가 깨진다. 인코딩/길이 관련 헤더를 제거해 Response가 body를 그대로 읽게 한다.
 */
function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
	const drop = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (drop.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

function basicAuth(username: string, password: string): string {
	if (!username) return "";
	const raw = `${username}:${password}`;
	return `Basic ${utf8ToB64(raw)}`;
}

async function normalizeBody(body: BodyInit | null | undefined): Promise<string | ArrayBuffer | undefined> {
	if (body == null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	if (typeof Blob !== "undefined" && body instanceof Blob) return await body.arrayBuffer();
	// URLSearchParams 등 기타 형태
	return String(body);
}

function statusText(status: number): string {
	const map: Record<number, string> = {
		200: "OK",
		201: "Created",
		202: "Accepted",
		304: "Not Modified",
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		409: "Conflict",
		412: "Precondition Failed",
		500: "Internal Server Error",
	};
	return map[status] ?? "";
}
