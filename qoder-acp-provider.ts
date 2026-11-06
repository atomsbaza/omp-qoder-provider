// Qoder via ACP (Agent Client Protocol) as an omp model provider.
// Spawns `qoder --acp` (official ACP server mode) as a persistent child per omp
// session. omp answers every permission request and client-side fs call, so the
// child's tool usage is gated from inside omp. The child keeps its own context
// and streams real text deltas.
//
// Requires @agentclientprotocol/sdk (Apache-2.0) in the vendor dir — see
// install.sh. Provider id is `qoder-acp`; the simpler print-mode provider
// (`qoder`) in qoder-provider.ts remains available as a fallback.
//
// Knobs:
//   QODER_ACP_BIN                 qoder binary (default "qoder")
//   QODER_ACP_MODE                child session mode: default | acceptEdits | auto
//                                 (default "acceptEdits")
//   QODER_ACP_PERMISSIONS         allow | deny  — how this extension answers
//                                 permission requests that reach omp
//                                 (default "allow")
//   QODER_BRIDGE_CONTEXT_WINDOW   context window passed to the child (default 1000000)
//   QODER_ACP_LOG                 append protocol diagnostics to a file
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable, Readable } from "node:stream";

const QODER_BIN = process.env.QODER_ACP_BIN || "qoder";
const SESSION_MODE = process.env.QODER_ACP_MODE || "acceptEdits";
const PERMISSION_POLICY = process.env.QODER_ACP_PERMISSIONS || "allow";
const CONTEXT_WINDOW = Number(process.env.QODER_BRIDGE_CONTEXT_WINDOW) || 1_000_000;
const DEBUG_LOG = process.env.QODER_ACP_LOG;
const VENDOR_SDK = join(
	homedir(),
	".omp",
	"agent",
	"vendor",
	"qoder-sdk",
	"node_modules",
	"@agentclientprotocol",
	"sdk",
	"dist",
	"acp.js",
);

