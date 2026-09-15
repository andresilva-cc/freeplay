/**
 * The scenario clock, held still except when the model asks for it.
 *
 * Measured over one scenario year: seven `wait` calls spent 62 of 248 days, and the other
 * 186 elapsed between calls while the model was thinking. Three quarters of the scenario
 * went on inference latency, at a rate the run never chose: the game advances 0.075 days a
 * real second at speed 1 and 0.60 at speed 4, so an 82-second turn at speed 4 spends 49
 * game days - a fifth of a year - that nothing decided to spend. A host with twice the
 * tokens per second halves that bill, which makes two runs of the same model on two
 * machines two different games, and charges the model for thinking rather than for
 * thinking wrongly.
 *
 * So the bridge holds the game paused between tool calls and `wait` is the only thing that
 * spends scenario time on purpose.
 *
 * What a pause does to the rest of the game, read off OpenRCT2's own loop rather than
 * assumed, because assuming it is how this would have hung every tool that acts:
 *
 * - `gameStateTick` (GameState.cpp) sets `numUpdates = 0` while paused and never calls
 *   `gameStateUpdateLogic`, so the date, `currentTicks`, the guests, the rides and the
 *   `interval.tick` hook all stand still.
 * - That same paused branch still calls `GameActions::ProcessQueue`. A queued action is
 *   therefore still dequeued while paused - and still refused there, because `ProcessQueue`
 *   runs it through `Execute` and `QueryInternal`, whose `CheckActionInPausedMode` turns
 *   anything without `Flags::AllowWhilePaused` into "Construction not possible while game
 *   is paused!". The refusal arrives on the plugin's own callback, immediately.
 * - `ScriptEngine::Tick` is called from `Context::Tick`, outside the pause check, and
 *   `UpdateIntervals` measures against `Platform::GetTicks`. So `context.setTimeout` keeps
 *   firing on real time through a pause, and so does the bridge's socket.
 *
 * Which settles the question the 30-second watchdog raises: a paused game does not strand a
 * deferred tool, it refuses it. Nothing hangs; builds, paths, clears and hires would simply
 * all come back refused. So the clock is let run from the first action a tool fires until
 * that tool has answered, and held again a tick later.
 *
 * That window is one per tool CALL rather than one per action, and the tighter shape was
 * tried first: open around each action, close a frame later once the tick counter has moved.
 * It costs a frame instead of the tool's whole duration, and it is wrong. Closing it needs a
 * timer scheduled from inside `context.executeAction`, which lands in the middle of a tool's
 * own loop - `src/park/clear.ts` walks a tile's elements and fires a removal per element -
 * and every tool in this bridge is written against "actions apply on a later tick". Buying a
 * frame by making that false somewhere is not a trade worth making.
 *
 * What the window costs, then, is the real time the tool spends inside itself, which is its
 * own `context.setTimeout` steps rather than anything about the machine: roughly 8 ticks per
 * 200ms step at speed 1 and eight times that at speed 4. A tool that only reads opens no
 * window at all and costs nothing.
 *
 * The close waits for the tick counter to move before it re-applies the pause. An action
 * fired on the way out of a tool is still only queued when the tool answers, and
 * `ProcessQueue` would refuse it on the next paused frame; waiting for one tick is waiting
 * for it to have been applied, which is the one thing worth proving.
 *
 * A pause the model asked for with `set_game_speed` is a different thing and is left alone:
 * no window is opened while that is in force, so the refusals every actor tool documents are
 * still reachable and still true.
 */

/**
 * The actions this bridge fires that OpenRCT2 runs while the game is paused: the ones whose
 * `GetActionFlags()` ORs in `Flags::AllowWhilePaused`. They need no window.
 *
 * `pausetoggle` must never get one. It flips the pause rather than setting it, so unpausing
 * around it would turn a request to unpause into a request to pause.
 */
export const ACTIONS_ALLOWED_WHILE_PAUSED: Record<string, boolean> = {
    gamesetspeed: true,
    pausetoggle: true,
    ridecreate: true,
    ridesetstatus: true,
    ridesetprice: true,
    ridesetsetting: true,
    parksetparameter: true,
    parksetentrancefee: true,
    staffhire: true
};

/** OpenRCT2 runs its game loop at 40Hz, so one frame is 25ms of real time. */
const FRAME_MS = 25;

/**
 * How many frames a window waits for the clock to move before closing anyway. Half a second
 * of a clock that is not advancing is a clock this cannot wait on: something else is holding
 * the game, and holding the window open instead would leave it running.
 */
const CLOSE_POLL_LIMIT = 20;

/** Who the stopped clock belongs to. See `clockHeldBy`, which is the whole reading. */
export type ClockHolder = "nobody" | "you" | "bridge" | "unknown";

/** True while the pause in force is the bridge's own, put there between tool calls. */
let bridgeHolds = false;

/** True once the model asked for a pause itself. Its pause is not the bridge's to lift. */
let playerPaused = false;

