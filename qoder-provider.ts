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
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const QODER_BIN = process.env.QODER_BRIDGE_BIN || "qodercli";
const PERMISSION_MODE = process.env.QODER_BRIDGE_PERMISSION_MODE || "dont_ask";
// Frontier models support 200K/400K/1M context (docs.qoder.com/cli/model).
// Pass --context-window only for specific models, not the auto/efficient pools.
const CONTEXT_WINDOW = Number(process.env.QODER_BRIDGE_CONTEXT_WINDOW) || 1_000_000;
const MAX_PROMPT_CHARS = Number(process.env.QODER_BRIDGE_MAX_PROMPT_CHARS) || 4_000_000;
const DEBUG_LOG = process.env.QODER_BRIDGE_LOG;
// Mirror per-run credits into usage.cost.total so omp's statusline/usage cost
// shows credit spend (unit is credits, not USD).
const COST_AS_CREDITS = process.env.QODER_BRIDGE_COST_AS_CREDITS === "1";
const CREDITS_FILE =
	process.env.QODER_BRIDGE_CREDITS_FILE || join(homedir(), ".omp", "agent", "qoder-credits.json");
const VENDOR_DIR = process.env.QODER_BRIDGE_VENDOR_DIR || join(homedir(), ".omp", "agent", "vendor", "qoder-sdk");
const USAGE_HELPER = process.env.QODER_BRIDGE_USAGE_HELPER || join(VENDOR_DIR, "qoder-usage-helper.cjs");
const USAGE_CACHE_MS = 60_000;

let sessionCredits = 0;
let creditsWriteWarned = false;

interface CreditsFile {
	allTime: number;
	updatedAt: string;
}

function isCreditsFile(value: unknown): value is CreditsFile {
	return (
		isRecord(value) && typeof value.allTime === "number" && Number.isFinite(value.allTime)
	);
}

function loadAllTimeCredits(): number {
	try {
		const parsed: unknown = JSON.parse(readFileSync(CREDITS_FILE, "utf8"));
		return isCreditsFile(parsed) ? parsed.allTime : 0;
	} catch {
		return 0;
	}
}

function recordCredits(credits: number): void {
	if (!(credits > 0)) return;
	const allTime = loadAllTimeCredits() + credits;
	try {
		mkdirSync(join(CREDITS_FILE, ".."), { recursive: true });
		const payload: CreditsFile = { allTime, updatedAt: new Date().toISOString() };
		writeFileSync(CREDITS_FILE, `${JSON.stringify(payload, null, "\t")}\n`);
	} catch (error) {
		if (!creditsWriteWarned) {
			creditsWriteWarned = true;
			process.stderr.write(`qoder-bridge: cannot update ${CREDITS_FILE}: ${String(error)}\n`);
		}
	}
}

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
const MODEL_SPECS: Array<{ id: string; flag?: string; name: string }> = [
	{ id: "auto", name: "Qoder Auto" },
	{ id: "efficient", flag: "Efficient", name: "Qoder Efficient" },
	{ id: "qwen3.8-max", flag: "Qwen3.8-Max", name: "Qwen3.8-Max (Qoder)" },
	{ id: "qwen3.8-flash", flag: "Qwen3.8-Flash", name: "Qwen3.8-Flash (Qoder)" },
	{ id: "kimi-k3.1-pro", flag: "Kimi-K3.1-Pro", name: "Kimi K3.1 Pro (Qoder)" },
	{ id: "kimi-k2.8-preview", flag: "Kimi-K2.8-Preview", name: "Kimi K2.8 Preview (Qoder)" },
	{ id: "glm-5.3", flag: "GLM-5.3", name: "GLM-5.3 (Qoder)" },
	{ id: "glm-5.3-flash", flag: "GLM-5.3-Flash", name: "GLM-5.3 Flash (Qoder)" },
	{ id: "deepseek-v4-pro", flag: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro (Qoder)" },
	{ id: "deepseek-flash", flag: "DeepSeek-Flash", name: "DeepSeek Flash (Qoder)" },
	{ id: "minimax-m3.1-flash", flag: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash (Qoder)" },
];

let activeContextWindow = CONTEXT_WINDOW;

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

const MAX_IMAGES = 10;

interface ImageAttachment {
	data: string;
	extension: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

function buildRequest(context: unknown): { prompt: string; images: ImageAttachment[] } {
	const messages = isRecord(context) ? asArray(context.messages) : [];
	const parts: string[] = [];
	const images: ImageAttachment[] = [];
	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		const textParts: string[] = [];
		let imageSeen = false;
		for (const block of asArray(msg.content)) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text) {
				textParts.push(block.text);
				continue;
			}
			if (block.type === "image" && typeof block.data === "string" && block.data) {
				const raw = block.data.startsWith("data:") ? block.data.slice(block.data.indexOf(",") + 1) : block.data;
				const extension = IMAGE_EXTENSIONS[asString(block.mimeType) ?? ""] ?? "";
				if (!extension || !raw || images.length >= MAX_IMAGES) continue;
				images.push({ data: raw, extension });
				textParts.push(`[image #${images.length} attached]`);
				imageSeen = true;
			}
		}
		const fallback = textFromContent(isRecord(msg.output) ? msg.output.content : undefined);
		const text = (textParts.length ? textParts.join("\n") : "") || fallback;
		if (!text.trim() && !imageSeen) continue;
		if (msg.role === "toolResult") {
			parts.push(`[tool result: ${asString(msg.toolName) ?? "tool"}]\n${text}`);
		} else {
			parts.push(`[${asString(msg.role) ?? "message"}]\n${text}`);
		}
	}
	let prompt = parts.join("\n\n");
	if (prompt.length > MAX_PROMPT_CHARS) {
		prompt = "[earlier conversation truncated]\n\n" + prompt.slice(prompt.length - MAX_PROMPT_CHARS);
	}
	return { prompt, images };
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

interface QuotaSnapshot {
	error?: unknown;
	userQuota?: { total?: unknown; used?: unknown; remaining?: unknown; unit?: unknown };
	addOnQuota?: { cap?: unknown; used?: unknown; remaining?: unknown; unit?: unknown };
	totalUsagePercentage?: unknown;
	isQuotaExceeded?: unknown;
}

let usageCache: { report: unknown; remaining: string; fetchedAt: number } | null = null;

function runUsageHelper(): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("node", [USAGE_HELPER], { stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		reject(new Error("usage helper timed out"));
	}, 20_000);
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		out += chunk;
	});
	child.stderr?.resume();
	child.on("error", (error) => {
		clearTimeout(timer);
		reject(error);
	});
	child.on("close", () => {
		clearTimeout(timer);
		resolve(out);
	});
	return promise;
}

