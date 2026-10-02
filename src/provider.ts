import * as vscode from 'vscode';
import {
	ApiHttpError,
	ChatToolDef,
	fetchModelList,
	RemoteModel,
	streamChatCompletion,
} from './client';

export const DEFAULT_BASE_URL = 'https://ai.furry.vg/v1';
const SECRET_API_KEY = 's3ai.apiKey';
const MODELS_CACHE_TTL = 5 * 60 * 1000;

const DEFAULT_MAX_INPUT = 114688; // 128k - 16k
const DEFAULT_MAX_OUTPUT = 16384;

/** 常见模型的能力预设（input/output 为该模型的上下文与输出上限） */
const MODEL_PRESETS: Record<string, { name?: string; input?: number; output?: number; vision?: boolean; tools?: boolean }> = {
	'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', input: 984000, output: 16000, vision: true, tools: true },
	'claude-opus-5': { name: 'Claude Opus 5', input: 984000, output: 16000, vision: true, tools: true },
	'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', input: 984000, output: 16000, vision: true, tools: true },
	'gpt-5.6-sol': { name: 'GPT-5.6 Sol', input: 1084000, output: 16000, vision: true, tools: true },
	'gpt-5.6-luna': { name: 'GPT-5.6 Luna', input: 1084000, output: 16000, vision: true, tools: true },
	'gpt-5.6-terra': { name: 'GPT-5.6 Terra', input: 1084000, output: 16000, vision: true, tools: true },
	'gpt-5.5': { name: 'GPT-5.5', input: 1084000, output: 16000, vision: true, tools: true },
	'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', input: 984000, output: 16000, vision: false, tools: true },
	'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', input: 984000, output: 16000, vision: false, tools: true },
	'kimi-k2.6': { name: 'Kimi K2.6', input: 246144, output: 16000, vision: true, tools: true },
	'glm-5.3-flash': { name: 'GLM 5.3 Flash', input: 984000, output: 16000, vision: true, tools: true },
	'grok-4.5': { name: 'Grok 4.5', input: 484000, output: 16000, vision: true, tools: true },
	'qwen3.8-max': { name: 'Qwen3.8 Max', input: 984000, output: 16000, vision: true, tools: true },
	'MiniMax-M3': { name: 'MiniMax M3', input: 984000, output: 16000, vision: true, tools: true },
};

interface ResolvedConfig {
	apiKey?: string;
	baseUrl: string;
}

interface ChatMessageLike {
	role?: unknown;
	content?: unknown;
}

