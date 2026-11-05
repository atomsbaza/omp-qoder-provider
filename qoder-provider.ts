// Qoder as an omp model provider: spawns the local `qodercli` binary in
// headless print mode per request and translates its stream-json output into
// canonical AssistantMessageEvents. The child authenticates with its own
// Qoder sign-in (no credential crosses this boundary) and owns its own tool
// loop; the final narration is surfaced as the model response.
//
// Knobs:
//   QODER_BRIDGE_BIN               qodercli binary (default "qodercli")
//   QODER_BRIDGE_PERMISSION_MODE   child permission mode (default "dont_ask";
//                                  e.g. "accept_edits" lets the child edit files)
//   QODER_BRIDGE_LOG               append spawn/result diagnostics to this file
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const QODER_BIN = process.env.QODER_BRIDGE_BIN || "qodercli";
const PERMISSION_MODE = process.env.QODER_BRIDGE_PERMISSION_MODE || "dont_ask";
const MAX_PROMPT_CHARS = 300_000;
const DEBUG_LOG = process.env.QODER_BRIDGE_LOG;

function debugLog(line: string): void {
	if (!DEBUG_LOG) return;
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
	} catch (error) {
		process.stderr.write(`qoder-bridge log failed: ${String(error)}\n`);
	}
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function createEmptyUsage(): Record<string, number | Record<string, number>> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// -m values are Qoder display names (`qodercli --list-models`).
const MODEL_SPECS: Array<{ id: string; flag?: string; name: string; contextWindow: number }> = [
	{ id: "auto", name: "Qoder Auto", contextWindow: 128_000 },
	{ id: "efficient", flag: "Efficient", name: "Qoder Efficient", contextWindow: 128_000 },
	{ id: "qwen3.8-max", flag: "Qwen3.8-Max", name: "Qwen3.8-Max (Qoder)", contextWindow: 128_000 },
	{ id: "qwen3.8-flash", flag: "Qwen3.8-Flash", name: "Qwen3.8-Flash (Qoder)", contextWindow: 128_000 },
	{ id: "kimi-k3.1-pro", flag: "Kimi-K3.1-Pro", name: "Kimi K3.1 Pro (Qoder)", contextWindow: 128_000 },
	{ id: "kimi-k2.8-preview", flag: "Kimi-K2.8-Preview", name: "Kimi K2.8 Preview (Qoder)", contextWindow: 128_000 },
	{ id: "glm-5.3", flag: "GLM-5.3", name: "GLM-5.3 (Qoder)", contextWindow: 128_000 },
	{ id: "glm-5.3-flash", flag: "GLM-5.3-Flash", name: "GLM-5.3 Flash (Qoder)", contextWindow: 128_000 },
	{ id: "deepseek-v4-pro", flag: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro (Qoder)", contextWindow: 128_000 },
	{ id: "deepseek-flash", flag: "DeepSeek-Flash", name: "DeepSeek Flash (Qoder)", contextWindow: 128_000 },
	{ id: "minimax-m3.1-flash", flag: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash (Qoder)", contextWindow: 128_000 },
];

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of asArray(content)) {
		if (!isRecord(block)) continue;
		const text = asString(block.text);
		if (block.type === "text" && text) parts.push(text);
		else if (block.type === "image") parts.push("[image omitted]");
	}
	return parts.join("\n");
}

function serializeContext(context: unknown): string {
	const messages = isRecord(context) ? asArray(context.messages) : [];
	const parts: string[] = [];
	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		const text =
			textFromContent(msg.content) || textFromContent(isRecord(msg.output) ? msg.output.content : undefined);
		if (!text.trim()) continue;
		if (msg.role === "toolResult") {
			parts.push(`[tool result: ${asString(msg.toolName) ?? "tool"}]\n${text}`);
		} else {
			parts.push(`[${asString(msg.role) ?? "message"}]\n${text}`);
		}
	}
	const transcript = parts.join("\n\n");
	if (transcript.length <= MAX_PROMPT_CHARS) return transcript;
	return "[earlier conversation truncated]\n\n" + transcript.slice(transcript.length - MAX_PROMPT_CHARS);
}

function childEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(OMP_|PI_)/.test(key)) continue;
		if (/_API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$/.test(key) && !key.startsWith("QODER_")) continue;
		env[key] = value;
	}
	return env;
}

interface ContentBlock {
	type: "text" | "thinking";
	text?: string;
	thinking?: string;
}

export default function qoderProvider(pi: ExtensionAPI) {
	pi.registerProvider("qoder", {
		baseUrl: "qoder://local-cli-bridge",
		apiKey: "qodercli-local-auth",
		api: "qoder-cli-bridge",
		streamSimple(model: unknown, context: unknown, options: unknown) {
			const stream = new AssistantMessageEventStream();
			void runBridge(stream, model, context, options);
			return stream;
		},
		models: MODEL_SPECS.map((spec) => ({
			id: spec.id,
			name: spec.name,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: spec.contextWindow,
			maxTokens: 16_384,
		})),
	});
}

