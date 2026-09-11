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
            refuseCheatAction("queryAction", name);

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
            refuseCheatAction("executeAction", name);
            recordExecutedAction(name);

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
 * later - is covered by one install. `price` is deliberately absent: charging what you
 * like is playing the game, and operate_ride sets it through the ridesetprice action.
 */
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

/**
 * The four park flags that change the rules rather than the park. Everything else
 * `setFlag` can reach is ordinary play - open_park sets "open" on every run - so this is
 * a deny list on purpose: blocking an unlisted flag would break playing for no gain.
 */
const RULE_FLAGS: Record<string, string> = {
    noMoney: "The noMoney flag switches the park's finances off entirely.",
    unlockAllPrices: "The unlockAllPrices flag lifts the scenario's own pricing rule.",
    difficultGuestGeneration: "difficultGuestGeneration is the scenario's own difficulty setting.",
    difficultParkRating: "difficultParkRating is the scenario's own difficulty setting."
};

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
let rideGuardInstalled = false;
/** True only while an evaluated script is on the stack, so a typed tool is never caught. */
let insideEvaluate = false;
let unguardedReported = false;

function markStateGuard<T>(fn: T): T {
    (fn as unknown as Record<string, unknown>)[STATE_GUARD_MARK] = true;
    return fn;
}

function isStateGuarded(value: unknown): boolean {
    return typeof value === "function" && (value as unknown as Record<string, unknown>)[STATE_GUARD_MARK] === true;
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

/** What was frozen and what would not freeze, so the limits of this are inspectable. */
export function stateGuardReport(): { frozen: string[]; unfrozen: string[] } {
    return { frozen: frozenLevers.slice(0), unfrozen: unfrozenLevers.slice(0) };
}

/**
 * The same report, small enough to serve on an endpoint that is polled: the list of
 * refusals is normally empty and the frozen levers are a count rather than forty paths.
 *
 * `ok` is false when nothing froze at all as well as when something refused to. A build
 * whose guards never installed reports an empty `unfrozen` too, and that must not read
 * as clean to whatever is gating a run on this.
 */
export function stateGuardSummary(): { ok: boolean; frozen: number; unfrozen: string[] } {
    return {
        ok: frozenLevers.length > 0 && unfrozenLevers.length === 0,
        frozen: frozenLevers.length,
        unfrozen: unfrozenLevers.slice(0)
    };
}

/**
 * Said once, to the game console and the OpenRCT2 log. A lever this build would not let
 * us freeze is something to know before a run rather than after one, and nobody reads a
 * value that is only returned from a function nothing calls.
 */
function reportUnguarded(): void {
    if (unguardedReported || unfrozenLevers.length === 0 || typeof console === "undefined") {
        return;
    }

    unguardedReported = true;
    console.log("freeplay: these levers would not freeze in this build and are watched only: "
        + unfrozenLevers.join(", "));
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

    if (isStateGuarded(original)) {
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
 */
function guardWhileEvaluating(root: object, label: string, key: string, because: string): GuardOutcome {
    const owner = findPropertyOwner(root, key);

    if (owner === null) {
        return "absent";
    }

    const original = (owner as Record<string, unknown>)[key];

    if (isStateGuarded(original)) {
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

    const prototype = Object.getPrototypeOf(rides[0]) as object | null;

    return prototype === null || prototype === Object.prototype ? null : prototype;
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
    installGroup(function () {
        return typeof park === "undefined" || !park ? null : park as unknown as object;
    }, function (target) {
        freezeValues(target, "park", PARK_LEVERS);
        recordLever("park.generateGuest", freezeMethod(target, "park", "generateGuest", GUESTS_ARRIVE));
        recordLever("park.grantAward", freezeMethod(target, "park", "grantAward", AWARDS_ARE_GIVEN));
        recordLever("park.clearAwards", freezeMethod(target, "park", "clearAwards", AWARDS_ARE_GIVEN));
        recordLever("park.setFlag", replaceMethod(target, "setFlag", function (original) {
            return function (this: unknown, flag: unknown, value: unknown): unknown {
                const why = RULE_FLAGS[String(flag)];

                if (why !== undefined) {
                    throw new Error("park.setFlag(\"" + String(flag) + "\", ...) cannot be called. "
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
        installGroup(ridePrototype, function (target) {
            freezeValues(target, "ride", RIDE_LEVERS);
            rideGuardInstalled = true;
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

    installActionGuards();
    // Already installed at startup by createApplication. Repeated here because both
    // installs are re-entrant on purpose: a scenario load swaps `park` and `scenario` for
    // new objects, and src/mcp.ts assigns over `context.setTimeout` and back while its
    // deferred calls are in flight. Neither would be re-guarded by a one-shot at startup.
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
