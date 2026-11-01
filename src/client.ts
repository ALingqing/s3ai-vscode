/**
 * S3AI（furry.vg）OpenAI 兼容 API 客户端。
 * 不依赖 vscode，方便单独测试与复用。
 */

export interface RemoteModel {
	id: string;
	name?: string;
	owned_by?: string;
}

const CJK_CHARACTERS = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF\u{20000}-\u{2FA1F}]/gu;

export function estimateTokenCount(text: string): number {
	const cjkCharacters = text.match(CJK_CHARACTERS)?.length ?? 0;
	const otherCharacters = text.length - cjkCharacters;
	return Math.max(1, Math.ceil(cjkCharacters + otherCharacters / 3.5));
}

export class ApiHttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
		this.name = 'ApiHttpError';
	}
}

export class ApiStreamError extends Error {
	constructor(readonly model: string, readonly originalError: unknown) {
		const detail = originalError instanceof Error ? originalError.message : String(originalError);
		super(
			`S3AI：模型「${model}」的流式响应意外中断${detail ? `（${detail}）` : ''}。` +
			'通常是网络、代理或上游连接提前断开；请重试，若反复发生可缩短对话上下文或更换响应更快的模型。',
		);
		this.name = 'ApiStreamError';
	}
}

export interface ChatToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

export interface StreamHandlers {
	onText(text: string): void;
	onThinking?(text: string): void;
	onToolCall(call: { id: string; name: string; args: string }): void;
}

export interface ChatRequestOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: unknown[];
	tools?: ChatToolDef[];
	toolChoice?: 'auto' | 'required';
	signal: AbortSignal;
	handlers: StreamHandlers;
}

export function joinUrl(baseUrl: string, path: string): string {
	return baseUrl.replace(/\/+$/, '') + path;
}

async function readErrorMessage(res: Response): Promise<string> {
	let text = '';
	try {
		text = await res.text();
	} catch {
		/* ignore */
	}
	try {
		const j: any = JSON.parse(text);
		const msg = j?.error?.message ?? j?.message ?? text;
		return String(msg ?? '').trim() || `HTTP ${res.status}`;
	} catch {
		return (text || '').trim() || `HTTP ${res.status}`;
	}
}

/** 拉取模型列表（GET {baseUrl}/models） */
export async function fetchModelList(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<RemoteModel[]> {
	let res: Response;
	try {
		res = await fetch(joinUrl(baseUrl, '/models'), {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: 'application/json',
			},
			signal,
		});
	} catch (e: any) {
		if (e?.name === 'AbortError') {
			throw e;
		}
		throw new Error(`无法连接 S3AI（${baseUrl}）：${e?.message ?? e}`);
	}
	if (!res.ok) {
		throw new ApiHttpError(res.status, await readErrorMessage(res));
	}
	const json: any = await res.json().catch(() => undefined);
	const data = Array.isArray(json?.data) ? json.data : [];
	return data
		.filter((m: any) => m && typeof m.id === 'string' && m.id.length > 0)
		.map((m: any) => ({
			id: m.id as string,
			name: typeof m.name === 'string' ? m.name : undefined,
			owned_by: typeof m.owned_by === 'string' ? m.owned_by : undefined,
		}));
}