/** Open windows. Refcounted, so `wait` and a tool's own window cannot close each other's. */
let windowsOpen = 0;

/** A window an action opened, still to be closed when the call it belongs to is over. */
let closeOwed = false;

function gameContext(): Partial<Context> | undefined {
    return typeof context === "undefined" || !context ? undefined : context;
}

function isPausedNow(): boolean {
    const game = gameContext();

    return typeof game !== "undefined" && game.paused === true;
}

/**
 * True only for the instant this gate is writing `context.paused` itself.
 *
 * `context.paused` is frozen against evaluated scripts in src/scripting.ts, and it has to
 * be: it is the single flag the whole clock discipline rests on, a script could set it to
 * false, and `park_status` went on reporting `clockHeldBy: "bridge"` while it was wrong.
 * But the gate's own write happens on the script's stack - `runActionWithClock` opens the
 * window from inside `context.executeAction`, which is where a script fires an action - so
 * "is a script running?" is not enough on its own to tell the two apart. This is the rest
 * of the question: the gate says, for the length of one assignment, that this write is its.
 *
 * A flag rather than a token because the guard and the writer are in different modules and
 * the write goes through a property setter, which takes no argument of its own. It is set
 * and cleared around a single synchronous assignment with nothing in between that could run
 * a script, so there is no window in which a script could be holding it open.
 */
let gateIsSettingPause = false;

/** Whether the `context.paused` write happening right now is this gate's. See `setPaused`. */
export function pauseWriteIsTheGates(): boolean {
    return gateIsSettingPause;
}

/**
 * Set the pause through the plugin API's own setter, which calls `PauseToggle` at once
 * rather than queueing an action. It throws in network mode, where the pause belongs to the
 * server; a bridge that cannot hold the clock then holds nothing and says so by reading back
 * what the game actually did.
 */
function setPaused(value: boolean): void {
    const game = gameContext();

    if (typeof game === "undefined" || game.paused === value) {
        return;
    }

    gateIsSettingPause = true;

    try {
        game.paused = value;
    } catch (_error) {
        // Read-only in network mode. Nothing to do but leave the clock where it is.
    } finally {
        // In `finally` because the setter can throw: leaving this set would hand the next
        // script the one write this whole guard exists to refuse.
        gateIsSettingPause = false;
    }
}

/** The game's own tick counter, which stops dead while paused. Undefined outside a game. */
export function readGameTicks(): number | undefined {
    const clock: Partial<GameDate> | undefined = typeof date === "undefined" ? undefined : date;

    if (!clock || typeof clock.ticksElapsed !== "number" || isNaN(clock.ticksElapsed)) {
        return undefined;
    }

    return clock.ticksElapsed;
}

/** True once the model paused the game itself, which is the pause that refuses actions. */
export function playerPausedTheGame(): boolean {
    return playerPaused;
}

/**
 * True when the pause in force is one OpenRCT2 will actually refuse actions through.
 *
 * The bridge's own hold is not one of those: `runActionWithClock` opens a window round any
 * action the hold would have refused, so a tool acts through it exactly as it did before
 * there was a hold, and `wait` spends game days through it too. Reading `context.paused`
 * instead - which is what every tool here used to do, and what `park_status` used to report -
 * now answers true on essentially every turn and calls a build impossible when it is not.
 *
 * What is left when the hold is excluded is the pause the model asked for with
 * `set_game_speed`, which is deliberately not lifted, plus the case where the clock is
 * stopped and the bridge neither set it nor was told about it.
 *
 * A pause a HUMAN sets in the OpenRCT2 window is not distinguishable from the bridge's own
 * hold and reads as false here. There is nothing in the plugin API that says who set the
 * flag, and by the time this is asked `holdClockBetweenCalls` has claimed the pause either
 * way. It is the right answer regardless: the gate opens a window through that pause the
 * same as through its own, so nothing is being refused.
 */
export function pauseRefusesActions(): boolean {
    return isPausedNow() && !bridgeHolds;
}

/**
 * Whose the stopped clock is, as far as this gate can tell.
 *
 * - `nobody`: the game is running.
 * - `you`: the model asked for this pause with `set_game_speed`, and the game refuses map
 *   changes and `wait` through it.
 * - `bridge`: the pause in force is one this bridge is holding, so tools act through it.
 * - `unknown`: the game is paused, and the bridge neither set that pause nor was told about
 *   it. Actions are refused through it and the bridge is not the one that can lift it.
 *
 * This is the reading `park_status` had no field for. `paused` answers a different question -
 * whether the pause in force refuses actions - and it answers false both when the clock is
 * running and when the bridge is holding it, which are the two states a person tells apart at
 * a glance from the pause the game draws in its own toolbar.
 *
 * `bridge` is what this bridge is holding and not a claim about who first set it: a pause
 * someone sets in the OpenRCT2 window is claimed by `holdClockBetweenCalls` the same as one
 * the bridge set itself, nothing in the plugin API says who set the flag, and the gate opens
 * a window through either. So the two are one value here rather than a guess between them.
 *
 * `you` and `bridge` are never both true: `recordPlayerPause` clears `bridgeHolds` the moment
 * the model asks for a pause, and `holdClockBetweenCalls` leaves the model's pause alone.
 */