export class S3AIProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	private readonly _disposables: vscode.Disposable[] = [];
	private _modelsCache?: { at: number; key: string; models: RemoteModel[] };
	private _lastConfig?: ResolvedConfig;
	private _noKeyNotified = false;
	readonly statusBar: vscode.StatusBarItem;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
		this.statusBar.text = '$(hubot) S3AI';
		this.statusBar.tooltip = new vscode.MarkdownString(
			'**S3AI**（furry.vg）— 点击管理模型与 API Key\n\n[文档](https://docs.furry.vg/)',
		);
		this.statusBar.command = 's3ai.manage';
		this.statusBar.show();

		this._disposables.push(
			this._onDidChange,
			this.statusBar,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('s3ai')) {
					this._modelsCache = undefined;
					this._onDidChange.fire();
				}
			}),
		);
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose();
		}
	}

	// ---------------- 配置解析 ----------------

	private async resolveConfig(options?: any): Promise<ResolvedConfig> {
		const cfg: Record<string, unknown> = (options?.configuration ?? {}) as Record<string, unknown>;
		const cfgKey = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() ? cfg.apiKey.trim() : undefined;
		const cfgBase = typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : undefined;
		let apiKey = cfgKey;
		if (!apiKey) {
			const stored = await this.context.secrets.get(SECRET_API_KEY);
			apiKey = stored && stored.trim() ? stored.trim() : undefined;
		}
		const baseUrl = cfgBase ?? DEFAULT_BASE_URL;
		this._lastConfig = { apiKey, baseUrl };
		return this._lastConfig;
	}

	private async currentConfig(): Promise<ResolvedConfig> {
		if (this._lastConfig?.apiKey) {
			return this._lastConfig;
		}
		const stored = await this.context.secrets.get(SECRET_API_KEY);
		this._lastConfig = {
			apiKey: stored && stored.trim() ? stored.trim() : undefined,
			baseUrl: this._lastConfig?.baseUrl ?? DEFAULT_BASE_URL,
		};
		return this._lastConfig;
	}

	// ---------------- 命令实现 ----------------

	async setApiKey(): Promise<void> {
		const value = await vscode.window.showInputBox({
			title: 'S3AI API Key',
			prompt: '在 https://ai.furry.vg 获取（sk- 开头）。Key 会保存在 VS Code 安全存储中。',
			placeHolder: 'sk-...',
			password: true,
			ignoreFocusOut: true,
			validateInput: (v) => (v.trim().length < 8 ? '看起来不像有效的 Key' : undefined),
		});
		if (value === undefined) {
			return;
		}
		await this.context.secrets.store(SECRET_API_KEY, value.trim());
		this._modelsCache = undefined;
		this._lastConfig = undefined;
		this._onDidChange.fire();
		void vscode.window.showInformationMessage('S3AI：API Key 已保存 ✓');
	}

	async clearApiKey(): Promise<void> {
		const ok = await vscode.window.showWarningMessage('要清除已保存的 S3AI API Key 吗？', { modal: true }, '清除');
		if (ok !== '清除') {
			return;
		}
		await this.context.secrets.delete(SECRET_API_KEY);
		this._modelsCache = undefined;
		this._lastConfig = undefined;
		this._onDidChange.fire();
		void vscode.window.showInformationMessage('S3AI：API Key 已清除');
	}

	refreshModels(): void {
		this._modelsCache = undefined;
		this._onDidChange.fire();
		void vscode.window.showInformationMessage('S3AI：模型列表已刷新');
	}

	async manage(): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			[
				{ id: 'set', label: '$(key) 设置 API Key', detail: '保存到 VS Code 安全存储' },
				{ id: 'clear', label: '$(trash) 清除 API Key' },
				{ id: 'refresh', label: '$(refresh) 刷新模型列表' },
				{ id: 'settings', label: '$(settings-gear) 打开 S3AI 设置', detail: '模型白名单（s3ai.models）' },
				{ id: 'docs', label: '$(book) 打开 S3AI 文档', detail: 'https://docs.furry.vg/' },
			],
			{ title: 'S3AI', placeHolder: '选择操作' },
		);
		if (!picked) {
			return;
		}
		switch (picked.id) {
			case 'set':
				await this.setApiKey();
				break;
			case 'clear':
				await this.clearApiKey();
				break;
			case 'refresh':
				this.refreshModels();
				break;
			case 'settings':
				void vscode.commands.executeCommand('workbench.action.openSettings', 's3ai');
				break;
			case 'docs':
				void vscode.commands.executeCommand('s3ai.openDocs');
				break;
		}
	}

	private promptForSetupOnce(): void {
		if (this._noKeyNotified) {
			return;
		}
		this._noKeyNotified = true;
		void vscode.window
			.showWarningMessage('S3AI：还没有配置 API Key，配置后才能使用模型。', '设置 API Key', '打开文档')
			.then((choice) => {
				if (choice === '设置 API Key') {
					void this.setApiKey();
				} else if (choice === '打开文档') {
					void vscode.commands.executeCommand('s3ai.openDocs');
				}
			});
	}

	// ---------------- LanguageModelChatProvider ----------------

	async provideLanguageModelChatInformation(
		options: any,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const { apiKey, baseUrl } = await this.resolveConfig(options);
		if (!apiKey) {
			if (!options?.silent) {
				this.promptForSetupOnce();
			}
			return [];
		}

		let models: RemoteModel[];
		try {
			models = await this.getModels(baseUrl, apiKey, token);
		} catch (e: any) {
			if (e?.name === 'AbortError') {
				return [];
			}
			if (!options?.silent) {
				void vscode.window.showWarningMessage(`S3AI：获取模型列表失败。${mapError(e, baseUrl)}`);
			}
			return [];
		}

		const allow = vscode.workspace.getConfiguration('s3ai').get<string[]>('models', []) ?? [];
		const list = allow.length > 0 ? models.filter((m) => allow.includes(m.id)) : models;
		return list.map((m) => this.toModelInfo(m, baseUrl));
	}

	private async getModels(baseUrl: string, apiKey: string, token: vscode.CancellationToken): Promise<RemoteModel[]> {
		const cacheKey = `${baseUrl}|${apiKey.slice(-8)}`;
		if (this._modelsCache && this._modelsCache.key === cacheKey && Date.now() - this._modelsCache.at < MODELS_CACHE_TTL) {
			return this._modelsCache.models;
		}
		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());
		try {
			const models = await fetchModelList(baseUrl, apiKey, ac.signal);
			this._modelsCache = { at: Date.now(), key: cacheKey, models };
			return models;
		} finally {
			sub.dispose();
		}
	}

	private toModelInfo(m: RemoteModel, baseUrl: string): vscode.LanguageModelChatInformation {
		const preset = MODEL_PRESETS[m.id] ?? {};
		return {
			id: m.id,
			name: preset.name ?? m.id,
			family: m.id,
			version: '1.0.0',
			detail: 'S3AI',
			tooltip: `S3AI（${hostOf(baseUrl)}）\n模型 ID：${m.id}`,
			maxInputTokens: preset.input ?? DEFAULT_MAX_INPUT,
			maxOutputTokens: preset.output ?? DEFAULT_MAX_OUTPUT,
			capabilities: {
				toolCalling: preset.tools ?? true,
				imageInput: preset.vision ?? false,
			},
		};
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly any[],
		options: any,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const { apiKey, baseUrl } = await this.currentConfig();
		if (!apiKey) {
			throw new Error('S3AI：未配置 API Key。请在命令面板运行「S3AI: 设置 API Key」。');
		}

		const chatMessages = convertMessages(messages);
		const tools: ChatToolDef[] | undefined =
			Array.isArray(options?.tools) && options.tools.length > 0
				? options.tools.map((t: any) => ({
						name: String(t?.name ?? ''),
						description: String(t?.description ?? ''),
						parameters: t?.inputSchema,
					}))
				: undefined;
		const toolChoice: 'auto' | 'required' =
			options?.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';

		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());
		const pendingCalls: { id: string; name: string; args: string }[] = [];
		const ThinkingPart: any = (vscode as any).LanguageModelThinkingPart;

		try {
			await streamChatCompletion({
				baseUrl,
				apiKey,
				model: model.id,
				messages: chatMessages,
				tools,
				toolChoice,
				signal: ac.signal,
				handlers: {
					onText: (t) => progress.report(new vscode.LanguageModelTextPart(t)),
					onThinking: ThinkingPart
						? (t: string) => progress.report(new ThinkingPart(t))
						: undefined,
					onToolCall: (c) => pendingCalls.push(c),
				},
			});
		} catch (e: any) {
			if (e?.name === 'AbortError') {
				return;
			}
			throw new Error(mapError(e, baseUrl));
		} finally {
			sub.dispose();
		}

		for (const c of pendingCalls) {
			if (!c.name) {
				continue;
			}
			progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, parseToolArgs(c.args)));
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		const s = typeof text === 'string' ? text : messageToText(text);
		return Math.max(1, Math.ceil(s.length / 3.5));
	}
}

