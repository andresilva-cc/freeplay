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
    /** Render a nested `undefined` as a marker rather than as `null`. */
    markUndefined: boolean;
}

const EVALUATE_LIMITS: Limits = {
    depth: MAX_DEPTH,
    arrayItems: MAX_ARRAY_ITEMS,
    objectKeys: MAX_OBJECT_KEYS,
    markUndefined: true
};

const TOOL_LIMITS: Limits = {
    depth: TOOL_MAX_DEPTH,
    arrayItems: TOOL_MAX_ARRAY_ITEMS,
    objectKeys: TOOL_MAX_OBJECT_KEYS,
    markUndefined: false
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

    if (value === null) {
        return null;
    }

    if (typeof value === "undefined") {
        // "There is no such property" and "the property is null" are different facts about
        // the world, and collapsing them cost one run twelve turns: a script read
        // `map.getTile(x, y).type` back as null, concluded the terrain did not exist, and
        // never found out the tile's data lives under `elements[]`. Only evaluate marks it.
        // A tool composes its own result, where an absent optional field means nothing.
        return depth === 0 || !limits.markUndefined ? null : "<undefined>";
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
 * Every game action the game knows, transcribed from the `ActionType` union in
 * @openrct2/types. It is a static list because OpenRCT2 exposes no way to ask its own
 * registry what it accepts; `registerAction` is wrapped below so an action a plugin
 * defines at runtime joins the set as it is registered.
 */
const KNOWN_ACTION_NAMES = [
    "balloonpress", "bannerplace", "bannerremove", "bannersetcolour", "bannersetname",
    "bannersetstyle", "cheatset", "clearscenery", "footpathadditionplace", "footpathadditionremove",
    "footpathlayoutplace", "footpathplace", "footpathremove", "gamesetspeed", "guestsetflags",
    "guestsetname", "landbuyrights", "landlower", "landraise", "landsetheight", "landsetrights",
    "landsmooth", "largesceneryplace", "largesceneryremove", "largescenerysetcolour", "loadorquit",
    "mapchangesize", "mazeplacetrack", "mazesettrack", "networkmodifygroup", "parkentranceplace",
    "parkentranceremove", "parkmarketing", "parksetdate", "parksetentrancefee", "parksetloan",
    "parksetname", "parksetparameter", "parksetresearchfunding", "pausetoggle", "peeppickup",
    "peepspawnplace", "playerkick", "playersetgroup", "ridecreate", "ridedemolish",
    "rideentranceexitplace", "rideentranceexitremove", "ridefreezerating", "ridesetappearance",
    "ridesetcolourscheme", "ridesetname", "ridesetprice", "ridesetsetting", "ridesetstatus",
    "ridesetvehicle", "scenariosetsetting", "signsetname", "signsetstyle", "smallsceneryplace",
    "smallsceneryremove", "smallscenerysetcolour", "stafffire", "staffhire", "staffsetcolour",
    "staffsetcostume", "staffsetname", "staffsetorders", "staffsetpatrolarea", "surfacesetstyle",
    "tilemodify", "trackdesign", "trackplace", "trackremove", "tracksetbrakespeed", "wallplace",
    "wallremove", "wallsetcolour", "waterlower", "waterraise", "watersetheight"
];

/** Longest action name this will scan or echo, so a runaway string cannot be walked. */
const MAX_ACTION_NAME_SCAN = 120;
const MAX_ACTION_SUGGESTIONS = 5;

const knownActions: Record<string, boolean> = (function () {
    const known: Record<string, boolean> = {};

    for (let i = 0; i < KNOWN_ACTION_NAMES.length; i++) {
        known[KNOWN_ACTION_NAMES[i]] = true;
    }

    return known;
})();

type ActionInvoker = (name: string, args: object, callback?: (result: unknown) => void) => unknown;

interface Guarded {
    __freeplayActionGuard?: boolean;
}

function isKnownActionName(name: string): boolean {
    return typeof name === "string" && knownActions[name.toLowerCase()] === true;
}

/**
 * Known action names whose letters contain every word of what was asked for.
 * `set_ride_status` finds `ridesetstatus`; the real names are one lowercase word, so a
 * model writing snake_case or a plausible reordering gets pointed at the right one.
 */
function suggestActionNames(name: string): string[] {
    const tokens = String(name)
        .substring(0, MAX_ACTION_NAME_SCAN)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    const wanted: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].length > 1) {
            wanted.push(tokens[i]);
        }
    }

    if (wanted.length === 0) {
        return [];
    }

    const matches: string[] = [];

    for (let i = 0; i < KNOWN_ACTION_NAMES.length && matches.length < MAX_ACTION_SUGGESTIONS; i++) {
        const candidate = KNOWN_ACTION_NAMES[i];
        let matchesAll = true;

        for (let t = 0; t < wanted.length; t++) {
            if (candidate.indexOf(wanted[t]) < 0) {
                matchesAll = false;
                break;
            }
        }

        if (matchesAll) {
            matches.push(candidate);
        }
    }

    return matches;
}

/**
 * The game answers an action name it has never heard of with a null result and no error,
 * which reads as success. One run was told twice that a ride had been demolished, said so,
 * and then failed to build because the ride was still standing. So an unknown name stops
 * the script here instead.
 */
function requireKnownActionName(caller: string, name: unknown): void {
    if (isKnownActionName(name as string)) {
        return;
    }

    const asked = String(name).substring(0, MAX_ACTION_NAME_SCAN);
    const suggestions = suggestActionNames(asked);

    throw new Error("context." + caller + ": there is no game action named \"" + asked + "\", so nothing happened."
        + " The game answers an unknown action name with a null result, which is not success."
        + (suggestions.length > 0
            ? " Did you mean " + suggestions.join(", ") + "?"
            : " Action names are a single lowercase word with no separators, such as ridesetstatus."));
}