async function runBridge(stream: AssistantMessageEventStream, model: unknown, context: unknown, options: unknown) {
	const signal =
		isRecord(options) && options.signal instanceof AbortSignal ? (options.signal as AbortSignal) : undefined;
	if (signal?.aborted) {
		stream.push({
			type: "error",
			reason: "aborted",
			error: {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request aborted before start",
			},
		});
		return;
	}

	const modelId = isRecord(model) ? asString(model.id) : undefined;
	const spec = MODEL_SPECS.find((m) => m.id === modelId);
	const flag = spec?.flag;
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--no-session-persistence",
		"--permission-mode",
		PERMISSION_MODE,
		"--strict-mcp-config",
		"--mcp-config",
		'{"mcpServers":{}}',
	];
	if (flag) args.push("-m", flag);
	const maxTokens = isRecord(options) ? options.maxTokens : undefined;
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
		args.push("--max-output-tokens", String(Math.floor(maxTokens)));
	}

	const cwd = isRecord(options) && typeof options.cwd === "string" ? options.cwd : process.cwd();
	debugLog(`spawn model=${String(modelId)} cwd=${cwd} args=${args.join(" ")}`);
	let child: ChildProcess;
	try {
		child = spawn(QODER_BIN, args, { cwd, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		stream.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: `Failed to spawn ${QODER_BIN}: ${String(error)}`,
			},
		});
		return;
	}

	const onAbort = () => {
		try {
			child.kill("SIGTERM");
		} catch {}
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	// Canonical in-flight message: omp snapshots `partial` on every event, so it
	// must exist with usage (incl. cost) from the first `start`.
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
		api: (isRecord(model) ? asString(model.api) : undefined) ?? "qoder-cli-bridge",
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

	const emitText = (text: string) => {
		partial.content.push({ type: "text", text });
		const contentIndex = partial.content.length - 1;
		stream.push({ type: "text_start", contentIndex, partial });
		stream.push({ type: "text_delta", contentIndex, delta: text, partial });
		stream.push({ type: "text_end", contentIndex, content: text, partial });
	};

	const emitThinking = (thinking: string) => {
		partial.content.push({ type: "thinking", thinking });
		const contentIndex = partial.content.length - 1;
		stream.push({ type: "thinking_start", contentIndex, partial });
		stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial });
		stream.push({ type: "thinking_end", contentIndex, content: thinking, partial });
	};

	stream.push({ type: "start", partial });

	const stderrTail: string[] = [];
	let finished = false;
	let stdoutBuf = "";

	const handleAssistantBlocks = (blocks: unknown[]) => {
		for (const block of blocks) {
			if (!isRecord(block)) continue;
			const text = asString(block.text);
			const thinking = asString(block.thinking);
			if (block.type === "text" && text) emitText(text);
			else if (block.type === "thinking" && thinking) emitThinking(thinking);
		}
	};

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		if (event.type === "assistant" && isRecord(event.message)) {
			handleAssistantBlocks(asArray(event.message.content));
			return;
		}
		if (event.type !== "result") return;
		debugLog(
			`result subtype=${String(event.subtype)} isError=${String(event.is_error)} credits=${String(event.total_credits)}`,
		);
		finished = true;
		if (event.is_error === true) {
			failOnce(false, asString(event.result) ?? "Qoder run failed");
			return;
		}
		const finalText = asString(event.result);
		if (partial.content.every((block) => block.type !== "text") && finalText) emitText(finalText);
		const reported = isRecord(event.usage) ? event.usage : {};
		const usage = partial.usage;
		usage.input = typeof reported.input_tokens === "number" ? reported.input_tokens : 0;
		usage.output = typeof reported.output_tokens === "number" ? reported.output_tokens : 0;
		usage.totalTokens = (usage.input as number) + (usage.output as number);
		partial.details = { credits: event.total_credits, provider: "qoder" };
		stream.push({ type: "done", reason: "stop", message: partial });
	};

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		let newline = stdoutBuf.indexOf("\n");
		while (newline >= 0) {
			handleLine(stdoutBuf.slice(0, newline));
			stdoutBuf = stdoutBuf.slice(newline + 1);
			newline = stdoutBuf.indexOf("\n");
		}
	});

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrTail.push(chunk);
		if (stderrTail.length > 20) stderrTail.shift();
	});

	child.on("error", (error) => {
		failOnce(false, `qodercli process error: ${error.message}`);
	});

	child.on("close", (code) => {
		signal?.removeEventListener("abort", onAbort);
		if (finished) return;
		if (signal?.aborted) {
			failOnce(true, "Request aborted");
			return;
		}
		const stderrHint = stderrTail.join("").trim().slice(-500);
		failOnce(false, `qodercli exited with code ${code} before a result${stderrHint ? `: ${stderrHint}` : ""}`);
	});

	try {
		child.stdin?.write(serializeContext(context));
		child.stdin?.end();
	} catch (error) {
		failOnce(false, `Failed to write prompt to qodercli: ${String(error)}`);
	}
}