// ---------------- 消息转换 ----------------

function convertMessages(messages: readonly any[]): any[] {
	const out: any[] = [];
	const Role: any = vscode.LanguageModelChatMessageRole;

	for (const msg of messages as ChatMessageLike[]) {
		if (!msg) {
			continue;
		}
		const roleName =
			msg.role === Role?.Assistant ? 'assistant' : Role?.System !== undefined && msg.role === Role.System ? 'system' : 'user';
		const content = Array.isArray(msg.content) ? (msg.content as any[]) : [];

		const texts: string[] = [];
		const images: { mime: string; data: Uint8Array }[] = [];
		const toolCalls: { id: string; name: string; args: string }[] = [];
		const toolResults: { id: string; text: string }[] = [];
		const DataPart: any = (vscode as any).LanguageModelDataPart;

		for (const part of content) {
			if (part == null) {
				continue;
			}
			if (part instanceof vscode.LanguageModelTextPart) {
				texts.push(part.value);
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					name: part.name,
					args: safeStringify(part.input ?? {}),
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ id: part.callId, text: toolResultToString(part.content) });
				continue;
			}
			if (
				DataPart &&
				part instanceof DataPart &&
				typeof part.mime === 'string' &&
				part.mime.startsWith('image/') &&
				part.data
			) {
				images.push({ mime: part.mime, data: part.data as Uint8Array });
				continue;
			}
			const t = unknownPartToText(part);
			if (t !== undefined) {
				texts.push(t);
			}
		}

		if (roleName === 'assistant') {
			if (!texts.length && !toolCalls.length) {
				continue;
			}
			const m: any = { role: 'assistant' };
			if (texts.length) {
				m.content = texts.join('');
			} else {
				m.content = null;
			}
			if (toolCalls.length) {
				m.tool_calls = toolCalls.map((tc, i) => ({
					id: tc.id || `call_${i + 1}`,
					type: 'function',
					function: { name: tc.name, arguments: tc.args || '{}' },
				}));
			}
			out.push(m);
		} else if (roleName === 'system') {
			if (texts.length) {
				out.push({ role: 'system', content: texts.join('\n') });
			}
		} else {
			for (const tr of toolResults) {
				out.push({ role: 'tool', tool_call_id: tr.id, content: tr.text || '' });
			}
			if (texts.length || images.length) {
				if (images.length) {
					const arr: any[] = [];
					if (texts.length) {
						arr.push({ type: 'text', text: texts.join('\n') });
					}
					for (const img of images) {
						arr.push({
							type: 'image_url',
							image_url: { url: `data:${img.mime};base64,${Buffer.from(img.data).toString('base64')}` },
						});
					}
					out.push({ role: 'user', content: arr });
				} else {
					out.push({ role: 'user', content: texts.join('') });
				}
			}
		}
	}
	return out;
}