export function clockHeldBy(): ClockHolder {
    if (!isPausedNow()) {
        return "nobody";
    }

    if (playerPaused) {
        return "you";
    }

    return bridgeHolds ? "bridge" : "unknown";
}

/**
 * Hold the clock still, which is what "between tool calls" means.
 *
 * Called on both sides of a tool call: once when it arrives, so a turn spent thinking has
 * cost nothing, and once when its result is built, which is what closes the window the
 * tool's first action opened.
 *
 * A pause the model asked for is left exactly as it is: it is the same stopped clock, but it
 * is the model's, and every actor tool's description depends on that difference.
 */
export function holdClockBetweenCalls(): void {
    if (closeOwed) {
        closeOwed = false;
        closeClockWindowAfterATick();
    }

    if (windowsOpen > 0) {
        // A window is still open; whoever closes it applies the hold on the way out.
        return;
    }

    if (playerPaused) {
        bridgeHolds = false;
        return;
    }

    setPaused(true);
    bridgeHolds = isPausedNow();
}

/**
 * Record a pause or unpause the model asked for, so the bridge stops treating the stopped
 * clock as its own bookkeeping and leaves the game refusing what a paused game refuses.
 */
export function recordPlayerPause(paused: boolean): void {
    playerPaused = paused;

    if (paused) {
        bridgeHolds = false;
    }
}

/** Let the clock run. Refcounted, so nested holders cannot stop each other's window. */
export function openClockWindow(): void {
    windowsOpen++;

    if (windowsOpen === 1 && bridgeHolds) {
        setPaused(false);
    }
}

/** Close one window, and hold the clock again once the last one is closed. */
export function closeClockWindow(): void {
    if (windowsOpen > 0) {
        windowsOpen--;
    }

    if (windowsOpen === 0 && bridgeHolds) {
        setPaused(true);
    }
}

function schedule(callback: () => void): boolean {
    const game = gameContext();

    if (typeof game === "undefined" || typeof game.setTimeout !== "function") {
        return false;
    }

    game.setTimeout(callback, FRAME_MS);
    return true;
}

/**
 * Close the window once the game has actually run a tick.
 *
 * An action is queued from a script callback, which OpenRCT2 runs after that frame's
 * `gameStateUpdateLogic`, so it is the NEXT frame's `ProcessQueue` that applies it and the
 * next frame's `currentTicks++` that follows. Waiting for the tick counter to move is
 * therefore waiting for the last action to have been applied, which is why this does not
 * close on a fixed delay and does not close at once.
 *
 * One frame, `1 << (speed - 1)` game ticks, is what that costs on top of the call itself.
 * A tick is 1/528th of a game day.
 */
function closeClockWindowAfterATick(): void {
    const started = readGameTicks();
    let polls = 0;

    const poll = function (): void {
        const now = readGameTicks();

        polls++;

        if (typeof now !== "number" || typeof started !== "number" || now > started
            || polls >= CLOSE_POLL_LIMIT || !schedule(poll)) {
            closeClockWindow();
        }
    };

    if (!schedule(poll)) {
        closeClockWindow();
    }
}

/**
 * Whether this action would be refused by the pause the bridge is holding.
 *
 * `bridgeHolds` is the whole question of whose pause it is: it is set only where the bridge
 * applies its own, and cleared the moment the model asks for one. There is no second check
 * for the model's pause here because there is no state in which both are true.
 */
function needsClockWindow(name: string): boolean {
    if (!bridgeHolds || !isPausedNow()) {
        return false;
    }

    return ACTIONS_ALLOWED_WHILE_PAUSED[String(name).toLowerCase()] !== true;
}

/**
 * Fire a game action with the clock let run across it, if the pause in force is the bridge's
 * own and the action is one OpenRCT2 would otherwise refuse.
 *
 * The window is opened here and closed by `holdClockBetweenCalls` when the call is over.
 * Nothing is scheduled from inside this call: a timer here would fire in the middle of the
 * calling tool's own loop and apply the action it had only just queued, which every tool in
 * this bridge is written on the assumption cannot happen.
 *
 * Nothing else here decides anything: which action, with what arguments, and whether to fire
 * it at all are the calling tool's, and an action the game refuses for its own reasons is
 * refused exactly as it would have been.
 */
export function runActionWithClock(name: string, fire: () => unknown): unknown {
    if (needsClockWindow(name)) {
        openClockWindow();
        closeOwed = true;
    }

    return fire();
}

/** Forget everything, for a test that needs the gate to start where the game does. */
export function resetClockGate(): void {
    bridgeHolds = false;
    playerPaused = false;
    windowsOpen = 0;
    closeOwed = false;
    gateIsSettingPause = false;
}