function parseQuotaSnapshot(output: string): QuotaSnapshot | null {
	const lines = output.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line || !line.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) {
				debugLog(`usage snapshot: ${line.slice(0, 200)}`);
				return parsed as QuotaSnapshot;
			}
		} catch {}
	}
	return null;
}

function quotaLimit(
	quota: { total?: unknown; used?: unknown; unit?: unknown },
	id: string,
	label: string,
): Record<string, unknown> | null {
	if (typeof quota.total !== "number" || typeof quota.used !== "number") return null;
	return {
		id,
		label,
		scope: { provider: "qoder" },
		amount: { used: quota.used, limit: quota.total, unit: asString(quota.unit) ?? "credits" },
	};
}

let usageFailedUntil = 0;

async function fetchQuotaReport(): Promise<unknown> {
	if (usageCache && Date.now() - usageCache.fetchedAt < USAGE_CACHE_MS) return usageCache.report;
	if (Date.now() < usageFailedUntil) return null;
	try {
		const snapshot = await parseQuotaSnapshot(await runUsageHelper());
		if (!snapshot || typeof snapshot.error === "string") {
			// Negative-cache so a broken helper cannot stall every usage read.
			usageFailedUntil = Date.now() + 600_000;
			return null;
		}
		const limits: Record<string, unknown>[] = [];
		const plan = isRecord(snapshot.userQuota) ? snapshot.userQuota : undefined;
		const planLimit = plan ? quotaLimit(plan, "plan", "Plan credits") : null;
		if (planLimit) limits.push(planLimit);
		const addOn = isRecord(snapshot.addOnQuota) ? snapshot.addOnQuota : undefined;
		const addOnLimit = addOn
			? quotaLimit({ total: addOn.cap, used: addOn.used, unit: addOn.unit }, "addon", "Add-on credits")
			: null;
		if (addOnLimit) limits.push(addOnLimit);
		if (limits.length === 0) {
			debugLog("usage snapshot had no numeric quota buckets");
			return null;
		}
		const remaining = plan && typeof plan.remaining === "number" ? `${plan.remaining}/${plan.total ?? "?"}` : "";
		const report = { provider: "qoder", fetchedAt: Date.now(), limits };
		usageCache = { report, remaining, fetchedAt: Date.now() };
		return report;
	} catch (error) {
		debugLog(`usage fetch failed: ${String(error).slice(0, 200)}`);
		usageFailedUntil = Date.now() + 600_000;
		return null;
	}
}

