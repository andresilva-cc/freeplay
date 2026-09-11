/**
 * Runs model-authored JavaScript inside the plugin and turns whatever comes
 * back into something JSON-serialisable and small enough to put in a prompt.
 */

/**
 * Limits for `evaluate`, where the model can ask for the whole world by accident.
 */
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 60;
const MAX_STRING_LENGTH = 1000;
const MAX_NODES = 2000;
const MAX_RESULT_CHARS = 16000;

/**
 * Limits for results a tool composed itself. These are already shaped deliberately, so
 * the sanitiser is here only to catch native objects, cycles and throwing getters - not
 * to trim them. A tight depth limit here silently empties nested fields the tool
 * promised, which is worse than no sanitising at all.
 */
const TOOL_MAX_DEPTH = 12;
const TOOL_MAX_NODES = 40000;
const TOOL_MAX_ARRAY_ITEMS = 500;
const TOOL_MAX_OBJECT_KEYS = 200;

export interface ScriptSuccess {
    ok: true;
    result: unknown;
    truncated?: boolean;
}

export interface ScriptFailure {
    ok: false;
    error: string;
}

export type ScriptOutcome = ScriptSuccess | ScriptFailure;

interface Budget {
    nodes: number;
}

/** The caps a sanitise pass runs under. */
interface Limits {
    depth: number;
    arrayItems: number;
    objectKeys: number;
}

const EVALUATE_LIMITS: Limits = {
    depth: MAX_DEPTH,
    arrayItems: MAX_ARRAY_ITEMS,
    objectKeys: MAX_OBJECT_KEYS
};

const TOOL_LIMITS: Limits = {
    depth: TOOL_MAX_DEPTH,
    arrayItems: TOOL_MAX_ARRAY_ITEMS,
    objectKeys: TOOL_MAX_OBJECT_KEYS
};

function describeError(error: unknown): string {
    const candidate = error as { name?: unknown; message?: unknown };

    if (candidate && typeof candidate.message === "string") {
        return (typeof candidate.name === "string" ? candidate.name + ": " : "") + candidate.message;
    }

    return String(error);
}

/** Strips markdown fences and surrounding whitespace that models tend to emit. */
function normalizeCode(code: string): string {
    let normalized = code.trim();

    const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(normalized);
    if (fenced) {
        normalized = fenced[1].trim();
    }

    return normalized;
}

/**
 * Native OpenRCT2 objects expose their data through prototype getters, so own
 * enumerable keys alone would serialise most of them as `{}`.
 */
function collectKeys(value: object): string[] {
    const keys: string[] = [];
    const seen: Record<string, boolean> = {};

    function add(key: string): void {
        if (key === "constructor" || seen[key] === true) {
            return;
        }
        seen[key] = true;
        keys.push(key);
    }

    Object.keys(value).forEach(add);

    let prototype = Object.getPrototypeOf(value) as object | null;
    while (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
        const current = prototype;
        Object.getOwnPropertyNames(current).forEach(function (key) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor && typeof descriptor.get === "function") {
                add(key);
            }
        });
        prototype = Object.getPrototypeOf(current) as object | null;
    }

    return keys;
}

export function sanitizeValue(value: unknown): unknown {
    return sanitize(value, 0, [], { nodes: MAX_NODES }, EVALUATE_LIMITS);
}

/**
 * Sanitise a tool's own result, preserving the structure the tool intended. Truncating
 * here would silently drop rows a tool promised: `list_ride_objects` returned 40 of 41
 * rides with a string in place of the last, while its own count said 41.
 */
export function sanitizeToolResult(value: unknown): unknown {
    return sanitize(value, 0, [], { nodes: TOOL_MAX_NODES }, TOOL_LIMITS);
}

function sanitize(value: unknown, depth: number, stack: object[], budget: Budget, limits: Limits): unknown {
    if (budget.nodes <= 0) {
        return "<truncated: too many values>";
    }
    budget.nodes -= 1;

    if (value === null || typeof value === "undefined") {
        return null;
    }

    const type = typeof value;

    if (type === "boolean" || type === "number") {
        return isNaN(value as number) && type === "number" ? "NaN" : value;
    }

    if (type === "string") {
        const text = value as string;
        return text.length > MAX_STRING_LENGTH
            ? text.substring(0, MAX_STRING_LENGTH) + "... <truncated>"
            : text;
    }

    if (type === "function") {
        return "<function>";
    }

    if (type !== "object") {
        return String(value);
    }

    for (let i = 0; i < stack.length; i++) {
        if (stack[i] === value) {
            return "<circular>";
        }
    }

    if (depth >= limits.depth) {
        return Array.isArray(value) ? "<array depth limit>" : "<object depth limit>";
    }

    stack.push(value as object);

    try {
        if (Array.isArray(value)) {
            const items: unknown[] = [];
            const limit = Math.min(value.length, limits.arrayItems);

            for (let i = 0; i < limit; i++) {
                items.push(sanitize(value[i], depth + 1, stack, budget, limits));
            }

            if (value.length > limit) {
                items.push("<" + String(value.length - limit) + " more of " + String(value.length) + " omitted>");
            }

            return items;
        }

        const source = value as Record<string, unknown>;
        const keys = collectKeys(source);
        const output: Record<string, unknown> = {};
        const limit = Math.min(keys.length, limits.objectKeys);

        for (let i = 0; i < limit; i++) {
            const key = keys[i];
            let propertyValue: unknown;

            try {
                propertyValue = source[key];
            } catch (error) {
                output[key] = "<unreadable: " + describeError(error) + ">";
                continue;
            }

            if (typeof propertyValue === "function") {
                continue;
            }

            output[key] = sanitize(propertyValue, depth + 1, stack, budget, limits);
        }

        if (keys.length > limit) {
            output["<omitted>"] = String(keys.length - limit) + " more properties";
        }

        return output;
    } finally {
        stack.pop();
    }
}

/**
 * Expression form first so `park.cash` works; a parse failure means the code is
 * a statement body, which must end in `return` to produce a value. The choice is
 * made at parse time so mutating scripts never execute twice.
 */
function compile(code: string): () => unknown {
    const asExpression = code.replace(/[\s;]+$/, "");

    if (asExpression !== "") {
        try {
            return new Function("return (" + asExpression + "\n);") as () => unknown;
        } catch (_parseError) {
            // Fall through to statement form.
        }
    }

    return new Function(code) as () => unknown;
}

export function runScript(code: string): ScriptOutcome {
    const normalized = normalizeCode(code);

    if (normalized === "") {
        return { ok: false, error: "Empty script." };
    }

    let action: () => unknown;

    try {
        action = compile(normalized);
    } catch (error) {
        return { ok: false, error: "SyntaxError: " + describeError(error) };
    }

    let value: unknown;

    try {
        value = action();
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }

    const sanitized = sanitize(value, 0, [], { nodes: MAX_NODES }, EVALUATE_LIMITS);
    const serialized = JSON.stringify(sanitized);

    if (typeof serialized === "string" && serialized.length > MAX_RESULT_CHARS) {
        return {
            ok: true,
            truncated: true,
            result: serialized.substring(0, MAX_RESULT_CHARS) + "... <truncated, narrow the script>"
        };
    }

    return { ok: true, result: sanitized };
}