function markGuarded<T>(fn: T): T {
    (fn as unknown as Guarded).__freeplayActionGuard = true;
    return fn;
}

/** The object in the prototype chain that actually owns `key`, so the original cannot survive. */
function findPropertyOwner(target: object, key: string): object | null {
    let current: object | null = target;

    while (current !== null) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
            return current;
        }

        current = Object.getPrototypeOf(current) as object | null;
    }

    return null;
}

function replaceProperty(owner: object, key: string, value: unknown): boolean {
    const record = owner as Record<string, unknown>;

    try {
        // Non-writable and non-configurable: a script cannot put the raw invoker back, and
        // the original survives only inside the wrapper's closure, which nothing can reach.
        Object.defineProperty(owner, key, {
            value: value, writable: false, configurable: false, enumerable: false
        });
    } catch (_defineError) {
        try {
            record[key] = value;
        } catch (_assignError) {
            return false;
        }
    }

    return record[key] === value;
}

function guardInvoker(key: string, wrap: (original: ActionInvoker) => ActionInvoker): void {
    const owner = findPropertyOwner(context as unknown as object, key);

    if (owner === null) {
        return;
    }

    const original = (owner as Record<string, unknown>)[key];

    if (typeof original !== "function" || (original as Guarded).__freeplayActionGuard === true) {
        return;
    }

    replaceProperty(owner, key, markGuarded(wrap(original as ActionInvoker)));
}

/**
 * Wraps the action entry points so an invented action name fails loudly and by name.
 *
 * The wrapper is installed on whichever object in the prototype chain declares the
 * method - not shadowed on `context` - so `Object.getPrototypeOf(context).queryAction`
 * is the wrapper too, and the original is reachable only from inside the closure.
 * Installing it is therefore not something an evaluated script can undo.
 */
export function installActionGuards(): void {
    if (typeof context === "undefined" || !context) {
        return;
    }

    guardInvoker("queryAction", function (original) {
        return function (this: unknown, name: string, args: object, callback?: (result: unknown) => void): unknown {
            requireKnownActionName("queryAction", name);

            let answer: unknown;
            let answered = false;

            original.call(this, name, args, function (result: unknown) {
                answer = result;
                answered = true;

                if (typeof callback === "function") {
                    callback(result);
                }
            });

            // queryAction itself returns nothing, so a script that did not pass a callback
            // saw `null` whatever the game said. A query changes nothing, so handing its
            // answer straight back is information and cannot be mistaken for a world change.
            return answered ? answer : undefined;
        };
    });

    guardInvoker("executeAction", function (original) {
        return function (this: unknown, name: string, args: object, callback?: (result: unknown) => void): unknown {
            requireKnownActionName("executeAction", name);

            // Deliberately not returning the result the way queryAction does: an accepted
            // action has not happened yet, and a result that looks like success is exactly
            // what this project verifies by re-reading the world instead.
            return original.call(this, name, args, callback);
        };
    });

    guardInvoker("registerAction", function (original) {
        return function (this: unknown, name: string, query: object, execute?: (result: unknown) => void): unknown {
            if (typeof name === "string" && name !== "") {
                knownActions[name.toLowerCase()] = true;
            }

            return original.call(this, name, query, execute);
        };
    });
}

/**
 * The names a value really has, including the prototype getters and methods the game's
 * objects expose their data through.
 *
 * `Object.keys(map)`, `Object.keys(park)` and `Object.keys(context)` are all `[]` - the
 * native objects own no enumerable properties - and seven attempts at introspection across
 * two runs found nothing. This is handed to evaluated scripts as `keys(value)`.
 */
export function apiKeys(value: unknown): string[] {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return [];
    }

    const names: string[] = [];
    const seen: Record<string, boolean> = {};

    function add(key: string): void {
        if (key === "constructor" || seen[key] === true) {
            return;
        }

        seen[key] = true;
        names.push(key);
    }

    Object.keys(value as object).forEach(add);

    let prototype = Object.getPrototypeOf(value as object) as object | null;

    while (prototype !== null
        && prototype !== Object.prototype
        && prototype !== Array.prototype
        && prototype !== Function.prototype) {
        Object.getOwnPropertyNames(prototype).forEach(add);
        prototype = Object.getPrototypeOf(prototype) as object | null;
    }

    return names.sort();
}

/**
 * Expression form first so `park.cash` works; a parse failure means the code is
 * a statement body, which must end in `return` to produce a value. The choice is
 * made at parse time so mutating scripts never execute twice.
 */
function compile(code: string): (keys: (value: unknown) => string[]) => unknown {
    const asExpression = code.replace(/[\s;]+$/, "");

    if (asExpression !== "") {
        try {
            return new Function("keys", "return (" + asExpression + "\n);") as (keys: (value: unknown) => string[]) => unknown;
        } catch (_parseError) {
            // Fall through to statement form.
        }
    }

    return new Function("keys", code) as (keys: (value: unknown) => string[]) => unknown;
}

export function runScript(code: string): ScriptOutcome {
    const normalized = normalizeCode(code);

    if (normalized === "") {
        return { ok: false, error: "Empty script." };
    }

    let action: (keys: (value: unknown) => string[]) => unknown;

    try {
        action = compile(normalized);
    } catch (error) {
        return { ok: false, error: "SyntaxError: " + describeError(error) };
    }

    installActionGuards();

    let value: unknown;

    try {
        value = action(apiKeys);
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
