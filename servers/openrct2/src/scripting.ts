/**
 * Runs model-authored JavaScript inside the plugin and turns whatever comes
 * back into something JSON-serialisable and small enough to put in a prompt.
 */

import { runActionWithClock } from "./clockGate.js";

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
 * How much of an over-long string is kept from its end.
 *
 * A cut string loses its middle, not its tail, because a composed message puts its most
 * consequential sentence last: build_path appends "WARNING: 5 path tiles are no longer
 * reachable from the park entrance" after the explanation, and a head-only cut ate exactly
 * that - twice in one run, while the model spent fifteen turns wondering why guests could
 * not reach a ride it had just cut off. A share of the cap rather than a field name or a
 * bigger number, so it holds for the next long message nobody has written yet: whatever
 * the string's length, the last characters of it survive.
 */
const STRING_TAIL_SHARE = 0.4;

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
/**
 * A tool's own prose gets four times evaluate's room before it is cut at all. The strings
 * here are sentences a tool wrote on purpose - build_path's `detail` runs past 1000
 * characters whenever a run is cut off and warned about - whereas an over-long string out
 * of `evaluate` is a script that asked for too much. Still a cap and not an exemption: the
 * ceiling is what stops one runaway result filling the context, and it now bounds the
 * middle of a string rather than its end.
 */
const TOOL_MAX_STRING_LENGTH = 4000;

/** One invariant that moved while a script ran, with no game action to account for it. */
export interface StateChange {
    property: string;
    before: unknown;
    after: unknown;
}

export interface ScriptSuccess {
    ok: true;
    result: unknown;
    truncated?: boolean;
    unaccountedChanges?: StateChange[];
    note?: string;
}

export interface ScriptFailure {
    ok: false;
    error: string;
    unaccountedChanges?: StateChange[];
    note?: string;
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
    stringLength: number;
    /** Render a nested `undefined` as a marker rather than as `null`. */
    markUndefined: boolean;
}

const EVALUATE_LIMITS: Limits = {
    depth: MAX_DEPTH,
    arrayItems: MAX_ARRAY_ITEMS,
    objectKeys: MAX_OBJECT_KEYS,
    stringLength: MAX_STRING_LENGTH,
    markUndefined: true
};