function debugLog(line: string): void {
	if (!DEBUG_LOG) return;
	try {
		writeFileSync(`${DEBUG_LOG}.acp`, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
	} catch {
		// diagnostics only; never break the stream over log failures
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// -m values are Qoder display names (`qodercli --list-models`).
const MODEL_SPECS: Array<{ id: string; flag?: string; name: string }> = [
	{ id: "auto", name: "Qoder Auto (ACP)" },
	{ id: "efficient", flag: "Efficient", name: "Qoder Efficient (ACP)" },
	{ id: "qwen3.8-max", flag: "Qwen3.8-Max", name: "Qwen3.8-Max (Qoder ACP)" },
	{ id: "qwen3.8-flash", flag: "Qwen3.8-Flash", name: "Qwen3.8-Flash (Qoder ACP)" },
	{ id: "kimi-k3.1-pro", flag: "Kimi-K3.1-Pro", name: "Kimi K3.1 Pro (Qoder ACP)" },
	{ id: "kimi-k2.8-preview", flag: "Kimi-K2.8-Preview", name: "Kimi K2.8 Preview (Qoder ACP)" },
	{ id: "glm-5.3", flag: "GLM-5.3", name: "GLM-5.3 (Qoder ACP)" },
	{ id: "glm-5.3-flash", flag: "GLM-5.3-Flash", name: "GLM-5.3 Flash (Qoder ACP)" },
	{ id: "deepseek-v4-pro", flag: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro (Qoder ACP)" },
	{ id: "deepseek-flash", flag: "DeepSeek-Flash", name: "DeepSeek Flash (Qoder ACP)" },
	{ id: "minimax-m3.1-flash", flag: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash (Qoder ACP)" },
];

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of asArray(content)) {
		if (!isRecord(block)) continue;
		const text = asString(block.text);
		if (block.type === "text" && text) parts.push(text);
		else if (block.type === "image") parts.push("[image seen earlier]");
	}
	return parts.join("\n");
}

// Serialize only the messages not yet delivered to this child session.
function serializeDelta(messages: unknown[], fromIndex: number): string {
	const parts: string[] = [];
	for (let i = fromIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (!isRecord(msg)) continue;
		const text = textFromContent(msg.content) || textFromContent(isRecord(msg.output) ? msg.output.content : undefined);
		if (!text.trim()) continue;
		if (msg.role === "toolResult") {
			parts.push(`[tool result: ${asString(msg.toolName) ?? "tool"}]\n${text}`);
		} else {
			parts.push(`[${asString(msg.role) ?? "message"}]\n${text}`);
		}
	}
	return parts.join("\n\n");
}

interface AcpModules {
	ClientSideConnection: new (toClient: (agent: unknown) => unknown, stream: unknown) => AcpConnection;
	ndJsonStream: (input: unknown, output: unknown) => unknown;
}

interface AcpConnection {
	initialize(params: unknown): Promise<{ protocolVersion?: number }>;
	newSession(params: unknown): Promise<{ sessionId: string; modes?: unknown }>;
	setSessionMode(params: unknown): Promise<unknown>;
	prompt(params: unknown): Promise<{ stopReason?: string }>;
	cancel(params: unknown): void;
}

let acpModules: AcpModules | null = null;

async function loadAcp(): Promise<AcpModules> {
	if (acpModules) return acpModules;
	// Static import impossible: the SDK lives in the install.sh-managed vendor
	// directory whose path is runtime-configurable and may be absent.
	acpModules = (await import(pathToFileURL(VENDOR_SDK).href)) as AcpModules;
	return acpModules;
}

interface LiveSession {
	child: ChildProcess;
	connection: AcpConnection;
	acpSessionId: string;
	sentCount: number;
	busy: boolean;
	onUpdate: ((params: unknown) => void) | null;
}

const sessions = new Map<string, LiveSession>();

export default function qoderAcpProvider(pi: ExtensionAPI) {
	pi.registerProvider("qoder-acp", {
		baseUrl: "qoder://acp",
		apiKey: "qodercli-local-auth",
		api: "qoder-acp-bridge",
		streamSimple(model: unknown, context: unknown, options: unknown) {
			const stream = new AssistantMessageEventStream();
			void runBridge(stream, model, context, options);
			return stream;
		},
		models: MODEL_SPECS.map((spec) => ({
			id: spec.id,
			name: spec.name,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CONTEXT_WINDOW,
			maxTokens: 16_384,
		})),
	});
	pi.on("session_shutdown", (event: { sessionId?: string }) => {
		const live = sessions.get(event.sessionId ?? "");
		if (live) {
			sessions.delete(event.sessionId ?? "");
			try {
				live.child.kill("SIGTERM");
			} catch {}
		}
	});
}

async function ensureSession(sessionKey: string, cwd: string, modelId: string): Promise<LiveSession> {
	const existing = sessions.get(sessionKey);
	if (existing) return existing;
	const { ClientSideConnection, ndJsonStream } = await loadAcp();
	const spec = MODEL_SPECS.find((m) => m.id === modelId);
	const spawnArgs = ["--acp"];
	if (spec?.flag) spawnArgs.push("-m", spec.flag);
	debugLog(`spawn cwd=${cwd} args=${spawnArgs.join(" ")}`);
	const child = spawn(QODER_BIN, spawnArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
	child.stderr?.resume();
	const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
	const live: LiveSession = {
		child,
		connection: null as unknown as AcpConnection,
		acpSessionId: "",
		sentCount: 0,
		busy: false,
		onUpdate: null,
	};
	const handlers = {
		async requestPermission(params: Record<string, unknown>) {
			const title = isRecord(params.toolCall) ? asString(params.toolCall.title) : undefined;
			debugLog(`permission: ${title ?? "?"} policy=${PERMISSION_POLICY}`);
			const options = asArray(params.options);
			if (PERMISSION_POLICY !== "allow") {
				const reject = options.find((o) => isRecord(o) && o.kind === "reject_once");
				return {
					outcome: { outcome: "selected", optionId: isRecord(reject) ? reject.optionId : undefined },
				};
			}
			const allow = options.find((o) => isRecord(o) && o.kind === "allow_once") ?? options[0];
			return {
				outcome: { outcome: "selected", optionId: isRecord(allow) ? allow.optionId : undefined },
			};
		},
		async sessionUpdate(params: unknown) {
			live.onUpdate?.(params);
			return {};
		},
		async readTextFile(params: Record<string, unknown>) {
			const filePath = asString(params.path) ?? "";
			debugLog(`fs.read: ${filePath}`);
			try {
				return { content: readFileSync(filePath, "utf8") };
			} catch (error) {
				return { content: "", error: String(error) };
			}
		},
		async writeTextFile(params: Record<string, unknown>) {
			const filePath = asString(params.path) ?? "";
			const content = asString(params.content) ?? "";
			debugLog(`fs.write: ${filePath} (${content.length} chars)`);
			writeFileSync(filePath, content, "utf8");
			return {};
		},
	};
	const connection = new ClientSideConnection(() => handlers, stream);
	await connection.initialize({
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
	});
	const created = await connection.newSession({ cwd, mcpServers: [] });
	try {
		await connection.setSessionMode({ sessionId: created.sessionId, modeId: SESSION_MODE });
	} catch (error) {
		debugLog(`setSessionMode(${SESSION_MODE}) unsupported: ${String(error).slice(0, 120)}`);
	}
	live.connection = connection;
	live.acpSessionId = created.sessionId;
	sessions.set(sessionKey, live);
	child.on("close", () => {
		sessions.delete(sessionKey);
	});
	return live;
}

async function runBridge(stream: AssistantMessageEventStream, model: unknown, context: unknown, options: unknown) {
	const signal = isRecord(options) && options.signal instanceof AbortSignal ? (options.signal as AbortSignal) : undefined;
	const sessionId = isRecord(options) ? asString(options.sessionId) : undefined;
	const cwd = isRecord(options) && typeof options.cwd === "string" ? options.cwd : process.cwd();
	const sessionKey = sessionId ?? `cwd:${cwd}`;
	const modelId = isRecord(model) ? asString(model.id) : undefined;

	if (signal?.aborted) {
		stream.push({
			type: "error",
			reason: "aborted",
			error: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted before start" },
		});
		return;
	}

	const messages = isRecord(context) ? asArray(context.messages) : [];
	let live: LiveSession;
	try {
		live = await ensureSession(sessionKey, cwd, modelId ?? "auto");
	} catch (error) {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: `Failed to start qoder --acp: ${String(error).slice(0, 200)}`,
			},
		});
		return;
	}

	// Child context drifted from what we sent (compaction, fork, new conversation):
	// a smaller history means the transcript was rewritten, so restart the child
	// session and resend everything.
	if (messages.length < live.sentCount) {
		debugLog(`history shrank (${live.sentCount} -> ${messages.length}); respawning child session`);
		sessions.delete(sessionKey);
		try {
			live.child.kill("SIGTERM");
		} catch {}
		live = await ensureSession(sessionKey, cwd, modelId ?? "auto");
	}

	const delta = serializeDelta(messages, live.sentCount);
	live.sentCount = messages.length;
	const partial: JsonRecord & {
		role: string;
		content: ContentBlock[];
		stopReason: string;
		timestamp: number;
		usage: Record<string, number | Record<string, number>>;
		errorMessage?: string;
	} = {
		role: "assistant",
		content: [],
		api: (isRecord(model) ? asString(model.api) : undefined) ?? "qoder-acp-bridge",
		provider: "qoder",
		model: modelId ?? "auto",
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const failOnce = (aborted: boolean, errorMessage: string) => {
		if (finished) return;
		finished = true;
		debugLog(`error aborted=${String(aborted)} msg=${errorMessage.slice(0, 200)}`);
		partial.stopReason = aborted ? "aborted" : "error";
		partial.errorMessage = errorMessage;
		stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: partial });
	};

	let finished = false;

	// Serialize prompts per session: ACP sessions process one prompt at a time.
	const previousBusy = live.busy;
	if (previousBusy) {
		failOnce(false, "another prompt is still running in this qoder ACP session");
		return;
	}
	live.busy = true;

	stream.push({ type: "start", partial });

	const emitTextChunk = (text: string) => {
		if (!text) return;
		const last = partial.content[partial.content.length - 1];
		if (last?.type === "text") {
			last.text += text;
		} else {
			partial.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: partial.content.length - 1, partial });
		}
		const contentIndex = partial.content.length - 1;
		stream.push({ type: "text_delta", contentIndex, delta: text, partial });
	};

	const onSessionUpdate = (params: unknown) => {
		if (!isRecord(params) || !isRecord(params.update)) return;
		const update = params.update;
		const kind = asString(update.sessionUpdate);
		if (kind === "agent_message_chunk" && isRecord(update.content) && update.content.type === "text") {
			emitTextChunk(asString(update.content.text) ?? "");
		}
	};

	live.onUpdate = onSessionUpdate;
	signal?.addEventListener("abort", () => {
		try {
			live.connection.cancel({ sessionId: live.acpSessionId });
		} catch {}
		try {
			live.child.kill("SIGTERM");
		} catch {}
	}, { once: true });

	try {
		const result = await live.connection.prompt({
			sessionId: live.acpSessionId,
			prompt: [{ type: "text", text: delta || "Continue." }],
		});
		finished = true;
		const lastText = partial.content[partial.content.length - 1];
		if (lastText?.type === "text") stream.push({ type: "text_end", contentIndex: partial.content.length - 1, partial });
		else if (partial.content.length === 0) {
			partial.content.push({ type: "text", text: "" });
			emitTextChunk("");
			stream.push({ type: "text_end", contentIndex: partial.content.length - 1, partial });
		}
		const stopRaw = asString(result.stopReason) ?? "end_turn";
		partial.stopReason = stopRaw === "refusal" || stopRaw === "error" ? "error" : "stop";
		stream.push({ type: "done", reason: "stop", message: partial });
	} catch (error) {
		failOnce(signal?.aborted === true, `qoder ACP prompt failed: ${String(error).slice(0, 200)}`);
	} finally {
		live.busy = false;
		live.onUpdate = null;
	}
}

function createEmptyUsage(): Record<string, number | Record<string, number>> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

type JsonRecord = Record<string, unknown>;
interface ContentBlock {
	type: "text" | "thinking";
	text?: string;
	thinking?: string;
}
