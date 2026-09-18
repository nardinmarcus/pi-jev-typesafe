// pi-jev-typesafe — TypeSafe Jev (System One judgment model) for Pi.
//
// Zero-dependency by design: pi bundles typebox / pi-tui / pi-ai, and the API is
// a single documented endpoint (POST /v1/systemone, GET /v1/models), so plain
// fetch suffices — nothing to npm install, nothing to build (pi loads TS via jiti).
//
// Distinctions vs. pi-typesafe (DevMortimer): model discovery (/jev models),
// per-request model with alias guidance, question linting before submission,
// probability-bar rendering, one retry on transient failures, hub-owned source.
//
// Security posture (same discipline): submitted state/questions go only to
// api.typesafe.ai; error messages never contain upstream bodies, headers, keys,
// or submitted content; the API key is never logged or echoed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const MAX_QUESTIONS = 32;
const MAX_INPUT_BYTES = 65_536; // documented 64 KiB request budget
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 300;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_SESSION_MAX_REQUESTS = 20;
/** Listed rate at authoring time: $42 per 1B input tokens; output tokens are free. */
const DEFAULT_USD_PER_INPUT_TOKEN = 42 / 1e9;
const MAX_LINT_LINES = 3;
const MODEL_ALIASES = `Aliases: "jev-latest" (stable default), "jev-preview" (may move ahead), ` +
    `or a pinned id like "jev-1.13.0" (pin it when confidence thresholds were tuned against a version).`;
const DISCLOSURE = "Submitting state and questions sends them to api.typesafe.ai and may incur charges; " +
    "do not include secrets. No files or conversation history are collected. " +
    "Answers are calibrated model judgments, not proof of correctness or authorization.";