function buildProviderConfig() {
	return {
		baseUrl: "qoder://local-cli-bridge",
		apiKey: "qodercli-local-auth",
		api: "qoder-cli-bridge",
		streamSimple(model: unknown, context: unknown, options: unknown) {
			const stream = new AssistantMessageEventStream();
			void runBridge(stream, model, context, options);
			return stream;
		},
		usage: {
			id: "qoder",
			fetchUsage: () => fetchQuotaReport(),
		},
		models: MODEL_SPECS.map((spec) => ({
			id: spec.id,
			name: spec.name,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: activeContextWindow,
			maxTokens: 16_384,
		})),
	};
}

export default function qoderProvider(pi: ExtensionAPI) {
	pi.registerCommand("qoder-credits", {
		description: "Show Qoder credits (remaining / this process / all-time)",
		handler: async (_args, ctx) => {
			const allTime = loadAllTimeCredits();
			const report = await fetchQuotaReport();
			const remaining =
				report && usageCache?.remaining
					? `remaining: ${usageCache.remaining}`
					: "remaining: unavailable (install the usage helper — see README)";
			ctx.ui.notify(
				`Qoder credits — ${remaining} · this omp process: ${sessionCredits.toFixed(4)} · all-time: ${allTime.toFixed(4)}`,
				"info",
			);
		},
	});
	pi.registerCommand("qoder-context", {
		description: "Show or set the child context window (e.g. 200000 / 400000 / 1000000)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				const tierNote = [200_000, 400_000, 1_000_000].includes(activeContextWindow) ? "" : " (not a documented tier)";
				ctx.ui.notify(`qoder context window: ${activeContextWindow}${tierNote}`, "info");
				return;
			}
			const size = Number(raw);
			if (!Number.isInteger(size) || size < 100_000 || size > 2_000_000) {
				ctx.ui.notify(`invalid context window: ${raw} — use an integer between 100000 and 2000000`, "warning");
				return;
			}
			activeContextWindow = size;
			try {
				pi.unregisterProvider("qoder");
			} catch {}
			try {
				pi.registerProvider("qoder", buildProviderConfig());
			} catch (error) {
				ctx.ui.notify(`context window set to ${size}, but re-registering the provider failed: ${String(error)}`, "warning");
				return;
			}
			const tierNote = [200_000, 400_000, 1_000_000].includes(size) ? "" : " (not one of the documented tiers 200K/400K/1M)";
			ctx.ui.notify(`qoder context window set to ${size}${tierNote} — new requests use it`, "info");
		},
	});
	pi.registerProvider("qoder", buildProviderConfig());
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
	if (flag) {
		args.push("-m", flag);
		args.push("--context-window", String(activeContextWindow));
	}
	const maxTokens = isRecord(options) ? options.maxTokens : undefined;
	if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
		args.push("--max-output-tokens", String(Math.floor(maxTokens)));
	}

	const { prompt, images } = buildRequest(context);
	const imageDir = join(tmpdir(), `qoder-bridge-${process.pid}-${Date.now()}`);
	const attachmentFiles: string[] = [];
	const cleanupImages = () => {
		if (attachmentFiles.length === 0) return;
		try {
			rmSync(imageDir, { recursive: true, force: true });
		} catch {}
	};
	if (images.length > 0) {
		try {
			mkdirSync(imageDir, { recursive: true });
			images.forEach((image, index) => {
				const file = join(imageDir, `image-${index + 1}.${image.extension}`);
				writeFileSync(file, Buffer.from(image.data, "base64"));
				attachmentFiles.push(file);
				args.push("--attachment", file);
			});
		} catch (error) {
			debugLog(`attachment staging failed: ${String(error)}`);
		}
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
		cleanupImages();
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
		const credits = typeof event.total_credits === "number" ? event.total_credits : 0;
		sessionCredits += credits;
		recordCredits(credits);
		if (COST_AS_CREDITS && credits > 0) {
			const cost = usage.cost as Record<string, number>;
			cost.total = credits;
		}
		partial.details = { credits, provider: "qoder" };
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
		cleanupImages();
		if (finished) return;
		if (signal?.aborted) {
			failOnce(true, "Request aborted");
			return;
		}
		const stderrHint = stderrTail.join("").trim().slice(-500);
		failOnce(false, `qodercli exited with code ${code} before a result${stderrHint ? `: ${stderrHint}` : ""}`);
	});

	try {
		child.stdin?.write(prompt);
		child.stdin?.end();
	} catch (error) {
		failOnce(false, `Failed to write prompt to qodercli: ${String(error)}`);
	}
}