function toolResultToString(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return content == null ? '' : safeStringify(content);
	}
	const parts: string[] = [];
	for (const p of content as any[]) {
		if (typeof p === 'string') {
			parts.push(p);
		} else if (typeof p?.value === 'string') {
			parts.push(p.value);
		} else if (typeof p?.text === 'string') {
			parts.push(p.text);
		} else if (p?.mime && p?.data) {
			parts.push(`[二进制内容 ${p.mime}]`);
		} else if (p != null) {
			parts.push(safeStringify(p));
		}
	}
	return parts.join('\n');
}

function unknownPartToText(part: any): string | undefined {
	const ctor = part?.constructor?.name ?? '';
	if (/Thinking/i.test(ctor)) {
		return undefined; // 思考内容不回传给模型
	}
	if (typeof part?.value === 'string') {
		return part.value;
	}
	return undefined;
}

function messageToText(message: vscode.LanguageModelChatMessage): string {
	const parts: string[] = [];
	for (const part of (message as any).content ?? []) {
		if (typeof part === 'string') {
			parts.push(part);
		} else if (part?.mime && part?.data) {
			parts.push('[图片]');
		} else if (typeof part?.value === 'string') {
			parts.push(part.value);
		}
	}
	return parts.join('\n');
}

// ---------------- 杂项 ----------------

function parseToolArgs(args: string): object {
	const s = (args ?? '').trim();
	if (!s) {
		return {};
	}
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' ? v : { value: v };
	} catch {
		return { raw: s };
	}
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

function mapError(e: any, baseUrl: string): string {
	if (e instanceof ApiHttpError) {
		if (e.status === 401) {
			return 'S3AI：API Key 无效或未授权（401）。请运行「S3AI: 设置 API Key」重新配置。';
		}
		if (e.status === 403) {
			return `S3AI：服务器拒绝了请求（403）。${e.message}`;
		}
		if (e.status === 429) {
			return `S3AI：请求过于频繁或额度不足（429）。${e.message}`;
		}
		return `S3AI 请求失败（HTTP ${e.status}）：${e.message}`;
	}
	if (e?.name === 'AbortError') {
		return 'S3AI：请求已取消。';
	}
	return e?.message ? String(e.message) : String(e);
}