class JevError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
// ---------------------------------------------------------------------------
// API key resolution: env first, then shell rc files (never echoed)
// ---------------------------------------------------------------------------
function readKeyFromRc(files) {
    for (const file of files) {
        try {
            const text = readFileSync(file, "utf8");
            const matches = [
                ...text.matchAll(/^\s*export\s+TYPESAFE_API_KEY=["']?([^"'\n]+)["']?\s*$/gm),
            ];
            const last = matches.at(-1)?.[1]?.trim();
            if (last)
                return { key: last, source: file.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, "~") };
        }
        catch {
            // unreadable or missing — try the next file
        }
    }
    return undefined;
}
function resolveKey() {
    const env = process.env.TYPESAFE_API_KEY?.trim();
    if (env)
        return { key: env, source: "TYPESAFE_API_KEY (environment)" };
    return readKeyFromRc([join(homedir(), ".zshrc"), join(homedir(), ".bashrc")]);
}
// ---------------------------------------------------------------------------
// Budget: per-session attempt counter + persisted daily counters and caps
// ---------------------------------------------------------------------------
const STATE_DIR = join(homedir(), ".pi", "agent", "pi-jev-typesafe");
const USAGE_FILE = join(STATE_DIR, "usage.json");
function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function freshDay() {
    return { day: today(), requestsStarted: 0, requestsSucceeded: 0, requestsFailed: 0, inputTokens: 0, estimatedUsd: 0 };
}
function loadToday() {
    try {
        const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
        if (parsed?.day === today() && typeof parsed.requestsStarted === "number") {
            return { ...freshDay(), ...parsed, day: today() };
        }
    }
    catch {
        // first run or unreadable file — start fresh
    }
    return freshDay();
}
function saveToday(u) {
    try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2) + "\n", "utf8");
    }
    catch {
        // best effort; losing a usage ledger must never fail a session
    }
}
function envInt(name) {
    const raw = process.env[name]?.trim();
    if (!raw)
        return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
function usdPerInputToken() {
    const mtok = process.env.PI_TYPESAFE_JEV_USD_PER_MTOK?.trim();
    const n = mtok ? Number(mtok) : NaN;
    return Number.isFinite(n) && n > 0 ? n / 1e6 : DEFAULT_USD_PER_INPUT_TOKEN;
}
// ---------------------------------------------------------------------------
// Validation — precise, content-free error messages
// ---------------------------------------------------------------------------
function isPlainJson(value, depth = 0, ancestors) {
    if (depth > 32)
        return false;
    if (value === null)
        return true;
    const t = typeof value;
    if (t === "string" || t === "boolean")
        return true;
    if (t === "number")
        return Number.isFinite(value);
    if (t !== "object")
        return false;
    const obj = value;
    ancestors ??= new Set();
    if (ancestors.has(obj))
        return false;
    ancestors.add(obj);
    const ok = Array.isArray(obj)
        ? obj.every((item) => isPlainJson(item, depth + 1, ancestors))
        : Object.values(obj).every((item) => isPlainJson(item, depth + 1, ancestors));
    ancestors.delete(obj);
    return ok;
}
export function validateEntry(value, path) {
    if (!isPlainJson(value))
        throw new JevError("validation", `${path}: must be plain JSON (string, number, boolean, null, array, or object without cycles).`);
}
export function validateRequest(req) {
    validateEntry(req.state, "state");
    if (!req.questions || typeof req.questions !== "object" || Array.isArray(req.questions)) {
        throw new JevError("validation", `questions: must be an object mapping question ids to questions. Expected { "<id>": { type, instructions, criteria? } }, 1–${MAX_QUESTIONS} questions.`);
    }
    const ids = Object.keys(req.questions);
    if (ids.length < 1 || ids.length > MAX_QUESTIONS) {
        throw new JevError("validation", `questions: 1–${MAX_QUESTIONS} per request, got ${ids.length}. Split larger batches across requests.`);
    }
    for (const id of ids) {
        const q = req.questions[id];
        const at = `questions.${id}`;
        if (!q || typeof q !== "object" || Array.isArray(q))
            throw new JevError("validation", `${at}: must be an object with type/instructions/criteria.`);
        if (!["choice", "score", "noul"].includes(q.type))
            throw new JevError("validation", `${at}.type: must be "choice", "score", or "noul".`);
        if (q.instructions === undefined || q.instructions === null)
            throw new JevError("validation", `${at}.instructions: required — put the full judgment in the question text; ids are not sent to the model.`);
        validateEntry(q.instructions, `${at}.instructions`);
        if (q.type === "choice") {
            const c = q.criteria;
            if (!c || typeof c !== "object" || Array.isArray(c))
                throw new JevError("validation", `${at}.criteria: choice needs an options map like { billing: "Charges and payments", other: null }.`);
            const keys = Object.keys(c);
            if (keys.length < 1 || keys.length > 64)
                throw new JevError("validation", `${at}.criteria: 1–64 options required, got ${keys.length}.`);
            if (keys.some((k) => k.length > 200))
                throw new JevError("validation", `${at}.criteria: option labels must be at most 200 characters.`);
            for (const k of keys)
                validateEntry(c[k], `${at}.criteria.${k}`);
        }
        else if (q.type === "score") {
            const c = q.criteria;
            if (!Array.isArray(c) || c.length < 2 || c.length > 32) {
                throw new JevError("validation", `${at}.criteria: score needs an ordered array of 2–32 concrete level descriptions, e.g. ["Calm", "Frustrated", "Very angry"].`);
            }
            for (const [i, level] of c.entries())
                validateEntry(level, `${at}.criteria[${i}]`);
        }
        else if (q.criteria !== undefined && q.criteria !== null) {
            const c = q.criteria;
            if (typeof c !== "object" || Array.isArray(c))
                throw new JevError("validation", `${at}.criteria: noul criteria must be an optional object { true?, false? } describing what yes/no mean.`);
            for (const side of ["true", "false"]) {
                if (c[side] !== undefined)
                    validateEntry(c[side], `${at}.criteria.${side}`);
            }
        }
    }
    if (req.model !== undefined) {
        if (typeof req.model !== "string" || !req.model.trim() || req.model.length > 100) {
            throw new JevError("validation", "model: must be a nonempty string of at most 100 characters.");
        }
    }
    const bytes = Buffer.byteLength(JSON.stringify({ state: req.state, questions: req.questions, model: req.model ?? DEFAULT_MODEL }), "utf8");
    if (bytes > MAX_INPUT_BYTES) {
        throw new JevError("validation", `request is ${Math.ceil(bytes / 1024)}KiB of JSON; the API budget is ${MAX_INPUT_BYTES / 1024}KiB. Trim the state or split the batch.`);
    }
}
/** Fold near-misses before schema validation: questions submitted as an array with ids. */
export function prepareArguments(args) {
    if (!args || typeof args !== "object" || Array.isArray(args))
        return args;
    const input = args;
    if (Array.isArray(input.questions)) {
        const map = {};
        for (const item of input.questions) {
            if (item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string") {
                const { id, ...rest } = item;
                map[id] = rest;
            }
        }
        return { ...input, questions: map };
    }
    return args;
}
// ---------------------------------------------------------------------------
// Question lint — catches the failure modes the TypeSafe docs warn about
// ---------------------------------------------------------------------------
const NO_MATCH = /other|unclear|unknown|none|n\/a|na|fallback|其他|未知|不明确|无|不清楚/i;
const VAGUE_LEVEL = /^(低|中|高|中等|一般|较差|较好|low|high|medium|mid|neutral|ok|okay|fine|bad|good|none)\s*$/i;
export function lintRequest(req) {
    const warnings = [];
    for (const [id, q] of Object.entries(req.questions)) {
        if (warnings.length >= MAX_LINT_LINES)
            break;
        const text = typeof q.instructions === "string" ? q.instructions.trim() : "";
        if (q.type === "choice" && q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria)) {
            const keys = Object.keys(q.criteria);
            if (keys.length > 16)
                warnings.push(`choice "${id}" has ${keys.length} options; wide option sets spread probability — consider a two-stage choice.`);
            else if (!keys.some((k) => NO_MATCH.test(k))) {
                warnings.push(`choice "${id}" has no no-match option; the model cannot pick an option you omitted (add other/unclear).`);
            }
        }
        if (warnings.length >= MAX_LINT_LINES)
            break;
        if (q.type === "score" && Array.isArray(q.criteria)) {
            const vague = q.criteria.some((level) => typeof level === "string" && VAGUE_LEVEL.test(level.trim()));
            if (vague)
                warnings.push(`score "${id}" uses bare degree words (low/medium/高/中等…); describe concrete situations per level instead.`);
        }
        if (warnings.length >= MAX_LINT_LINES)
            break;
        if (text && text.length < 8)
            warnings.push(`"${id}" instructions are very short; the question text is the whole program — spell out the full judgment.`);
    }
    if (warnings.length > MAX_LINT_LINES)
        warnings.length = MAX_LINT_LINES;
    return warnings;
}
// ---------------------------------------------------------------------------
// HTTP: one endpoint, light response validation, one retry on transient faults
// ---------------------------------------------------------------------------
function validateAnswerShape(req, answers) {
    const prob = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    for (const [id, q] of Object.entries(req.questions)) {
        const a = answers[id];
        if (!a || a.type !== q.type)
            throw new JevError("response", `answer for "${id}" is missing or has the wrong type.`);
        if (a.type === "noul" && !prob(a.noul))
            throw new JevError("response", `answer "${id}": noul probability out of range.`);
        if (a.type !== "noul" && !prob(a.confidence))
            throw new JevError("response", `answer "${id}": confidence out of range.`);
        if (a.probabilities) {
            for (const p of Object.values(a.probabilities)) {
                if (!prob(p))
                    throw new JevError("response", `answer "${id}": probability out of range.`);
            }
        }
        if (a.type === "choice") {
            const keys = Object.keys((q.criteria ?? {}));
            if (typeof a.choice !== "string" || (keys.length > 0 && !keys.includes(a.choice))) {
                throw new JevError("response", `answer "${id}": chose an option outside criteria.`);
            }
        }
        if (a.type === "score") {
            const levels = Array.isArray(q.criteria) ? q.criteria.length : 0;
            if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > Math.max(levels - 1, 0)) {
                throw new JevError("response", `answer "${id}": score outside the rubric range.`);
            }
        }
    }
}
async function abortableSleep(ms, signal) {
    if (signal?.aborted)
        throw new JevError("network", "aborted before retry.");
    await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new JevError("network", "aborted while waiting to retry."));
        }, { once: true });
    });
}
async function callOnce(key, req, signal) {
    const payload = {
        state: req.state,
        model: req.model?.trim() || DEFAULT_MODEL,
        questions: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [
            id,
            q.criteria === undefined || q.criteria === null
                ? { type: q.type, instructions: q.instructions }
                : { type: q.type, instructions: q.instructions, criteria: q.criteria },
        ])),
    };
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const domSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = Date.now();
    let response;
    try {
        response = await fetch(`${API_BASE}/v1/systemone`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: domSignal,
        });
    }
    catch (error) {
        if (signal?.aborted)
            throw new JevError("network", "aborted.");
        throw new JevError("network", `request failed before a response arrived (${error instanceof Error ? error.name : "unknown"}).`);
    }
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
        const authRejected = response.status === 401 || response.status === 403;
        const kind = authRejected
            ? "authentication was rejected"
            : response.status === 429
                ? "rate limited"
                : response.status >= 500
                    ? "server error"
                    : "request rejected";
        throw new JevError("http", `HTTP ${response.status} — ${kind}.`, response.status);
    }
    let raw;
    try {
        raw = await response.json();
    }
    catch {
        throw new JevError("response", "response was not valid JSON.");
    }
    if (typeof raw.model !== "string" || !raw.model || typeof raw.answers !== "object" || raw.answers === null) {
        throw new JevError("response", "response shape was unexpected.");
    }
    const usage = raw.usage;
    const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
    const answers = raw.answers;
    validateAnswerShape(req, answers);
    return { answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, model: raw.model, elapsedMs };
}
// ---------------------------------------------------------------------------
// Formatting & rendering
// ---------------------------------------------------------------------------
function bar(p, width = 12) {
    const cells = Math.round(Math.max(0, Math.min(1, p)) * width);
    return "█".repeat(cells) + "·".repeat(width - cells);
}
function shortOption(label, max = 28) {
    const s = label.length > max ? label.slice(0, max - 1) + "…" : label;
    return s.replace(/\s+/g, " ");
}
function levelText(level) {
    return shortOption(typeof level === "string" ? level : JSON.stringify(level));
}
export function formatResult(r, expanded) {
    const lines = [`jev · ${r.model} · ${r.elapsedMs}ms · ${r.usage.input_tokens} tok in (~$${r.estimatedUsd.toFixed(5)})`];
    for (const [id, a] of Object.entries(r.answers)) {
        if (a.type === "noul") {
            lines.push(`${id}: P(yes) ${bar(a.noul ?? 0)} ${(a.noul ?? 0).toFixed(3)}`);
        }
        else if (a.type === "choice") {
            const conf = (a.confidence ?? 0).toFixed(2);
            const probs = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
            const shown = expanded || probs.length <= 5 ? probs : probs.slice(0, 3);
            const detail = shown.map(([k, p]) => `${shortOption(k, 24)} ${bar(p, 8)} ${p.toFixed(2)}`).join("  ");
            const more = !expanded && probs.length > 5 ? `  (+${probs.length - 3} more)` : "";
            lines.push(`${id}: ${shortOption(a.choice ?? "?")} · conf ${conf}   ${detail}${more}`);
        }
        else {
            const levels = Array.isArray(r.levels?.[id]) ? r.levels[id] : [];
            const idx = Math.round(a.score ?? 0);
            const where = levels[idx] !== undefined ? ` "${levelText(levels[idx])}"` : "";
            lines.push(`${id}: ${Number.isInteger(a.score) ? a.score : (a.score ?? 0).toFixed(2)}${where} · conf ${(a.confidence ?? 0).toFixed(2)}${a.legend ? ` · ${shortOption(a.legend, 40)}` : ""}`);
            if (expanded && a.probabilities && levels.length > 0) {
                for (const [i, p] of Object.entries(a.probabilities).sort((x, y) => Number(x[0]) - Number(y[0]))) {
                    const li = Number(i);
                    lines.push(`  L${i} ${levels[li] !== undefined ? levelText(levels[li]) : i} ${bar(p, 8)} ${p.toFixed(2)}`);
                }
            }
        }
    }
    for (const w of r.lint)
        lines.push(`lint: ${w}`);
    lines.push("Confidence is distribution concentration, not proof of correctness.");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------
export default function jevExtension(pi) {
    let enabled = process.env.PI_TYPESAFE_JEV_ENABLED === "1";
    let sessionRequests = 0;
    let calledOut;
    let todayUsage = loadToday();
    const sessionMax = () => envInt("PI_TYPESAFE_JEV_MAX_REQUESTS") ?? DEFAULT_SESSION_MAX_REQUESTS;
    const callOut = (ctx, key, text) => {
        if (calledOut === key)
            return;
        calledOut = key;
        try {
            if (ctx?.hasUI)
                ctx.ui.notify(text, "warning");
            else
                pi.sendMessage({ customType: "jev-status", content: text, display: true });
        }
        catch {
            // reporting must never replace the failure it describes
        }
    };
    const report = (ctx, text, level = "info") => {
        if (ctx.hasUI)
            ctx.ui.notify(text, level);
        else
            pi.sendMessage({ customType: "jev-status", content: text, display: true });
    };
    const checkBudget = () => {
        if (sessionRequests >= sessionMax()) {
            throw new JevError("budget", `session attempt cap reached (${sessionRequests}/${sessionMax()}); it resets on session start/reload (PI_TYPESAFE_JEV_MAX_REQUESTS).`);
        }
        if (todayUsage.day !== today())
            todayUsage = loadToday();
        const perDay = envInt("PI_TYPESAFE_JEV_MAX_REQUESTS_PER_DAY");
        if (perDay !== undefined && todayUsage.requestsStarted >= perDay) {
            throw new JevError("budget", `daily request cap reached (${todayUsage.requestsStarted}/${perDay} on ${todayUsage.day}); counters roll over at local midnight.`);
        }
        const tokCap = envInt("PI_TYPESAFE_JEV_MAX_INPUT_TOKENS_PER_DAY");
        if (tokCap !== undefined && todayUsage.inputTokens >= tokCap) {
            throw new JevError("budget", `daily input-token cap reached (${todayUsage.inputTokens}/${tokCap} on ${todayUsage.day}).`);
        }
        const usdCap = process.env.PI_TYPESAFE_JEV_MAX_USD_PER_DAY?.trim();
        const usdN = usdCap ? Number(usdCap) : NaN;
        if (Number.isFinite(usdN) && usdN > 0 && todayUsage.estimatedUsd >= usdN) {
            throw new JevError("budget", `daily spend cap reached (~$${todayUsage.estimatedUsd.toFixed(4)}/$${usdN} on ${todayUsage.day}).`);
        }
    };
    const record = (ok, inputTokens) => {
        todayUsage.requestsStarted += 1;
        if (ok)
            todayUsage.requestsSucceeded += 1;
        else
            todayUsage.requestsFailed += 1;
        todayUsage.inputTokens += inputTokens;
        todayUsage.estimatedUsd += inputTokens * usdPerInputToken();
        saveToday(todayUsage);
    };
    pi.on("session_start", async (_event, ctx) => {
        enabled = process.env.PI_TYPESAFE_JEV_ENABLED === "1";
        sessionRequests = 0;
        calledOut = undefined;
        todayUsage = loadToday();
        if (enabled && !resolveKey()) {
            callOut(ctx, "start:nokey", "jev_ask is enabled but no TYPESAFE_API_KEY was found (environment or ~/.zshrc); judgments will fail until a key is present.");
        }
    });
    const sample = {
        state: { message: "我被打了两笔扣款，请今天内处理。", tier: "pro" },
        questions: {
            category: { type: "choice", instructions: "Which team should handle this message?", criteria: { billing: "Charges and payments", technical: "Software failures", other: "None of these" } },
            urgent: { type: "noul", instructions: "Does the sender request help today?" },
            frustration: { type: "score", instructions: "How frustrated does the sender sound?", criteria: ["A neutral request without expressed frustration", "Expressed frustration while remaining civil", "Explicit anger or threats"] },
        },
    };
    pi.registerEntryRenderer("jev-result", (entry, { expanded }) => new Text(entry.data ? formatResult({ ...entry.data, lint: entry.data.lint ?? [] }, expanded) : "jev · no result", 0, 0));
    const jevParameters = Type.Object({
        state: Type.Union([
            Type.String(),
            Type.Array(Type.Unknown()),
            Type.Record(Type.String(), Type.Unknown()),
        ], { description: "The content to judge: plain text, or structured JSON with named fields (preferred for multi-part context)." }),
        questions: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.Object({
            type: StringEnum(["choice", "score", "noul"]),
            instructions: Type.Union([
                Type.String(),
                Type.Array(Type.Unknown()),
                Type.Record(Type.String(), Type.Unknown()),
            ], { description: "The full judgment to make; question ids are not sent to the model." }),
            criteria: Type.Optional(Type.Unknown({ description: "choice: options map {label: description|null}; score: array of ≥2 level descriptions; noul: optional {true, false}." })),
        }, { additionalProperties: false }), { minProperties: 1, maxProperties: MAX_QUESTIONS }),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "jev-latest (default), jev-preview, or a pinned id like jev-1.13.0." })),
    });
    pi.registerTool({
        name: "jev_ask",
        label: "Jev Ask",
        description: `Ask TypeSafe's Jev (System One judgment model) structured questions about supplied state; ` +
            `returns calibrated typed answers with probabilities in one batched call (~1s). ` +
            `Three question types: choice (pick one option; criteria = map of option → description|null, include a no-match option), ` +
            `score (position on an ordered rubric; criteria = array of ≥2 concrete level descriptions, never bare degree words), ` +
            `noul (probability of yes; optional criteria {true, false} descriptions). ` +
            `Questions run in parallel and cannot see each other: put each item in a named state field (e.g. \`reports.r1\`) ` +
            `and ask one narrow judgment per question. ${MODEL_ALIASES} ${DISCLOSURE} ` +
            `Opt-in: /jev enable or PI_TYPESAFE_JEV_ENABLED=1. ` +
            `Limits: ${MAX_QUESTIONS} questions and ${MAX_INPUT_BYTES / 1024}KiB JSON per request, ` +
            `${sessionMax()} attempts per session, optional daily caps via PI_TYPESAFE_JEV_MAX_*; one retry on transient faults.`,
        promptSnippet: "Batched structured judgments via TypeSafe Jev (external service; opt-in required)",
        promptGuidelines: [
            "Use jev_ask for requested semantic judgments (classify, score, verify, route) where a calibrated probability is useful; use code for calculations and exact lookups.",
            "Batch independent jev_ask questions over the same state in one call; split dimensions into separate questions and name the state field each question judges.",
            "Report jev_ask answers with their probabilities and confidence; never treat confidence as authorization to act, and say when an answer is uncertain.",
        ],
        parameters: jevParameters,
        prepareArguments: (args) => prepareArguments(args),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!enabled) {
                throw new JevError("configuration", "jev_ask is disabled. Ask the operator to run /jev enable (interactive) or set PI_TYPESAFE_JEV_ENABLED=1; do not enable it by editing configuration files.");
            }
            const keyInfo = resolveKey();
            if (!keyInfo)
                throw new JevError("configuration", "No TypeSafe API key. Set TYPESAFE_API_KEY in the environment or ~/.zshrc.");
            const levels = Object.fromEntries(Object.entries(params.questions)
                .filter(([, q]) => q.type === "score" && Array.isArray(q.criteria))
                .map(([id, q]) => [id, q.criteria]));
            validateRequest(params);
            const lint = lintRequest(params);
            checkBudget();
            sessionRequests += 1;
            let lastError;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    checkBudget();
                    const started = Date.now();
                    const call = await callOnce(keyInfo.key, params, signal);
                    const rate = usdPerInputToken();
                    const result = {
                        model: call.model,
                        elapsedMs: call.elapsedMs || Date.now() - started,
                        usage: call.usage,
                        answers: call.answers,
                        lint,
                        estimatedUsd: call.usage.input_tokens * rate,
                        levels,
                    };
                    record(true, call.usage.input_tokens);
                    return {
                        content: [{ type: "text", text: formatResult(result, false) }],
                        details: result,
                    };
                }
                catch (error) {
                    const err = error instanceof JevError ? error : new JevError("response", `unexpected failure (${error instanceof Error ? error.message : "unknown"}).`);
                    lastError = err;
                    const transient = err.code === "network" || (err.code === "http" && err.status !== undefined && RETRYABLE_STATUS.has(err.status));
                    if (transient && attempt === 0) {
                        try {
                            await abortableSleep(RETRY_DELAY_MS, signal);
                            continue;
                        }
                        catch {
                            break;
                        }
                    }
                    break;
                }
            }
            const err = lastError ?? new JevError("response", "unknown failure.");
            record(false, 0);
            if (err.code === "http" && (err.status === 401 || err.status === 403)) {
                callOut(ctx, "run:auth", `jev_ask is not authenticated (HTTP ${err.status}); judgments will fail until the key is fixed. Key source: ${keyInfo.source}.`);
            }
            throw err;
        },
        renderCall(args) {
            const n = args && typeof args === "object" && args.questions ? Object.keys(args.questions).length : "?";
            const model = args && typeof args === "object" && typeof args.model === "string" ? args.model : DEFAULT_MODEL;
            return new Text(`jev_ask · ${n} questions · ${model} · external request`, 0, 0);
        },
        renderResult(result, { expanded, isPartial }) {
            if (isPartial)
                return new Text("jev_ask · waiting for response", 0, 0);
            if (result.details?.answers)
                return new Text(formatResult(result.details, expanded), 0, 0);
            return new Text(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0);
        },
    });
    // ------------------------------------------------------------------ /jev
    const actions = ["enable", "disable", "status", "test", "models"];
    pi.registerCommand("jev", {
        description: "Jev (TypeSafe) opt-in, budget status, sample test, and model discovery",
        getArgumentCompletions(prefix) {
            const matches = actions.filter((a) => a.startsWith(prefix)).map((a) => ({ value: a, label: a }));
            return matches.length ? matches : null;
        },
        async handler(args, ctx) {
            const action = (args.trim() || "status");
            try {
                if (action === "status") {
                    const key = resolveKey();
                    const caps = [`session ${sessionRequests}/${sessionMax()} attempts`];
                    const perDay = envInt("PI_TYPESAFE_JEV_MAX_REQUESTS_PER_DAY");
                    if (perDay !== undefined)
                        caps.push(`${perDay} requests/day`);
                    const tokCap = envInt("PI_TYPESAFE_JEV_MAX_INPUT_TOKENS_PER_DAY");
                    if (tokCap !== undefined)
                        caps.push(`${tokCap} input tok/day`);
                    const usdCap = process.env.PI_TYPESAFE_JEV_MAX_USD_PER_DAY?.trim();
                    if (usdCap)
                        caps.push(`$${usdCap}/day`);
                    report(ctx, `Jev: ${enabled ? "enabled" : "disabled"}. Key: ${key ? key.source : "MISSING"}. ` +
                        `Today: ${todayUsage.requestsStarted} requests (${todayUsage.requestsSucceeded} ok, ${todayUsage.requestsFailed} failed), ` +
                        `${todayUsage.inputTokens} input tokens, ~$${todayUsage.estimatedUsd.toFixed(4)}. ` +
                        `Caps: ${caps.join(", ")}. Default model: ${DEFAULT_MODEL}. ${DISCLOSURE}`, enabled && !key ? "warning" : "info");
                    return;
                }
                if (action === "enable") {
                    if (!resolveKey()) {
                        report(ctx, "No TypeSafe API key found. Set TYPESAFE_API_KEY in the environment or ~/.zshrc first.", "warning");
                        return;
                    }
                    if (await ctx.ui.confirm("Enable jev_ask for this session?", DISCLOSURE)) {
                        enabled = true;
                        report(ctx, `jev_ask enabled. Up to ${sessionMax()} attempts this session; /jev disable stops future agent calls.`);
                    }
                    return;
                }
                if (action === "disable") {
                    enabled = false;
                    report(ctx, "jev_ask disabled for future agent calls. In-flight requests are not cancelled.");
                    return;
                }
                if (!ctx.hasUI) {
                    report(ctx, "This /jev action needs interactive Pi. For headless use set PI_TYPESAFE_JEV_ENABLED=1 and TYPESAFE_API_KEY before launching Pi.", "warning");
                    return;
                }
                if (action === "test") {
                    const key = resolveKey();
                    if (!key) {
                        report(ctx, "No TypeSafe API key found.", "warning");
                        return;
                    }
                    if (!enabled)
                        enabled = true; // operator-initiated sample implies consent for this one call
                    if (!(await ctx.ui.confirm("Send this sample request?", DISCLOSURE)))
                        return;
                    const started = Date.now();
                    const call = await callOnce(key.key, sample);
                    const result = {
                        model: call.model,
                        elapsedMs: call.elapsedMs || Date.now() - started,
                        usage: call.usage,
                        answers: call.answers,
                        lint: lintRequest(sample),
                        estimatedUsd: call.usage.input_tokens * usdPerInputToken(),
                        levels: { frustration: sample.questions.frustration.criteria },
                    };
                    record(true, call.usage.input_tokens);
                    // Terminal-only display: stays out of the model's context.
                    pi.appendEntry("jev-result", result);
                    return;
                }
                if (action === "models") {
                    const key = resolveKey();
                    if (!key) {
                        report(ctx, "No TypeSafe API key found.", "warning");
                        return;
                    }
                    const response = await fetch(`${API_BASE}/v1/models`, {
                        headers: { Authorization: `Bearer ${key.key}` },
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    });
                    if (!response.ok)
                        throw new JevError("http", `HTTP ${response.status} while listing models.`, response.status);
                    const body = await response.json();
                    const models = Array.isArray(body?.data) ? body.data : [];
                    if (models.length === 0) {
                        report(ctx, "Model list is empty (unexpected).");
                        return;
                    }
                    const lines = models.map((m) => {
                        const name = typeof m.name === "string" ? m.name : typeof m.id === "string" ? m.id : "?";
                        const extra = typeof m.description === "string" ? ` — ${shortOption(m.description, 60)}` : "";
                        const date = typeof m.release_date === "string" ? ` (${m.release_date})` : "";
                        return `${name}${date}${extra}`;
                    });
                    report(ctx, `Available models:\n${lines.join("\n")}\n${MODEL_ALIASES}`);
                    return;
                }
                report(ctx, `Usage: /jev ${actions.join(" | ")}`, "warning");
            }
            catch (error) {
                const err = error instanceof JevError ? error : new JevError("response", `unexpected failure (${error instanceof Error ? error.message : "unknown"}).`);
                report(ctx, err.message, "error");
            }
        },
    });
}
