#!/usr/bin/env node
"use strict";
// Queries remaining Qoder credits through the official @qoder-ai/qoder-agent-sdk
// (getUsageInfo over the CLI's own control channel; no agent turn is started).
// Runs under Node because the SDK's worker runtime crashes under Bun.
// Prints ONE JSON line: {error} on failure, else the quota snapshot.
const path = require("node:path");

let SDK;
try {
	SDK = require(path.join(__dirname, "node_modules", "@qoder-ai", "qoder-agent-sdk"));
} catch {
	SDK = require("@qoder-ai/qoder-agent-sdk");
}

let releaseInput;
async function* noPrompt() {
	await new Promise((resolve) => {
		releaseInput = resolve;
	});
}

const hardExit = setTimeout(() => {
	console.log(JSON.stringify({ error: "timeout" }));
	process.exit(2);
}, 15000);

const q = SDK.query({ prompt: noPrompt(), options: { auth: SDK.qodercliAuth() } });

(async () => {
	try {
		await q.initializationResult();
		const usage = await q.getUsageInfo();
		clearTimeout(hardExit);
		releaseInput?.();
		await q.close().catch(() => {});
		if (!usage) {
			console.log(JSON.stringify({ error: "unavailable" }));
			return;
		}
		console.log(
			JSON.stringify({
				userType: usage.userType,
				totalUsagePercentage: usage.totalUsagePercentage,
				isQuotaExceeded: usage.isQuotaExceeded,
				userQuota: usage.userQuota,
				addOnQuota: usage.addOnQuota,
			}),
		);
	} catch (error) {
		clearTimeout(hardExit);
		console.log(JSON.stringify({ error: String(error && error.message ? error.message : error).slice(0, 300) }));
		process.exitCode = 1;
	}
})();