/** 流式对话（POST {baseUrl}/chat/completions，SSE） */
export async function streamChatCompletion(o: ChatRequestOptions): Promise<void> {
	const body: Record<string, unknown> = {
		model: o.model,
		messages: o.messages,
		stream: true,
	};
	if (o.tools && o.tools.length > 0) {
		body.tools = o.tools.map((t) => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description ?? '',
				parameters: t.parameters ?? { type: 'object', properties: {} },
			},
		}));
		body.tool_choice = o.toolChoice ?? 'auto';
	}

	let res: Response;
	try {
		res = await fetch(joinUrl(o.baseUrl, '/chat/completions'), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${o.apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal: o.signal,
		});
	} catch (e: any) {
		if (e?.name === 'AbortError') {
			return;
		}
		throw new Error(`无法连接 S3AI（${o.baseUrl}）：${e?.message ?? e}`);
	}

	if (!res.ok) {
		throw new ApiHttpError(res.status, await readErrorMessage(res));
	}

	// 少数网关请求了 stream 仍返回整包 JSON，这里兜底
	const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
	if (contentType.includes('application/json')) {
		const json: any = await res.json().catch(() => undefined);
		const msg = json?.choices?.[0]?.message;
		if (msg) {
			if (typeof msg.content === 'string' && msg.content) {
				o.handlers.onText(msg.content);
			}
			const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
			if (reasoning && o.handlers.onThinking) {
				o.handlers.onThinking(reasoning);
			}
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					const name = tc?.function?.name ?? '';
					if (!name) {
						continue;
					}
					const args = tc?.function?.arguments ?? '';
					o.handlers.onToolCall({
						id: typeof tc?.id === 'string' && tc.id ? tc.id : `call_${name}`,
						name,
						args: typeof args === 'string' ? args : JSON.stringify(args),
					});
				}
			}
		}
		return;
	}

	const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader?.();
	if (!reader) {
		throw new Error('S3AI：响应为空（没有数据流）。');
	}

	const decoder = new TextDecoder();
	const toolAcc = new Map<number, { id: string; name: string; args: string }>();
	let buf = '';
	let finished = false;
	const cancelReader = () => {
		void reader.cancel().catch(() => undefined);
	};
	o.signal.addEventListener('abort', cancelReader, { once: true });
	try {
		while (!finished && !o.signal.aborted) {
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (e) {
				if (o.signal.aborted) {
					return;
				}
				throw new ApiStreamError(o.model, e);
			}
			if (result.done) {
				buf += decoder.decode();
				break;
			}
			buf += decoder.decode(result.value, { stream: true });
			finished = processSseBuffer(buf, o, toolAcc);
			buf = getSseRemainder(buf);
		}
		if (o.signal.aborted) {
			return;
		}
		if (!finished && buf) {
			processSseLine(buf, o, toolAcc);
		}
	} finally {
		o.signal.removeEventListener('abort', cancelReader);
		if (o.signal.aborted) {
			cancelReader();
		}
		reader.releaseLock();
	}

	// 流结束后统一上报工具调用
	const ordered = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
	for (let i = 0; i < ordered.length; i++) {
		const acc = ordered[i][1];
		if (!acc.name) {
			continue;
		}
		o.handlers.onToolCall({
			id: acc.id || `call_${i + 1}`,
			name: acc.name,
			args: acc.args,
		});
	}
}

function processSseBuffer(
	buffer: string,
	options: ChatRequestOptions,
	toolAcc: Map<number, { id: string; name: string; args: string }>,
): boolean {
	let idx: number;
	while ((idx = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (processSseLine(line, options, toolAcc)) {
			return true;
		}
	}
	return false;
}

function getSseRemainder(buffer: string): string {
	const idx = buffer.lastIndexOf('\n');
	return idx < 0 ? buffer : buffer.slice(idx + 1);
}

function processSseLine(
	line: string,
	options: ChatRequestOptions,
	toolAcc: Map<number, { id: string; name: string; args: string }>,
): boolean {
	if (line.endsWith('\r')) {
		line = line.slice(0, -1);
	}
	if (!line || line.startsWith(':') || !line.startsWith('data:')) {
		return false;
	}
	const payload = line.slice(5).trim();
	if (payload === '[DONE]') {
		return true;
	}
	let chunk: any;
	try {
		chunk = JSON.parse(payload);
	} catch {
		return false;
	}
	handleChunk(chunk, options.handlers, toolAcc);
	return false;
}

function handleChunk(
	chunk: any,
	handlers: StreamHandlers,
	toolAcc: Map<number, { id: string; name: string; args: string }>,
): void {
	const choice = chunk?.choices?.[0];
	const delta = choice?.delta ?? choice?.message;
	if (!delta) {
		return;
	}
	if (typeof delta.content === 'string' && delta.content) {
		handlers.onText(delta.content);
	}
	const reasoning =
		typeof delta.reasoning_content === 'string'
			? delta.reasoning_content
			: typeof delta.reasoning === 'string'
				? delta.reasoning
				: '';
	if (reasoning && handlers.onThinking) {
		handlers.onThinking(reasoning);
	}
	if (Array.isArray(delta.tool_calls)) {
		for (const tc of delta.tool_calls) {
			const idx = typeof tc?.index === 'number' ? tc.index : 0;
			let acc = toolAcc.get(idx);
			if (!acc) {
				acc = { id: '', name: '', args: '' };
				toolAcc.set(idx, acc);
			}
			if (typeof tc?.id === 'string' && tc.id) {
				acc.id = tc.id;
			}
			const fn = tc?.function;
			if (fn) {
				if (typeof fn.name === 'string' && fn.name && !acc.name) {
					acc.name = fn.name;
				}
				if (typeof fn.arguments === 'string' && fn.arguments) {
					acc.args += fn.arguments;
				}
			}
		}
	}
}