const TOOL_LIMITS: Limits = {
    depth: TOOL_MAX_DEPTH,
    arrayItems: TOOL_MAX_ARRAY_ITEMS,
    objectKeys: TOOL_MAX_OBJECT_KEYS,
    stringLength: TOOL_MAX_STRING_LENGTH,
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

/**
 * Cut an over-long string in the middle, keeping its beginning and its end, and say how
 * much went and that what follows is the end of it.
 *
 * The end is kept because that is where a message puts the thing it most needs read: every
 * warning this codebase appends is appended last. Cutting the middle costs the part of a
 * long message that is most often ordinary explanation, and - unlike raising the cap -
 * holds for a string of any length, because both ends survive however far apart they are.
 * The output is still bounded: the cap plus the marker, whatever came in.
 */
function capString(text: string, cap: number): string {
    if (text.length <= cap) {
        return text;
    }

    const tail = Math.floor(cap * STRING_TAIL_SHARE);
    const head = cap - tail;

    return text.substring(0, head)
        + " ... <truncated: " + String(text.length - cap) + " characters cut from the middle,"
        + " the end of the string follows> ... "
        + text.substring(text.length - tail);
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
        return capString(value as string, limits.stringLength);
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

/**
 * This load of the plugin, as an identity rather than a flag.
 *
 * OpenRCT2 keeps one `context` object for the whole process and re-runs the plugin file on
 * every hot reload - which `npm run watch` triggers on every save - so the wrappers an
 * earlier load installed are still sitting in the slots. Their closures hold that load's
 * `insideEvaluate`, action log, refusal list and known-action set, and none of those are
 * this load's. A boolean "already guarded" mark cannot tell the two apart, so every guard
 * that reads module state was dead from the second load onwards while the report went on
 * calling it frozen. Comparing identities is what makes re-installing possible.
 */
const GUARD_LOAD: object = {};

interface Guarded {
    /** The load that installed this wrapper. `true` is how builds before this one marked it. */
    __freeplayActionGuard?: object | boolean;
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

/**
 * The game will run these, and running them is not playing. They are refused by name at
 * the entry point rather than by freezing anything, because the action layer is the only
 * place they exist: `cheatset` alone can set cash, park rating, ride ratings and
 * scenario completion in one call.
 */
function refuseCheatAction(caller: string, name: unknown): void {
    const key = typeof name === "string" ? name.toLowerCase() : "";
    const why = REFUSED_ACTIONS[key];

    if (why === undefined) {
        return;
    }

    throw new Error("context." + caller + ": " + key + " is not available in this run. "
        + why + " " + EARNED_INSTEAD);
}

function markGuarded<T>(fn: T): T {
    (fn as unknown as Guarded).__freeplayActionGuard = GUARD_LOAD;
    return fn;
}

/**
 * Installed by *this* load, not merely by some load of this plugin. The action wrappers
 * close over the refusal list, the known-action set and the executed-action log, so one
 * left behind by an earlier load is a different set of all three and has to be wrapped
 * again rather than trusted.
 */
function isOurActionGuard(value: unknown): boolean {
    return typeof value === "function" && (value as unknown as Guarded).__freeplayActionGuard === GUARD_LOAD;
}

/** Marked by any load of this plugin, including builds that marked it with `true`. */
function isActionGuard(value: unknown): boolean {
    return typeof value === "function"
        && typeof (value as unknown as Guarded).__freeplayActionGuard !== "undefined";
}

/** The wrapper this load put in each slot, so a stranger in one can be evicted for it. */
const ownActionGuards: Record<string, { owner: object; wrapper: ActionInvoker } | undefined> = {};

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

/**
 * Put a wrapper in a slot and say whether it took.
 *
 * Always `configurable: false`, so `delete` and a redefinition both fail. `writable: true`
 * on every guard slot, which costs nothing and buys the one thing that was missing: the
 * next load of the plugin can take the slot back off the last one. A script that overwrites
 * a writable slot reaches nothing by it - the real invoker exists only inside the wrapper's
 * closure, so all it can do is break its own calls - and the next `evaluate` wraps whatever
 * it left there before running anything.
 */
function replaceProperty(owner: object, key: string, value: unknown): boolean {
    const record = owner as Record<string, unknown>;

    try {
        Object.defineProperty(owner, key, {
            value: value, writable: true, configurable: false, enumerable: false
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

function guardInvoker(key: string, wrap: (original: ActionInvoker) => ActionInvoker): GuardOutcome {
    const owner = findPropertyOwner(context as unknown as object, key);

    if (owner === null) {
        return "absent";
    }

    const original = (owner as Record<string, unknown>)[key];

    if (isOurActionGuard(original)) {
        return "frozen";
    }

    if (typeof original !== "function") {
        return "absent";
    }

    const own = ownActionGuards[key];

    // Nothing legitimate swaps these three - unlike `context.setTimeout`, which src/mcp.ts
    // does swap - so an unmarked function in a slot we have already taken is a script's,
    // left behind by an earlier evaluate. Ours goes back rather than wrapping it, or every
    // typed tool would spend the rest of the session calling whatever the script left.
    if (typeof own !== "undefined" && own.owner === owner && !isActionGuard(original)) {
        return replaceProperty(owner, key, own.wrapper) ? "frozen" : "refused";
    }

    // An earlier load's wrapper is wrapped rather than unwrapped: its original is sealed in
    // its own closure, so the only way to get this load's refusal list in front of the game
    // is to sit in front of it. The extra name check it does on the way through is harmless.
    const wrapper = markGuarded(wrap(original as ActionInvoker));

    ownActionGuards[key] = { owner: owner, wrapper: wrapper };

    return replaceProperty(owner, key, wrapper) ? "frozen" : "refused";
}

type ResultCallback = (result: unknown) => void;

/**
 * A callback a script hands to the game runs under the same guards the script did.
 *
 * `context.executeAction` hands the action to the game and calls back when the game applies
 * it, which is a later tick - by which point `evaluate` has answered and `insideEvaluate` is
 * false again, so the script's own code would get a tick on which the timers, `subscribe`
 * and `ui` are open to it. It is the script's code either way, so it keeps the script's
 * rules. Nothing is refused that was not already: the callback itself still runs, and a
 * callback a typed tool passes is untouched, because `insideEvaluate` is false when a tool
 * calls and only what is handed over from inside a script is wrapped.
 */
function guardScriptCallback(callback: ResultCallback | undefined): ResultCallback | undefined {
    if (!insideEvaluate || typeof callback !== "function") {
        return callback;
    }

    return function (this: unknown, result: unknown): void {
        const wasInsideEvaluate = insideEvaluate;
        insideEvaluate = true;

        try {
            callback.call(this, result);
        } finally {
            insideEvaluate = wasInsideEvaluate;
        }
    };
}

/**
 * Wraps the action entry points so an invented action name fails loudly and by name.
 *
 * The wrapper is installed on whichever object in the prototype chain declares the
 * method - not shadowed on `context` - so `Object.getPrototypeOf(context).queryAction`
 * is the wrapper too, and the original is reachable only from inside the closure.
 * Installing it is therefore not something an evaluated script can undo.
 *
 * Each slot is reported as a lever, because the refusal list lives here and nowhere else:
 * a slot this load could not take is a hole, and it has to show up in `GET /v1` rather
 * than in nothing at all.
 */
export function installActionGuards(): void {
    if (typeof context === "undefined" || !context) {
        return;
    }

    recordLever("context.queryAction", guardInvoker("queryAction", function (original) {
        return function (this: unknown, name: string, args: object, callback?: (result: unknown) => void): unknown {
            requireKnownActionName("queryAction", name);
            refuseCheatAction("queryAction", name);

            let answer: unknown;
            let answered = false;
            const guarded = guardScriptCallback(callback);

            original.call(this, name, args, function (result: unknown) {
                answer = result;
                answered = true;

                if (typeof guarded === "function") {
                    guarded(result);
                }
            });

            // queryAction itself returns nothing, so a script that did not pass a callback
            // saw `null` whatever the game said. A query changes nothing, so handing its
            // answer straight back is information and cannot be mistaken for a world change.
            return answered ? answer : undefined;
        };
    }));

    recordLever("context.executeAction", guardInvoker("executeAction", function (original) {
        return function (this: unknown, name: string, args: object, callback?: (result: unknown) => void): unknown {
            requireKnownActionName("executeAction", name);
            refuseCheatAction("executeAction", name);
            recordExecutedAction(name);

            const guarded = guardScriptCallback(callback);

            // Every action the bridge fires passes through here, which is the one place that
            // can let the clock run across it. The pause between tool calls is the bridge's
            // bookkeeping and OpenRCT2 refuses most actions through one, so the two have to
            // meet somewhere; a pause the model asked for is left in force and the refusal
            // comes back as it always did.
            //
            // Deliberately not returning the result the way queryAction does: an accepted
            // action has not happened yet, and a result that looks like success is exactly
            // what this project verifies by re-reading the world instead. Which is also why
            // the callback is wrapped: the game calls it on the tick it applies the action,
            // and that is a tick the script would otherwise be running on unguarded.
            return runActionWithClock(name, () => original.call(this, name, args, guarded));
        };
    }));

    recordLever("context.registerAction", guardInvoker("registerAction", function (original) {
        return function (this: unknown, name: string, query: object, execute?: (result: unknown) => void): unknown {
            // The same hole as a timer, one step further round: the game runs a custom
            // action's execute function when that action is executed, on a later tick.
            // Only the plugin registers actions, and it does so outside any script.
            if (insideEvaluate) {
                throw new Error("context.registerAction() cannot be called from an evaluated script. "
                    + CUSTOM_ACTIONS_RUN_LATER + " " + EARNED_INSTEAD);
            }

            if (typeof name === "string" && name !== "") {
                knownActions[name.toLowerCase()] = true;
            }

            return original.call(this, name, query, execute);
        };
    }));
}

/**
 * Game actions the game will happily run that hand the park a result it did not earn.
 * These are the game's own cheat and scenario-editor entry points; no typed tool uses one,
 * and a run whose numbers came out of them is not a run of the park.
 */
const REFUSED_ACTIONS: Record<string, string> = {
    cheatset: "cheatset is the cheat menu: it sets cash, park rating, ride ratings and scenario completion directly.",
    scenariosetsetting: "scenariosetsetting edits the scenario itself, including the objective and its deadline.",
    parksetdate: "parksetdate moves the calendar, and the objective has a deadline measured in years.",
    ridefreezerating: "ridefreezerating pins a ride's excitement, intensity and nausea so they stop following the ride."
};

/**
 * Closes every refusal. A bare "denied" teaches nothing; naming the mechanism that does
 * move the number is the whole point, so every message ends by pointing back at the park.
 */
const EARNED_INSTEAD = "A run's figures come out of running the park: rides guests want to ride,"
    + " a clean and well staffed park, and prices guests will pay.";

const GUESTS_ARRIVE = "Guests walk in on their own, drawn by the park rating, the entrance fee and"
    + " advertising; the parkmarketing action buys a campaign.";

const RATING_IS_CONDITION = "The park rating is recalculated by the game from the park's condition:"
    + " ride quality and variety, queue lengths, litter and vandalism, staff coverage,"
    + " and how long guests are kept waiting.";

const CASH_IS_EARNED = "Cash is what the park has taken minus what it has spent - ride and shop takings,"
    + " the entrance fee, wages and running costs - plus whatever is borrowed through the parksetloan action.";

const RIDE_RATINGS_ARE_THE_TRACK = "A ride's ratings are calculated from the ride itself once it has been"
    + " tested: its layout, length, drops, speed, G-forces and surroundings. Rebuild the track to change them.";

const OBJECTIVE_IS_THE_SCENARIO = "The objective and its status belong to the scenario; the game marks it"
    + " complete when the park actually meets it.";

const AWARDS_ARE_GIVEN = "Awards are handed out by the game for what the park is actually like.";

const CHEATS_ARE_OFF = "The cheat menu is not part of playing the park.";

/**
 * Deferred work is the one route that escapes both halves of this at once: the write
 * lands after the before/after reading is taken, and no game action is logged for it.
 * Refusing it costs the model nothing, because a script cannot observe its own deferred
 * result either - `evaluate` answers the moment the script returns.
 */
const SCHEDULED_FOR_LATER = "A script runs inside one game tick and evaluate answers the moment it"
    + " returns, so a callback scheduled for later would run after you had already been given the"
    + " result and nothing it did could be reported back to you. Do the work in the script itself,"
    + " or use a typed tool, which is built to span ticks.";

const TIMERS_BELONG_TO_TOOLS = "The timers in flight belong to the typed tools, which schedule their"
    + " own continuations across ticks, and cancelling one would strand a build half finished."
    + " A script has none of its own to cancel, because it cannot schedule one.";

/**
 * Why the whole namespace and not the members of it that take a callback.
 *
 * Every `ui` member that does anything takes one: `openWindow` alone carries onUpdate,
 * onClose and onTabChange plus an onClick, onChange, onIncrement or onDraw on each widget,
 * and `activateTool` five more. Enumerating them is a list that goes stale the next time the
 * plugin API grows a member, which is exactly how `openWindow` sat open behind the timer
 * guards. Nothing is lost by refusing the reads too: `ui.width` and `ui.tool` describe a
 * screen the model cannot see, and the plugin's own error dialog is put up by a typed tool,
 * outside any script, where the namespace is untouched.
 */
const NOBODY_IS_LOOKING = "The ui namespace is the game's window system, and every part of it that does"
    + " anything takes a callback the game calls later: openWindow (onUpdate, onClose, and the onClick,"
    + " onChange and onIncrement its widgets carry), activateTool, registerMenuItem, registerToolboxMenuItem,"
    + " registerShortcut, showTextInput, showFileBrowse and showScenarioSelect. Nobody is at the screen to"
    + " answer a window either, so there is nothing on the other side of it for you. The namespace is refused"
    + " whole rather than those members one at a time, because a member nobody thought to list is how this"
    + " stayed open. " + SCHEDULED_FOR_LATER;

const CUSTOM_ACTIONS_RUN_LATER = "A custom action's query and execute functions are run by the game when that"
    + " action is executed, on a later tick, and registering one also puts its name into the set of action"
    + " names this plugin accepts - the check that catches an invented one. " + SCHEDULED_FOR_LATER;

const HOOKS_FIRE_LATER = "A hook fires on a later tick, after evaluate has already answered, so nothing"
    + " it sees can be reported back to you - and several hooks hand the subscriber the figures the"
    + " game has just worked out, to overwrite: ride.ratings.calculate offers a ride's excitement,"
    + " intensity and nausea, and action.query offers the result of an action that was about to be"
    + " refused. Ride ratings come out of the track that was built.";

/** `park` members that hand out a result, with the mechanism that really moves each one. */
const PARK_LEVERS: Record<string, string> = {
    cash: CASH_IS_EARNED,
    rating: RATING_IS_CONDITION,
    bankLoan: "The loan moves through the parksetloan action, up to park.maxBankLoan, and the park pays interest on it.",
    maxBankLoan: "The borrowing ceiling is a scenario setting.",
    value: "Park value is recalculated from what the park owns: its rides, their ratings and their age, and its land.",
    companyValue: "Company value is park value plus cash minus the loan, so it moves when those move.",
    totalAdmissions: "Admissions count the guests who have walked through the entrance.",
    totalIncomeFromAdmissions: "Admission income accrues as guests pay the entrance fee.",
    landPrice: "Land costs what the scenario charges for it.",
    constructionRightsPrice: "Construction rights cost what the scenario charges for them.",
    casualtyPenalty: "The casualty penalty is applied by the game for drowned guests and crashed cars, and fades as the park runs safely.",
    guests: GUESTS_ARRIVE,
    suggestedGuestMaximum: "The soft guest cap rises as the park earns a better rating and better rides.",
    guestGenerationProbability: GUESTS_ARRIVE,
    guestInitialCash: "What guests arrive carrying is a scenario setting.",
    guestInitialHappiness: "What guests arrive feeling is a scenario setting; what happens to them afterwards is the park's doing.",
    guestInitialHunger: "What guests arrive feeling is a scenario setting.",
    guestInitialThirst: "What guests arrive feeling is a scenario setting."
};

/** `scenario` members that decide whether the run is won. */
const SCENARIO_LEVERS: Record<string, string> = {
    status: OBJECTIVE_IS_THE_SCENARIO,
    objective: OBJECTIVE_IS_THE_SCENARIO,
    completedBy: OBJECTIVE_IS_THE_SCENARIO,
    completedCompanyValue: "The game records this when the scenario completes.",
    companyValueRecord: "The game records the highest company value the park has reached.",
    filename: "The scenario file is which scenario is being played, and the game files a completion score"
        + " against that name.",
    parkRatingWarningDays: "This counts the consecutive days the park rating has sat under the scenario's"
        + " threshold, and resets itself when the rating comes back up."
};

/** The objective's own fields: moving the goalposts is the same cheat as faking the score. */
const OBJECTIVE_LEVERS: Record<string, string> = {
    type: OBJECTIVE_IS_THE_SCENARIO,
    guests: OBJECTIVE_IS_THE_SCENARIO,
    year: OBJECTIVE_IS_THE_SCENARIO,
    length: OBJECTIVE_IS_THE_SCENARIO,
    excitement: OBJECTIVE_IS_THE_SCENARIO,
    parkValue: OBJECTIVE_IS_THE_SCENARIO,
    monthlyIncome: OBJECTIVE_IS_THE_SCENARIO
};

/**
 * `Ride` members, guarded on the shared prototype so every ride - including ones built
 * later - is covered by one install.
 *
 * The named ones carry the mechanism that really moves them; everything else the prototype
 * declares writable is frozen too, with `RIDE_IS_BUILT` as the reason. That way round on
 * purpose: this table was a list of nine and the prototype has thirty-odd setters, so the
 * twenty that nobody had listed - `mode`, `liftHillSpeed`, `trackType`'s neighbours, the
 * lot - were open. Each of them has a game action that does the same thing with the game's
 * own validation in front of it, so freezing the setter costs the model nothing.
 */
const RIDE_IS_BUILT = "A ride's own settings move through the ride actions - ridesetprice, ridesetsetting,"
    + " ridesetappearance, ridesetname - which validate what they are given against the ride that was"
    + " actually built. Assigning the field writes past that check.";

const RIDE_LEVERS: Record<string, string> = {
    excitement: RIDE_RATINGS_ARE_THE_TRACK,
    intensity: RIDE_RATINGS_ARE_THE_TRACK,
    nausea: RIDE_RATINGS_ARE_THE_TRACK,
    value: "A ride's value follows from its ratings and its age.",
    runningCost: "Running cost follows from the ride type and the layout that was built.",
    totalProfit: "A ride's takings accumulate as guests pay to ride it.",
    totalCustomers: "A ride's customer count rises as guests ride it.",
    buildDate: "The build date is when the ride was built.",
    lifecycleFlags: "Lifecycle flags record what the game has done to the ride, including whether it has been tested."
};

/** Skipped by the ride sweep; the reason it is skipped is in `OPEN_LEVERS`. */
const RIDE_OPEN: Record<string, boolean> = { price: true };

/** Ride methods that do a mechanic's job, or the game's, without either. */
const RIDE_METHOD_LEVERS: Record<string, string> = {
    fixBreakdown: "A broken ride is repaired by a mechanic walking to it, which is what hire_staff is for;"
        + " inspection interval decides how often one comes before it breaks at all.",
    setBreakdown: "Breakdowns are the game's, worked out from the ride's reliability and how long since"
        + " it was last inspected."
};

/**
 * The one park flag a player sets while playing. Everything else `ParkFlags` can reach is
 * a rule of the scenario rather than a state of the park.
 *
 * This was a deny list of four against a `ParkFlags` union of thirteen, on the reasoning
 * that blocking an unlisted flag would break playing for no gain. The reasoning does not
 * survive the actual list: of the thirteen, twelve are scenario rules - the four forbids,
 * the two intensity preferences, freeParkEntry, scenarioCompleteNameInput and the four
 * already named - and exactly one, `open`, is something a player does. So an allow list of
 * one, and a flag the plugin API grows later is refused rather than silently permitted.
 */
const PLAYABLE_FLAGS: Record<string, boolean> = { open: true };

const FLAG_LEVERS: Record<string, string> = {
    noMoney: "The noMoney flag switches the park's finances off entirely.",
    unlockAllPrices: "The unlockAllPrices flag lifts the scenario's own pricing rule.",
    difficultGuestGeneration: "difficultGuestGeneration is the scenario's own difficulty setting.",
    difficultParkRating: "difficultParkRating is the scenario's own difficulty setting.",
    freeParkEntry: "freeParkEntry decides whether this scenario charges admission at all.",
    forbidMarketingCampaigns: "forbidMarketingCampaigns is the scenario's own rule about advertising.",
    forbidHighConstruction: "forbidHighConstruction is the scenario's own rule about building height.",
    forbidLandscapeChanges: "forbidLandscapeChanges is the scenario's own rule about terraforming.",
    forbidTreeRemoval: "forbidTreeRemoval is the scenario's own rule about clearing scenery.",
    preferLessIntenseRides: "preferLessIntenseRides is what this scenario's guests are like.",
    preferMoreIntenseRides: "preferMoreIntenseRides is what this scenario's guests are like.",
    scenarioCompleteNameInput: "scenarioCompleteNameInput belongs to how the game files a completed scenario."
};

const UNLISTED_FLAG = "Only the park's open flag is a player's to set; every other flag in this API is a rule"
    + " of the scenario rather than a state of the park.";

/**
 * Why guest state is frozen at all, when the park rating check cannot see it move.
 *
 * `map.getAllEntities('guest').forEach(g => { g.happiness = 255 })` returned ok:true on a
 * build whose guard summary said every lever was frozen. The park rating is worked out by
 * the game from guest happiness among other things, and guest cash becomes park cash the
 * moment a guest spends it, so this reaches the objective - and the invariant check below
 * cannot catch it, because the game recalculates the rating every 512 ticks and both of
 * its readings are taken inside one tick.
 */
const GUESTS_FEEL_WHAT_THE_PARK_IS = "How a guest feels is the park's doing: rides they want to ride, short"
    + " queues, food and drink where they are hungry, toilets, benches, a clean and well staffed park."
    + " The park rating is worked out from it, so writing it writes the rating.";

const GUEST_CASH_IS_SPENT = "What a guest is carrying is what the scenario sent them in with, minus what they"
    + " have spent; it becomes the park's money only when they spend it.";

const PEEP_IS_THE_GAMES = "Where a peep is, where it is going and what it is carrying are the game walking it"
    + " round the park. A script that writes them is playing the guests rather than the park.";

const STAFF_ARE_HIRED = "Staff are hired through the staffhire action - hire_staff - and what kind each one is"
    + " is fixed when they are hired.";

const ENTITIES_ARE_REMOVED_BY_STAFF = "Litter, vandalism and everything else lying about the park is cleared by"
    + " handymen and mechanics walking to it, which is what hire_staff is for; removing it from a script does"
    + " a wage's work for nothing, and the park rating counts it.";

/**
 * Why the whole tile element prototype and not a list of members.
 *
 * `map.getTile(5, 5).elements[0].ownership = 160` returned ok:true - park ownership plus
 * construction rights on a tile, for no cash, past `landbuyrights` and `park.landPrice`
 * both; park value follows owned land. Everything else the element prototype declares is
 * the same shape of hole: `slope` and `baseZ` are free terraforming, `addition` is a free
 * bench, `additionStatus` empties a bin a handyman is paid to empty, `isQueue` and `edges`
 * are free footpath construction, `trackType` rebuilds a ride the ratings are calculated
 * from. Every one of them has a game action that charges for it.
 *
 * So the prototype is frozen whole rather than member by member. The model has no
 * legitimate write here at all: everything it builds, it builds through a typed tool or a
 * game action, and both of those write the game's own C++ side rather than these setters.
 * Reads are untouched - `ownership`, `baseZ` and the rest are how the tools and the model
 * read the map.
 */
const MAP_IS_BUILT = "The map is what the construction actions have put there. Land is bought with the"
    + " landbuyrights action at park.landPrice - buy_land - paths and rides are built by the build tools,"
    + " and terrain is raised and lowered by the land actions. Each of those charges the park for the work.";

const TILE_IS_THE_MAP = "A tile's elements are added and taken away by the construction and removal actions,"
    + " which charge for the work and refuse what cannot be built. " + MAP_IS_BUILT;

const GUEST_WILL_RIDE = "What a guest is willing to ride is who the game sent through the gate; a park that"
    + " wants those guests on that ride builds one they will queue for.";

/**
 * `Guest`, `Peep`, `Entity` and the staff kinds all in one table, because they are one
 * prototype chain and `findPropertyOwner` lands each member on whichever link declares it.
 * Anything the chain declares writable and this table does not name is frozen anyway, with
 * the surface's own fallback reason.
 */
const GUEST_LEVERS: Record<string, string> = {
    happiness: GUESTS_FEEL_WHAT_THE_PARK_IS,
    happinessTarget: GUESTS_FEEL_WHAT_THE_PARK_IS,
    nausea: GUESTS_FEEL_WHAT_THE_PARK_IS,
    nauseaTarget: GUESTS_FEEL_WHAT_THE_PARK_IS,
    hunger: GUESTS_FEEL_WHAT_THE_PARK_IS,
    thirst: GUESTS_FEEL_WHAT_THE_PARK_IS,
    toilet: GUESTS_FEEL_WHAT_THE_PARK_IS,
    energy: GUESTS_FEEL_WHAT_THE_PARK_IS,
    energyTarget: GUESTS_FEEL_WHAT_THE_PARK_IS,
    cash: GUEST_CASH_IS_SPENT,
    mass: GUEST_WILL_RIDE,
    minIntensity: GUEST_WILL_RIDE,
    maxIntensity: GUEST_WILL_RIDE,
    nauseaTolerance: GUEST_WILL_RIDE,
    favouriteRide: GUEST_WILL_RIDE,
    lostCountdown: "A lost guest is one the park's paths did not lead anywhere, and the park rating counts it.",
    x: PEEP_IS_THE_GAMES,
    y: PEEP_IS_THE_GAMES,
    z: PEEP_IS_THE_GAMES,
    destination: PEEP_IS_THE_GAMES,
    direction: PEEP_IS_THE_GAMES,
    staffType: STAFF_ARE_HIRED,
    peepType: STAFF_ARE_HIRED
};

/**
 * `setFlag` is here for the same reason `park.setFlag` is: `PeepFlags` carries
 * "leavingPark", "lost", "happiness" and "nausea", so clearing one keeps a guest in the
 * park or stops them minding what the park is like. The item methods hand a guest for
 * nothing what a shop sells them.
 */
const PEEP_METHOD_LEVERS: Record<string, string> = {
    setFlag: "A peep's flags are what the game has decided about them - whether they are leaving, lost,"
        + " unhappy or feeling sick - worked out from the park they are walking round.",
    giveItem: "Guests buy what they carry from the park's shops and stalls, which is where the money comes"
        + " from; handing one over gives it away for nothing.",
    removeItem: "What a guest is carrying is theirs until they use or drop it.",
    removeAllItems: "What a guest is carrying is theirs until they use or drop it."
};

const ENTITY_METHOD_LEVERS: Record<string, string> = { remove: ENTITIES_ARE_REMOVED_BY_STAFF };

const TILE_METHOD_LEVERS: Record<string, string> = {
    insertElement: TILE_IS_THE_MAP,
    removeElement: TILE_IS_THE_MAP
};

/** Skipped by the staff sweep; the reasons they are skipped are in `OPEN_LEVERS`. */
const STAFF_OPEN: Record<string, boolean> = { orders: true, costume: true };

/**
 * Every write this build knows it is leaving open, with why.
 *
 * Declared as a property of the build rather than discovered as a property of the park, and
 * so recorded on every install whether or not a ride has been built or a handyman hired.
 * The alternative - record it when the surface turns up - reads clean on a fresh scenario,
 * which is precisely when a pre-run check looks, and reading clean because nobody had got
 * round to looking is the defect this whole field exists to stop.
 *
 * All four are free in the game's own windows and none of them hands the park anything it
 * did not earn: prices still have to be paid by a guest who chooses to ride, and a handyman
 * still has to walk to the litter and is paid a wage either way. They are named anyway,
 * because "we decided this one was fine" is a thing a report should have to say out loud.
 */
const OPEN_LEVERS: Record<string, string> = {
    "ride.price": "Charging what you like is playing the game, and operate_ride sets it through the"
        + " ridesetprice action.",
    "staff.orders": "What a handyman is set to do - sweep, water, mow, empty bins - is a free setting,"
        + " and hire_staff hires with none of them set.",
    "staff.costume": "An entertainer's costume is a free setting, and hire_staff hires with costume 0"
        + " whether the park owns it or not.",
    "staff.patrolArea": "Where staff patrol is a free setting the game's own window offers, and"
        + " hire_staff tells the model to set it through evaluate."
};

/** Entity kinds to look through for the base prototype they all share. Litter first: it is the one
 * whose `remove` is worth a wage. */
const ENTITY_KINDS = ["litter", "guest", "staff", "balloon", "car", "duck", "money_effect"];

type GuardOutcome = "frozen" | "absent" | "refused";
type GuardedMethod = (this: unknown, ...args: unknown[]) => unknown;

const STATE_GUARD_MARK = "__freeplayStateGuard";

/**
 * Which objects have been guarded, by identity rather than by a "done" flag: the game
 * replaces `park` and `scenario` when a scenario is loaded, and a flag would leave the
 * replacements open.
 */
const guardedTargets: object[] = [];
const leverSeen: Record<string, GuardOutcome> = {};
const frozenLevers: string[] = [];
const unfrozenLevers: string[] = [];
/**
 * Writes this build knows it is leaving open, named the moment the surface carrying them
 * is found. Not a list of everything unguarded - that is unknowable - but of the ones
 * somebody looked at and decided against, which is the category the report could not
 * express and the reason four fatal holes read as a clean bill.
 */
const openLevers: string[] = [];
let rideGuardInstalled = false;
let guestGuardInstalled = false;
let staffGuardInstalled = false;
let entityGuardInstalled = false;
let tileElementGuardInstalled = false;
let tileGuardInstalled = false;
/** True only while an evaluated script is on the stack, so a typed tool is never caught. */
let insideEvaluate = false;
let unguardedReported = false;

function markStateGuard<T>(fn: T): T {
    (fn as unknown as Record<string, unknown>)[STATE_GUARD_MARK] = GUARD_LOAD;
    return fn;
}

/**
 * Guarded by some load of this plugin. Enough for a wrapper that reads no module state -
 * a setter that only ever throws behaves the same whichever load wrote it, and a build
 * before this one marked it with `true` rather than an identity.
 */
function isStateGuarded(value: unknown): boolean {
    return typeof value === "function"
        && typeof (value as unknown as Record<string, unknown>)[STATE_GUARD_MARK] !== "undefined";
}

/** Guarded by this load. Required wherever the wrapper closes over something that moves. */
function isOurStateGuard(value: unknown): boolean {
    return typeof value === "function"
        && (value as unknown as Record<string, unknown>)[STATE_GUARD_MARK] === GUARD_LOAD;
}

function recordLever(path: string, outcome: GuardOutcome): void {
    if (outcome === "absent" || leverSeen[path] === outcome) {
        return;
    }

    // A member can be re-guarded after something else replaced the slot, so a path that
    // once refused must be able to move back onto the frozen list rather than lie.
    const from = outcome === "frozen" ? unfrozenLevers : frozenLevers;
    const to = outcome === "frozen" ? frozenLevers : unfrozenLevers;
    const at = from.indexOf(path);

    if (at >= 0) {
        from.splice(at, 1);
    }

    if (to.indexOf(path) < 0) {
        to.push(path);
    }

    leverSeen[path] = outcome;
}

/**
 * A write this build has looked at and left open, recorded from inside the install that
 * found its surface - so a park with no rides in it does not claim a ride lever is open,
 * and a park with one does.
 */
function declareOpenLevers(): void {
    const paths = Object.keys(OPEN_LEVERS);

    for (let i = 0; i < paths.length; i++) {
        recordOpen(paths[i], OPEN_LEVERS[paths[i]]);
    }
}

function recordOpen(path: string, because: string): void {
    openReasons[path] = because;

    if (openLevers.indexOf(path) < 0) {
        openLevers.push(path);
    }
}

const openReasons: Record<string, string> = {};

/** What was frozen and what would not freeze, so the limits of this are inspectable. */
export function stateGuardReport(): {
    frozen: string[];
    unfrozen: string[];
    open: { path: string; because: string }[];
} {
    return {
        frozen: frozenLevers.slice(0),
        unfrozen: unfrozenLevers.slice(0),
        open: openLevers.map(function (path) {
            return { path: path, because: openReasons[path] };
        })
    };
}

/**
 * The same report, small enough to serve on an endpoint that is polled: the two lists are
 * short and the frozen levers are a count rather than a hundred paths.
 *
 * Three states, not two, because two could not tell the truth. `unfrozen` has only ever
 * meant "we tried and the slot refused" - it never meant "we never looked" - so a lever
 * nobody had listed sat in neither list and `ok` stayed true over it. That is how
 * `{"ok":true,"frozen":56,"unfrozen":[]}` was served by a build on which a script could
 * set every guest's happiness to 255, buy land by assigning `ownership`, repair rides with
 * no mechanic and turn off nine of thirteen scenario rules.
 *
 * So: `frozen` is what is shut, `unfrozen` is what would not shut, and `open` names what
 * this build knows it is leaving open on purpose. `ok` is false for any of the three
 * failures - nothing froze at all, something refused to freeze, or something reachable is
 * deliberately unfrozen - because each of them means a write is available that the count
 * on its own would read as covered.
 */
export function stateGuardSummary(): { ok: boolean; frozen: number; unfrozen: string[]; open: string[] } {
    return {
        ok: frozenLevers.length > 0 && unfrozenLevers.length === 0 && openLevers.length === 0,
        frozen: frozenLevers.length,
        unfrozen: unfrozenLevers.slice(0),
        open: openLevers.slice(0)
    };
}

/**
 * Said once, to the game console and the OpenRCT2 log. A lever this build would not let
 * us freeze is something to know before a run rather than after one, and nobody reads a
 * value that is only returned from a function nothing calls.
 */
function reportUnguarded(): void {
    if (unguardedReported || typeof console === "undefined") {
        return;
    }

    if (unfrozenLevers.length > 0) {
        unguardedReported = true;
        console.log("freeplay: these levers would not freeze in this build and are watched only: "
            + unfrozenLevers.join(", "));
    }

    if (openLevers.length > 0) {
        unguardedReported = true;
        console.log("freeplay: these levers are writable on purpose and are not guarded: "
            + openLevers.join(", "));
    }
}

/**
 * Replace a readable member with the same read and a setter that refuses.
 *
 * Installed on whichever object in the prototype chain declares the member, exactly as
 * the action guards are, and non-configurable so `delete` and a second defineProperty
 * both fail. A setter that throws rather than `writable: false`: evaluated code is
 * non-strict, where a write to a read-only property is a silent no-op, and silence is
 * the one outcome this is trying to avoid.
 */
function freezeValue(root: object, label: string, key: string, because: string): GuardOutcome {
    const owner = findPropertyOwner(root, key);

    if (owner === null) {
        return "absent";
    }

    const descriptor = Object.getOwnPropertyDescriptor(owner, key);

    if (!descriptor) {
        return "absent";
    }

    if (isStateGuarded(descriptor.set)) {
        return "frozen";
    }

    const message = label + "." + key + " cannot be assigned. " + because + " " + EARNED_INSTEAD;
    // A data property here is already a snapshot rather than a live view of the game's
    // own state - the game writes its C++ side, not this - so serving the captured value
    // back changes nothing about what the API reports.
    const captured = descriptor.value as unknown;
    const read = typeof descriptor.get === "function"
        ? descriptor.get
        : function (): unknown { return captured; };

    try {
        Object.defineProperty(owner, key, {
            get: read,
            set: markStateGuard(function (): never { throw new Error(message); }),
            enumerable: descriptor.enumerable === true,
            configurable: false
        });
    } catch (_defineError) {
        return "refused";
    }

    return "frozen";
}

function recordUnguardable(label: string, levers: Record<string, string>): void {
    const keys = Object.keys(levers);

    for (let i = 0; i < keys.length; i++) {
        recordLever(label + "." + keys[i], "refused");
    }
}

function freezeValues(root: object, label: string, levers: Record<string, string>): void {
    const keys = Object.keys(levers);

    for (let i = 0; i < keys.length; i++) {
        recordLever(label + "." + keys[i], freezeValue(root, label, keys[i], levers[keys[i]]));
    }
}

/**
 * Every member the object or its prototypes declare with a setter, and every writable data
 * member that is not a function. Own properties too, because a test double and a plain
 * object both put them there; `Object.prototype` and `Array.prototype` are where the walk
 * stops, the same place `collectKeys` stops.
 */
function writableKeys(root: object): string[] {
    const keys: string[] = [];
    const seen: Record<string, boolean> = {};
    let current: object | null = root;

    while (current !== null && current !== Object.prototype && current !== Array.prototype) {
        const owner = current;

        Object.getOwnPropertyNames(owner).forEach(function (key) {
            if (key === "constructor" || seen[key] === true) {
                return;
            }

            const descriptor = Object.getOwnPropertyDescriptor(owner, key);

            if (!descriptor) {
                return;
            }

            const isSettableAccessor = typeof descriptor.set === "function";
            const isWritableValue = descriptor.writable === true && typeof descriptor.value !== "function";

            if (isSettableAccessor || isWritableValue) {
                seen[key] = true;
                keys.push(key);
            }
        });

        current = Object.getPrototypeOf(owner) as object | null;
    }

    return keys;
}

/**
 * Freeze every writable member of a surface, rather than the ones somebody remembered.
 *
 * The deny-list shape is what let all of this through: `RIDE_LEVERS` named nine of a
 * prototype's thirty setters, `RULE_FLAGS` named four of thirteen flags, and nothing at
 * all named the guest, staff and tile-element prototypes. A surface where the model has no
 * legitimate write is default-deny, `reasons` carries the good explanation for the members
 * that have one, and `allow` is the short list of writes that really are play - each of
 * which is reported by name in the guard summary rather than left in a comment.
 */
function freezeAllWritable(
    root: object,
    label: string,
    reasons: Record<string, string>,
    fallback: string,
    allow: Record<string, boolean>
): void {
    const keys = writableKeys(root);

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];

        // Left writable on purpose, and already named in OPEN_LEVERS, which is declared
        // whether or not this surface turned up in the park.
        if (allow[key] === true) {
            continue;
        }

        const because = typeof reasons[key] === "string" ? reasons[key] : fallback;

        recordLever(label + "." + key, freezeValue(root, label, key, because));
    }
}

function freezeMethods(root: object, label: string, levers: Record<string, string>): void {
    const keys = Object.keys(levers);

    for (let i = 0; i < keys.length; i++) {
        recordLever(label + "." + keys[i] + "()", freezeMethod(root, label, keys[i], levers[keys[i]]));
    }
}

/** Replace a method outright: freezing the slot would still leave it callable. */
function freezeMethod(root: object, label: string, key: string, because: string): GuardOutcome {
    const message = label + "." + key + "() cannot be called. " + because + " " + EARNED_INSTEAD;

    return replaceMethod(root, key, function (_original) {
        return function (): never { throw new Error(message); };
    });
}

/** Replace a method with one that keeps the original in a closure nothing can reach. */
function replaceMethod(root: object, key: string, wrap: (original: GuardedMethod) => GuardedMethod): GuardOutcome {
    const owner = findPropertyOwner(root, key);

    if (owner === null) {
        return "absent";
    }

    const original = (owner as Record<string, unknown>)[key];

    if (isOurStateGuard(original)) {
        return "frozen";
    }

    if (typeof original !== "function") {
        return "absent";
    }

    return replaceProperty(owner, key, markStateGuard(wrap(original as GuardedMethod))) ? "frozen" : "refused";
}

/**
 * Wrap a member so it refuses for the duration of an evaluated script and behaves exactly
 * as before outside one.
 *
 * Deliberately `writable: true`: src/mcp.ts swaps `context.setTimeout` for a wrapper of
 * its own while deferred tool calls are in flight, and build_flat_ride chains about five
 * continuations deep behind it. A locked slot would break that path, which is worse than
 * the hole this closes. `configurable: false` still stops a script deleting it, and the
 * original is only ever reachable from inside this closure, so replacing the slot buys a
 * script nothing. If something else does replace it, the next `evaluate` puts it back.
 *
 * `isOurStateGuard`, not `isStateGuarded`: this wrapper is the one that reads
 * `insideEvaluate`, and a wrapper left behind by an earlier load of the plugin reads that
 * load's flag, which no `evaluate` running now will ever set. Accepting one as already
 * guarded is what made `setTimeout`, `setInterval` and `subscribe` run freely inside an
 * evaluated script while the report said all three were frozen.
 */
function guardWhileEvaluating(root: object, label: string, key: string, because: string): GuardOutcome {
    const owner = findPropertyOwner(root, key);

    if (owner === null) {
        return "absent";
    }

    const original = (owner as Record<string, unknown>)[key];

    if (isOurStateGuard(original)) {
        return "frozen";
    }

    if (typeof original !== "function") {
        return "absent";
    }

    const message = label + "." + key + "() cannot be called from an evaluated script. "
        + because + " " + EARNED_INSTEAD;
    const wrapper = markStateGuard(function (this: unknown, ...args: unknown[]): unknown {
        if (insideEvaluate) {
            throw new Error(message);
        }

        return (original as GuardedMethod).apply(this, args);
    });

    try {
        Object.defineProperty(owner, key, {
            value: wrapper, writable: true, configurable: false, enumerable: false
        });
    } catch (_defineError) {
        return "refused";
    }

    return (owner as Record<string, unknown>)[key] === wrapper ? "frozen" : "refused";
}

/**
 * The same read, and a setter that refuses only while an evaluated script is on the stack.
 *
 * For the one member the plugin itself writes: `open_park` falls back to
 * `park.entranceFee = ...` when the parksetentrancefee action does not take, which is the
 * route every hand-written run used and is known to work. A setter that always threw would
 * break that tool; a setter that never threw leaves a script setting admission past the
 * action's own eligibility check, which is what it was doing.
 *
 * `isOurStateGuard`, not `isStateGuarded`, for the same reason `guardWhileEvaluating` uses
 * it: a wrapper left behind by an earlier load of the plugin reads that load's
 * `insideEvaluate`, which no script running now will ever set, so it is an open slot and
 * has to be reported as one rather than counted as frozen.
 */
function freezeValueWhileEvaluating(
    root: object,
    label: string,
    key: string,
    because: string,
    copyOnRead?: boolean
): GuardOutcome {
    const owner = findPropertyOwner(root, key);

    if (owner === null) {
        return "absent";
    }

    const descriptor = Object.getOwnPropertyDescriptor(owner, key);

    if (!descriptor) {
        return "absent";
    }

    if (isOurStateGuard(descriptor.set)) {
        return "frozen";
    }

    const message = label + "." + key + " cannot be assigned from an evaluated script. "
        + because + " " + EARNED_INSTEAD;
    let captured = descriptor.value as unknown;
    const stored = typeof descriptor.get === "function"
        ? descriptor.get
        : function (): unknown { return captured; };
    const write = typeof descriptor.set === "function"
        ? descriptor.set
        : function (value: unknown): void { captured = value; };
    const read = copyOnRead === true
        ? function (this: unknown): unknown {
            const value = stored.call(this) as { slice?: () => unknown } | null;

            if (value && typeof value === "object" && typeof value.slice === "function") {
                return (value.slice as () => unknown).call(value);
            }

            return value;
        }
        : stored;

    try {
        Object.defineProperty(owner, key, {
            get: markStateGuard(read),
            set: markStateGuard(function (this: unknown, value: unknown): void {
                if (insideEvaluate) {
                    throw new Error(message);
                }

                write.call(this, value);
            }),
            enumerable: descriptor.enumerable === true,
            configurable: false
        });
    } catch (_defineError) {
        return "refused";
    }

    return "frozen";
}

/**
 * Hand back a copy of a buffer-valued member, so writing into what was read changes
 * nothing.
 *
 * `Tile.data` is the raw bytes of a map tile. Freezing the slot stops `tile.data = ...`
 * and nothing else: the game hands back a view, and `tile.data[0] = 9` writes through it
 * past every guard in this file and past the construction actions with it. A property
 * cannot intercept an index write, so the fix is at the other end - what the getter
 * returns is a copy, and the copy is what gets written into. Reading is unaffected, which
 * is all anything here does with it.
 */
function freezeBufferWhileEvaluating(root: object, label: string, key: string, because: string): GuardOutcome {
    return freezeValueWhileEvaluating(root, label, key, because, true);
}

/** The accessor this load put over a whole namespace, so a stranger in the slot is evicted. */
interface NamespaceGuard {
    name: string;
    owner: object;
    enumerable: boolean;
    get: () => unknown;
    set: (value: unknown) => void;
}

/** The real namespace object, by name, held where an evaluated script cannot reach it. */
const capturedNamespaces: Record<string, unknown> = {};
const ownNamespaceGuards: Record<string, NamespaceGuard | undefined> = {};

/**
 * Put the accessor in the slot. `configurable: true` for the same reason the timer slots are
 * `writable: true`: OpenRCT2 keeps one global object across hot reloads, and a slot the next
 * load cannot take back is a guard that reads a previous load's `insideEvaluate` - dead, and
 * reported as healthy. A script can therefore delete or redefine the slot, and gains nothing
 * by it: the namespace itself only exists inside this closure, so all a script can do is take
 * `ui` away from the plugin, which `restoreNamespaceGuards` puts back the moment it returns.
 */
function defineNamespaceGuard(guard: NamespaceGuard): boolean {
    try {
        Object.defineProperty(guard.owner, guard.name, {
            get: guard.get, set: guard.set, enumerable: guard.enumerable, configurable: true
        });
    } catch (_defineError) {
        return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(guard.owner, guard.name);

    return typeof descriptor !== "undefined" && descriptor.get === guard.get;
}

/**
 * Whether the namespace is there at all, asked of the binding rather than of the global
 * object: a headless build has no `ui`, and a build that keeps one somewhere this cannot
 * reach still has one. A guard that refuses the read is an answer too - something is there.
 */
function namespaceExists(check: () => boolean): boolean {
    try {
        return check();
    } catch (_error) {
        return true;
    }
}

/**
 * Refuse a whole global namespace for the duration of an evaluated script.
 *
 * A member-by-member guard can only refuse the members somebody listed, and `ui` is thirteen
 * methods deep in callbacks with more arriving every plugin API version. So the script never
 * gets the object at all: the read itself throws while a script is on the stack, and hands
 * back the real namespace the rest of the time, so the plugin's own `ui.showError` - a typed
 * tool, outside any script - does not notice this is here.
 *
 * The setter is what keeps that true through a swap: assigning `ui` outside a script moves
 * what the getter hands back, the way an ordinary writable global would, so a build that
 * replaces the namespace is followed rather than shadowed.
 */
function guardNamespaceWhileEvaluating(name: string, present: boolean, because: string): GuardOutcome {
    if (typeof globalThis === "undefined" || !globalThis) {
        // No global object to install on, which is a hole rather than an absence whenever
        // the namespace itself is there. Checked rather than assumed because this runs in
        // the game's own engine, and an exception here would take every other guard with it.
        return present ? "refused" : "absent";
    }

    const scope = globalThis as unknown as Record<string, unknown>;
    const owner = findPropertyOwner(scope as unknown as object, name);
    const descriptor = owner === null ? undefined : Object.getOwnPropertyDescriptor(owner, name);

    if (descriptor && isOurStateGuard(descriptor.get)) {
        return "frozen";
    }

    const own = ownNamespaceGuards[name];
    let current: unknown;

    try {
        // Through a previous load's getter if that is what is in the slot: its own
        // `insideEvaluate` is false out here, so it hands over the real namespace.
        current = owner === null ? undefined : (owner as Record<string, unknown>)[name];
    } catch (_readError) {
        current = undefined;
    }

    if (typeof current !== "undefined" && current !== null) {
        capturedNamespaces[name] = current;
    } else if (typeof own === "undefined") {
        // A headless build has no `ui` at all: nothing to guard, and nothing to report. A
        // namespace that exists somewhere this could not find is the other case, and has to
        // be named on the endpoint rather than quietly counted as covered.
        return present ? "refused" : "absent";
    }

    const message = name + " cannot be reached from an evaluated script. " + because + " " + EARNED_INSTEAD;
    const guard: NamespaceGuard = own || {
        name: name,
        owner: owner === null ? (scope as unknown as object) : owner,
        enumerable: descriptor ? descriptor.enumerable === true : true,
        get: markStateGuard(function (): unknown {
            if (insideEvaluate) {
                throw new Error(message);
            }

            return capturedNamespaces[name];
        }),
        set: markStateGuard(function (value: unknown): void {
            if (insideEvaluate) {
                throw new Error(message);
            }

            capturedNamespaces[name] = value;
        })
    };

    if (!defineNamespaceGuard(guard)) {
        return "refused";
    }

    ownNamespaceGuards[name] = guard;

    return "frozen";
}

/**
 * Put back a namespace a script emptied or redefined, before anything else looks at it.
 *
 * Deliberately without re-reading the slot: `delete ui` followed by `ui = { showError: ... }`
 * is two lines, and re-capturing what it left would have the plugin's own error dialog call
 * the script's function on a later tick - the same deferred hole from the far end. Installing
 * does re-read, because by then this has already run and only a legitimate swap can be there.
 */
function restoreNamespaceGuards(): void {
    const names = Object.keys(ownNamespaceGuards);

    for (let i = 0; i < names.length; i++) {
        const guard = ownNamespaceGuards[names[i]];

        if (typeof guard === "undefined") {
            continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(guard.owner, guard.name);

        if (descriptor && descriptor.get === guard.get) {
            continue;
        }

        recordLever(guard.name, defineNamespaceGuard(guard) ? "frozen" : "refused");
    }
}

/**
 * A guard on the prototype is shadowed by an own property on the instance, which would
 * not make the park richer but would make the check below read the script's number
 * instead of the game's. `park`, `scenario` and `cheats` are singletons, so sealing them
 * against new members costs nothing and closes that.
 */
function refuseNewMembers(target: object): void {
    try {
        Object.preventExtensions(target);
    } catch (_error) {
        // A build that will not seal its own globals still has the guards above.
    }
}

/** The game hands out fresh wrappers for some members, so guard the shared prototype. */
function sharedRoot(instance: object): object {
    const prototype = Object.getPrototypeOf(instance) as object | null;

    return prototype === null || prototype === Object.prototype ? instance : prototype;
}

/**
 * The prototype every `Ride` shares, found through one that exists. There is no other way
 * in: rides are handed out fresh per call, so guarding an instance would guard nothing.
 * Until a ride exists there is nothing to find, which is why this is retried per call.
 */
function ridePrototype(): object | null {
    if (typeof map === "undefined" || !map) {
        return null;
    }

    const rides = map.rides;

    if (!rides || rides.length === 0) {
        return null;
    }

    return instancePrototype(rides[0] as unknown as object);
}

/**
 * The prototype an instance shares with every other of its kind, or null when it has none.
 *
 * Null rather than the instance: the game hands out a fresh wrapper per call for rides,
 * entities and tile elements alike, so guarding one instance guards an object that is
 * thrown away before the next line of the script. A surface that resolves to null is not
 * silently skipped - `installGroup` records the levers it would have frozen as open.
 */
function instancePrototype(instance: object | null | undefined): object | null {
    if (!instance || typeof instance !== "object") {
        return null;
    }

    const prototype = Object.getPrototypeOf(instance) as object | null;

    return prototype === null || prototype === Object.prototype ? null : prototype;
}

/** How many entities of one kind are in the park, and 0 for a build that cannot answer. */
function entityCount(type: string): number {
    if (typeof map === "undefined" || !map || typeof map.getAllEntities !== "function") {
        return 0;
    }

    try {
        const entities = map.getAllEntities(type as EntityType);

        return entities && typeof entities.length === "number" ? entities.length : 0;
    } catch (_error) {
        // A build that does not know this entity kind has none of them.
        return 0;
    }
}

/** The prototype every entity of one kind shares, found through one that is in the park. */
function entityPrototype(type: string): object | null {
    if (entityCount(type) === 0) {
        return null;
    }

    const entities = map.getAllEntities(type as EntityType);

    return instancePrototype(entities[0] as unknown as object);
}

/** The base every entity shares, reached through whichever kind this park happens to have. */
function entityBasePrototype(): object | null {
    for (let i = 0; i < ENTITY_KINDS.length; i++) {
        const prototype = entityPrototype(ENTITY_KINDS[i]);

        if (prototype !== null) {
            return prototype;
        }
    }

    return null;
}

/** A tile of the map, for the two prototypes hanging off it. There is always a tile 0,0. */
function firstTile(): object | null {
    if (typeof map === "undefined" || !map || typeof map.getTile !== "function") {
        return null;
    }

    const tile = map.getTile(0, 0) as unknown as object | null;

    return tile && typeof tile === "object" ? tile : null;
}

function tilePrototype(): object | null {
    return instancePrototype(firstTile());
}

/**
 * The prototype every tile element shares. OpenRCT2 declares every element type's members
 * on one class, so `ownership`, `isQueue`, `trackType` and the rest all land here in a
 * single install and every element of every type on every tile is covered.
 */
function tileElementPrototype(): object | null {
    const tile = firstTile() as { elements?: object[]; getElement?: (index: number) => object } | null;

    if (!tile) {
        return null;
    }

    const element = tile.elements && tile.elements.length > 0
        ? tile.elements[0]
        : (typeof tile.getElement === "function" ? tile.getElement(0) : null);

    return instancePrototype(element);
}

/**
 * A surface whose members live on a prototype, guarded only when there is one to guard.
 *
 * Three outcomes, and the middle one is the whole reason this exists. Nothing of that kind
 * in the park - no rides yet, no guests yet - records nothing, truthfully: there is no
 * instance for a script to write to either, and the guards are reinstalled before every
 * script, so the first guest to arrive is covered before any script can reach it. Instances
 * that exist but share no prototype are recorded as open by name, because guarding one
 * handed-out wrapper guards an object that is discarded before the next line runs. Only the
 * third case, a real shared prototype, installs.
 */
function installPrototypeGroup(
    label: string,
    resolve: () => object | null,
    exists: () => boolean,
    install: (target: object) => void
): void {
    let target: object | null = null;

    try {
        target = resolve();
    } catch (_error) {
        target = null;
    }

    if (target === null) {
        let present = false;

        try {
            present = exists();
        } catch (_error) {
            present = false;
        }

        if (present) {
            recordLever(label, "refused");
        }

        return;
    }

    installGroup(function () { return target; }, install);
}

function installGroup(resolve: () => object | null, install: (target: object) => void): void {
    let target: object | null = null;

    try {
        target = resolve();
    } catch (_error) {
        target = null;
    }

    if (target === null) {
        return;
    }

    for (let i = 0; i < guardedTargets.length; i++) {
        if (guardedTargets[i] === target) {
            return;
        }
    }

    guardedTargets.push(target);

    try {
        install(target);
    } catch (_error) {
        // A build that is missing one of these must not take `evaluate` down with it.
    }
}

/**
 * Freeze the members of the plugin API that hand the park a result it has not earned.
 *
 * This is not airtight against arbitrary JavaScript and is not trying to be: it closes
 * the direct route - assignment and the cheat entry points - and the invariant check in
 * `runScript` makes whatever is left loud rather than silent.
 */
export function installStateGuards(): void {
    // The action guards are part of the same freeze and are re-entrant in the same way, so
    // they go in wherever this does: at startup from createApplication, and again before
    // every script. Calling them from here rather than only from `runScript` is what puts
    // `context.executeAction` in the report the `/v1` endpoint serves.
    installActionGuards();

    declareOpenLevers();

    installGroup(function () {
        return typeof park === "undefined" || !park ? null : park as unknown as object;
    }, function (target) {
        freezeValues(target, "park", PARK_LEVERS);
        // The one park member the plugin itself writes, so it refuses a script and lets
        // open_park's own fallback through. Assigning it set admission past the eligibility
        // check parksetentrancefee makes - a scenario with free entry among them.
        recordLever("park.entranceFee", freezeValueWhileEvaluating(target, "park", "entranceFee",
            "Admission is set by the parksetentrancefee action - open_park - which refuses a fee"
            + " this scenario does not allow the park to charge."));
        recordLever("park.generateGuest", freezeMethod(target, "park", "generateGuest", GUESTS_ARRIVE));
        recordLever("park.grantAward", freezeMethod(target, "park", "grantAward", AWARDS_ARE_GIVEN));
        recordLever("park.clearAwards", freezeMethod(target, "park", "clearAwards", AWARDS_ARE_GIVEN));
        recordLever("park.setFlag", replaceMethod(target, "setFlag", function (original) {
            return function (this: unknown, flag: unknown, value: unknown): unknown {
                const name = String(flag);

                if (PLAYABLE_FLAGS[name] !== true) {
                    const why = typeof FLAG_LEVERS[name] === "string" ? FLAG_LEVERS[name] : UNLISTED_FLAG;

                    throw new Error("park.setFlag(\"" + name + "\", ...) cannot be called. "
                        + why + " " + EARNED_INSTEAD);
                }

                return original.call(this, flag, value);
            };
        }));
        refuseNewMembers(target);
    });

    installGroup(function () {
        return typeof scenario === "undefined" || !scenario ? null : scenario as unknown as object;
    }, function (target) {
        freezeValues(target, "scenario", SCENARIO_LEVERS);
        refuseNewMembers(target);
    });

    installGroup(function () {
        if (typeof scenario === "undefined" || !scenario) {
            return null;
        }

        const objective = scenario.objective as unknown as object | null;

        if (!objective || typeof objective !== "object") {
            return null;
        }

        const root = sharedRoot(objective);

        // A plain object handed out fresh on every read has nothing durable to guard, and
        // an assignment to one is thrown away by the game anyway. Say so rather than
        // claim cover: the check further down still watches these four numbers.
        if (root === objective && (scenario.objective as unknown as object) !== objective) {
            recordUnguardable("scenario.objective", OBJECTIVE_LEVERS);
            return null;
        }

        return root;
    }, function (target) {
        freezeValues(target, "scenario.objective", OBJECTIVE_LEVERS);
    });

    installGroup(function () {
        return typeof cheats === "undefined" || !cheats ? null : cheats as unknown as object;
    }, function (target) {
        const names = apiKeys(target);

        for (let i = 0; i < names.length; i++) {
            if (typeof (target as Record<string, unknown>)[names[i]] !== "function") {
                recordLever("cheats." + names[i], freezeValue(target, "cheats", names[i], CHEATS_ARE_OFF));
            }
        }

        refuseNewMembers(target);
    });

    // The one group behind a flag rather than an identity check: finding the prototype
    // costs a `map.rides` read, and unlike `park` it is the same object for the process.
    if (!rideGuardInstalled) {
        installPrototypeGroup("ride", ridePrototype, function () {
            return typeof map !== "undefined" && !!map && !!map.rides && map.rides.length > 0;
        }, function (target) {
            freezeAllWritable(target, "ride", RIDE_LEVERS, RIDE_IS_BUILT, RIDE_OPEN);
            freezeMethods(target, "ride", RIDE_METHOD_LEVERS);
            rideGuardInstalled = true;
        });
    }

    // Guests, staff and everything else that moves. Nothing here was guarded at all, and a
    // script could set every guest's happiness, nausea, hunger and cash outright - the park
    // rating is worked out from exactly those, and guest cash becomes park cash as it is
    // spent. Retried until each prototype resolves, because an empty park has none of them
    // and a guest that arrives later has to be covered before the next script runs.
    if (!guestGuardInstalled) {
        installPrototypeGroup("guest", function () { return entityPrototype("guest"); }, function () {
            return entityCount("guest") > 0;
        }, function (target) {
            freezeAllWritable(target, "guest", GUEST_LEVERS, GUESTS_FEEL_WHAT_THE_PARK_IS, {});
            freezeMethods(target, "guest", PEEP_METHOD_LEVERS);
            guestGuardInstalled = true;
        });
    }

    if (!staffGuardInstalled) {
        installPrototypeGroup("staff", function () { return entityPrototype("staff"); }, function () {
            return entityCount("staff") > 0;
        }, function (target) {
            freezeAllWritable(target, "staff", GUEST_LEVERS, STAFF_ARE_HIRED, STAFF_OPEN);
            freezeMethods(target, "staff", PEEP_METHOD_LEVERS);
            staffGuardInstalled = true;
        });
    }

    // The base every entity shares, reached through whichever kind is in the park. `remove`
    // is the reason: litter and vandalism are cleared by handymen the park pays for, and
    // the park rating counts what is lying about.
    if (!entityGuardInstalled) {
        installPrototypeGroup("entity", entityBasePrototype, function () {
            return entityCount("litter") > 0 || entityCount("guest") > 0 || entityCount("staff") > 0;
        }, function (target) {
            freezeAllWritable(target, "entity", GUEST_LEVERS, PEEP_IS_THE_GAMES, {});
            freezeMethods(target, "entity", ENTITY_METHOD_LEVERS);
            entityGuardInstalled = true;
        });
    }

    // The map itself. `elements[0].ownership = 160` bought a tile outright - park ownership
    // plus construction rights, no cash, no landbuyrights action - and park value follows
    // owned land. Frozen whole rather than member by member; see MAP_IS_BUILT.
    if (!tileElementGuardInstalled) {
        installPrototypeGroup("map.element", tileElementPrototype, function () {
            return firstTile() !== null;
        }, function (target) {
            freezeAllWritable(target, "map.element", {}, MAP_IS_BUILT, {});
            tileElementGuardInstalled = true;
        });
    }

    if (!tileGuardInstalled) {
        installPrototypeGroup("map.tile", tilePrototype, function () {
            return firstTile() !== null;
        }, function (target) {
            // Not freezeAllWritable: `data` is a byte view and needs the copy-on-read guard,
            // which a plain freeze would not give it.
            recordLever("map.tile.data", freezeBufferWhileEvaluating(target, "map.tile", "data", TILE_IS_THE_MAP));
            freezeAllWritable(target, "map.tile", {}, TILE_IS_THE_MAP, {});
            freezeMethods(target, "map.tile", TILE_METHOD_LEVERS);
            tileGuardInstalled = true;
        });
    }

    // Re-checked on every call rather than remembered like the rest: src/mcp.ts assigns
    // over `context.setTimeout` and assigns it back when its deferred calls finish, which
    // can drop this wrapper. Each member costs one property read to confirm.
    if (typeof context !== "undefined" && context) {
        const entry = context as unknown as object;

        recordLever("context.setTimeout", guardWhileEvaluating(entry, "context", "setTimeout", SCHEDULED_FOR_LATER));
        recordLever("context.setInterval", guardWhileEvaluating(entry, "context", "setInterval", SCHEDULED_FOR_LATER));
        recordLever("context.clearTimeout", guardWhileEvaluating(entry, "context", "clearTimeout", TIMERS_BELONG_TO_TOOLS));
        recordLever("context.clearInterval", guardWhileEvaluating(entry, "context", "clearInterval", TIMERS_BELONG_TO_TOOLS));
        recordLever("context.subscribe", guardWhileEvaluating(entry, "context", "subscribe", HOOKS_FIRE_LATER));
    }

    // The last route a script had to a callback the game would run later. Re-checked on
    // every call like the timers above, because a script can empty the slot and a later
    // load of the plugin has to be able to take it back off this one.
    recordLever("ui", guardNamespaceWhileEvaluating("ui", namespaceExists(function () {
        return typeof ui !== "undefined";
    }), NOBODY_IS_LOOKING));

    reportUnguarded();

    installGroup(function () {
        return typeof map === "undefined" || !map ? null : map as unknown as object;
    }, function (target) {
        recordLever("map.createEntity", replaceMethod(target, "createEntity", function (original) {
            return function (this: unknown, type: unknown, initializer: unknown): unknown {
                const kind = String(type);

                if (kind === "guest" || kind === "peep") {
                    throw new Error("map.createEntity(\"" + kind + "\", ...) cannot be called. "
                        + GUESTS_ARRIVE + " " + EARNED_INSTEAD);
                }

                return original.call(this, type, initializer);
            };
        }));
    });
}


/**
 * ---------------------------------------------------------------------------
 * The half that survives a route neither of us thought of.
 *
 * A handful of scalars are read either side of the script and compared. Nothing here
 * walks the map: that has frozen the game once already, and a freeze has no error to
 * report. The comparison is meaningful because a script runs to completion inside one
 * game tick, so none of these values drifts on its own while it runs.
 * ---------------------------------------------------------------------------
 */

/** What a change is put down to. `*` means any executed action accounts for it. */
interface InvariantSpec {
    path: string;
    source: "park" | "scenario" | "objective";
    key: string;
    movedBy: string[];
}

/**
 * Cash and the two values derived from it move when any action is executed, because
 * nearly every action costs money. The rest do not move inside a tick at all: the game
 * recalculates rating, guest count and company value on its own schedule, and the two
 * actions that could set them outright - cheatset and scenariosetsetting - are refused
 * above. So a change in one of those during a script is, by construction, not the game.
 *
 * What this cannot reach, which is the more useful half. It watches thirteen scalars and
 * nothing else, so a whole surface left unguarded is invisible to it: guest happiness went
 * to 255 on every guest in the park and `park.rating` read back identical either side,
 * because the game recalculates the rating every 512 ticks and both readings are taken
 * inside one tick. A tile's `ownership` is the same - park value follows owned land, but
 * not within the tick that bought it. So this is a backstop for a lever that would not
 * freeze, not a net under the whole API, and `unfrozen` being non-empty is the condition
 * under which it can fire. The answer to a surface nobody guarded is to guard it, which is
 * what the entity, tile and element groups above now do; the answer to a surface nobody
 * has thought of is `stateGuardSummary()`, which now has a place to say so.
 *
 * Deliberately per-script, not across scripts: the game runs thousands of ticks between
 * tool calls, during which guests pay, wages go out and rides earn, so comparing the end of
 * one script with the start of the next would report ordinary play every single time.
 */
const INVARIANTS: InvariantSpec[] = [
    { path: "park.cash", source: "park", key: "cash", movedBy: ["*"] },
    { path: "park.value", source: "park", key: "value", movedBy: ["*"] },
    { path: "park.companyValue", source: "park", key: "companyValue", movedBy: ["*"] },
    { path: "park.bankLoan", source: "park", key: "bankLoan", movedBy: ["parksetloan"] },
    { path: "park.rating", source: "park", key: "rating", movedBy: [] },
    { path: "park.guests", source: "park", key: "guests", movedBy: [] },
    { path: "park.totalAdmissions", source: "park", key: "totalAdmissions", movedBy: [] },
    { path: "scenario.status", source: "scenario", key: "status", movedBy: ["loadorquit"] },
    { path: "scenario.completedCompanyValue", source: "scenario", key: "completedCompanyValue", movedBy: ["loadorquit"] },
    { path: "scenario.objective.type", source: "objective", key: "type", movedBy: [] },
    { path: "scenario.objective.guests", source: "objective", key: "guests", movedBy: [] },
    { path: "scenario.objective.year", source: "objective", key: "year", movedBy: [] },
    { path: "scenario.objective.parkValue", source: "objective", key: "parkValue", movedBy: [] }
];

const UNREADABLE = "<unreadable>";

/** Longest list of distinct action names a single script's report will name. */
const MAX_LOGGED_ACTIONS = 12;

interface ActionLog {
    count: number;
    names: string[];
    byName: Record<string, boolean>;
}

interface WorldRefs {
    park: Record<string, unknown> | null;
    scenario: Record<string, unknown> | null;
}

let executedActions: ActionLog = { count: 0, names: [], byName: {} };

function resetActionLog(): void {
    executedActions = { count: 0, names: [], byName: {} };
}

function recordExecutedAction(name: unknown): void {
    if (typeof name !== "string") {
        return;
    }

    const key = name.toLowerCase();
    executedActions.count += 1;

    if (executedActions.byName[key] !== true) {
        executedActions.byName[key] = true;

        if (executedActions.names.length < MAX_LOGGED_ACTIONS) {
            executedActions.names.push(key);
        }
    }
}

/**
 * Held rather than re-read: a script that reassigns the `park` global would otherwise
 * have the second reading taken from an object of its own making.
 */
function captureWorld(): WorldRefs {
    return {
        park: typeof park === "undefined" || !park ? null : park as unknown as Record<string, unknown>,
        scenario: typeof scenario === "undefined" || !scenario ? null : scenario as unknown as Record<string, unknown>
    };
}

function readInvariants(world: WorldRefs): Record<string, unknown> {
    const reading: Record<string, unknown> = {};
    let objective: Record<string, unknown> | null = null;

    try {
        objective = world.scenario === null
            ? null
            : (world.scenario.objective as Record<string, unknown> | undefined) || null;
    } catch (_error) {
        objective = null;
    }

    for (let i = 0; i < INVARIANTS.length; i++) {
        const spec = INVARIANTS[i];
        const source = spec.source === "objective"
            ? objective
            : spec.source === "park" ? world.park : world.scenario;

        if (source === null) {
            continue;
        }

        try {
            const value = source[spec.key];
            const type = typeof value;

            if (type === "number" || type === "string" || type === "boolean") {
                reading[spec.path] = value;
            }
        } catch (_error) {
            reading[spec.path] = UNREADABLE;
        }
    }

    return reading;
}

function has(reading: Record<string, unknown>, path: string): boolean {
    return Object.prototype.hasOwnProperty.call(reading, path);
}

function isAccountedFor(spec: InvariantSpec, executed: ActionLog): boolean {
    for (let i = 0; i < spec.movedBy.length; i++) {
        if (spec.movedBy[i] === "*") {
            if (executed.count > 0) {
                return true;
            }

            continue;
        }

        if (executed.byName[spec.movedBy[i]] === true) {
            return true;
        }
    }

    return false;
}

function unaccountedChanges(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    executed: ActionLog
): StateChange[] {
    const changes: StateChange[] = [];

    for (let i = 0; i < INVARIANTS.length; i++) {
        const spec = INVARIANTS[i];
        const had = has(before, spec.path);
        const now = has(after, spec.path);

        if (!had && !now) {
            continue;
        }

        const was = before[spec.path];
        const is = after[spec.path];

        if (had && now && (was === is || (was !== was && is !== is))) {
            continue;
        }

        if (isAccountedFor(spec, executed)) {
            continue;
        }

        changes.push({ property: spec.path, before: had ? was : null, after: now ? is : null });
    }

    return changes;
}

/** An observation, not a verdict: it says what moved and that nothing accounts for it. */
function observationNote(changes: StateChange[], executed: ActionLog): string {
    const parts: string[] = [];

    for (let i = 0; i < changes.length; i++) {
        parts.push(changes[i].property
            + " " + JSON.stringify(changes[i].before)
            + " -> " + JSON.stringify(changes[i].after));
    }

    return "State changed while this script ran and nothing the script did accounts for it: "
        + parts.join(", ") + ". "
        + (executed.count === 0
            ? "The script executed no game action."
            : "The game action" + (executed.count === 1 ? "" : "s") + " it executed ("
                + executed.names.join(", ") + ") do not move " + (changes.length === 1 ? "that value" : "those values") + ".")
        + " Recorded here because a run's figures are meant to come out of running the park.";
}

function observe<T extends object>(outcome: T, changes: StateChange[], executed: ActionLog): T {
    if (changes.length === 0) {
        return outcome;
    }

    const annotated = outcome as T & { unaccountedChanges: StateChange[]; note: string };

    annotated.unaccountedChanges = changes;
    annotated.note = observationNote(changes, executed);

    return annotated;
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

    // Already installed at startup by createApplication, and re-entrant on purpose: a
    // scenario load swaps `park` and `scenario` for new objects, src/mcp.ts assigns over
    // `context.setTimeout` and back while its deferred calls are in flight, and a hot
    // reload leaves the previous load's wrappers in every slot. None of those would be
    // re-guarded by a one-shot at startup. This also covers the action guards.
    installStateGuards();

    const world = captureWorld();
    const before = readInvariants(world);

    resetActionLog();

    let value: unknown;
    let failure: string | null = null;
    const wasInsideEvaluate = insideEvaluate;

    insideEvaluate = true;

    try {
        value = action(apiKeys);
    } catch (error) {
        failure = describeError(error);
    } finally {
        // Restored even when the script throws: leaving this set would refuse the typed
        // tools their own continuations for the rest of the session.
        insideEvaluate = wasInsideEvaluate;

        // And a namespace the script deleted or swapped goes back now rather than at the
        // next evaluate, so a typed tool in between still finds the game's own `ui`.
        restoreNamespaceGuards();
    }

    const executed = executedActions;
    const changes = unaccountedChanges(before, readInvariants(world), executed);

    if (failure !== null) {
        // Reported on a failure too: a script that moved something and then threw has
        // still moved it, and the throw is not the interesting part.
        return observe({ ok: false, error: failure } as ScriptFailure, changes, executed);
    }

    const sanitized = sanitize(value, 0, [], { nodes: MAX_NODES }, EVALUATE_LIMITS);
    const serialized = JSON.stringify(sanitized);

    if (typeof serialized === "string" && serialized.length > MAX_RESULT_CHARS) {
        return observe({
            ok: true,
            truncated: true,
            result: serialized.substring(0, MAX_RESULT_CHARS) + "... <truncated, narrow the script>"
        } as ScriptSuccess, changes, executed);
    }

    return observe({ ok: true, result: sanitized } as ScriptSuccess, changes, executed);
}
