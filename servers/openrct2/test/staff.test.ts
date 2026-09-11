import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { FakeSocket } from "./fakeSocket.ts";
import { createApplication } from "../src/app.ts";
import { StaffTools } from "../src/tools/staff.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { isDeferredMcpResult } from "../src/tools/types.ts";

/**
 * hire_staff, driven over MCP the way the model reaches it.
 *
 * Every assertion about who was hired counts the entities on the fake game's map rather
 * than reading the number back out of the result. The result is the thing under test: a
 * tool that counted the actions it sent would pass any check made against its own answer,
 * and that is this project's most repeated bug.
 */

const mcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json"
};

interface ToolResult {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}

interface Session {
    app: ReturnType<typeof createApplication>;
    headers: Record<string, string>;
    game: FakeGame;
}

function rawRequest(body: string, headers: Record<string, string>): string {
    const lines = ["POST /mcp HTTP/1.1"].concat(Object.keys(headers).map(function (name) {
        return name + ": " + headers[name];
    }));

    return lines.join("\r\n") + "\r\n\r\n" + body;
}

function openSession(app: ReturnType<typeof createApplication>): Record<string, string> {
    const response = app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
            protocolVersion: "2025-11-25", capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" }
        }
    }), mcpHeaders));

    const headers: Record<string, string> = {
        Accept: mcpHeaders.Accept,
        "Content-Type": mcpHeaders["Content-Type"],
        "MCP-Session-Id": String(response.getHeader("mcp-session-id")),
        "MCP-Protocol-Version": "2025-11-25"
    };

    app.handleRawRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", method: "notifications/initialized"
    }), headers));

    return headers;
}

function withSession(run: (session: Session) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(24, 24, options);
    const restore = game.install();

    try {
        const app = createApplication();
        run({ app: app, headers: openSession(app), game: game });
    } finally {
        restore();
    }
}

function callTool(session: Session, name: string, args: Record<string, unknown>): ToolResult {
    const socket = new FakeSocket();
    const outcome = session.app.handleSocketRequest(rawRequest(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: name, arguments: args }
    }), session.headers), socket);

    const raw = outcome.context.connection.hijacked
        ? socket.written.substring(socket.written.indexOf("\r\n\r\n") + 4)
        : outcome.response.getBody();

    const parsed = JSON.parse(raw) as { result?: ToolResult };

    assert.ok(parsed.result, name + " answered with no result: " + raw);
    return parsed.result as ToolResult;
}

function structured(result: ToolResult): Record<string, unknown> {
    assert.notEqual(result.isError, true, "the tool refused: " + JSON.stringify(result.content));
    assert.ok(result.structuredContent, "the tool answered with no structured result");
    return result.structuredContent as Record<string, unknown>;
}

/** The message behind a refusal, whether the schema caught it or the tool did. */
function refusal(result: ToolResult): string {
    if (result.isError === true) {
        assert.ok(result.content && result.content.length > 0, "a refusal with no message is unusable");
        return (result.content as { text: string }[])[0].text;
    }

    const body = result.structuredContent as { ok?: boolean; error?: string } | undefined;

    assert.ok(body, "the call was neither refused nor answered: " + JSON.stringify(result));
    assert.equal(body.ok, false, "the arguments were accepted: " + JSON.stringify(body));
    assert.equal(typeof body.error, "string", "a refusal with no message is unusable");
    return String(body.error);
}

type ExecuteAction = (name: string, args: Record<string, unknown>, callback?: (result: Record<string, unknown>) => void) => void;

/**
 * Run `side` the first time an action of this name is sent, standing in for the world
 * moving on its own while a call is in flight. `restore()` puts the whole context back.
 */
function onFirstAction(name: string, side: () => void): void {
    const scope = globalThis as unknown as { context: { executeAction: ExecuteAction } };
    const real = scope.context.executeAction;
    let fired = false;

    scope.context.executeAction = function (actionName, args, callback) {
        real(actionName, args, callback);

        if (actionName === name && !fired) {
            fired = true;
            side();
        }
    };
}

/**
 * Run `side` once the first action of this name has actually been applied, standing in for
 * the world changing between one queued action and the next. `onFirstAction` fires while
 * the actions are still being queued, which is too early to let one of a batch succeed and
 * the rest fail. `restore()` puts the whole context back.
 */
function afterFirstApplied(name: string, side: () => void): void {
    const scope = globalThis as unknown as { context: { executeAction: ExecuteAction } };
    const real = scope.context.executeAction;
    let fired = false;

    scope.context.executeAction = function (actionName, args, callback) {
        real(actionName, args, function (result) {
            if (callback) {
                callback(result);
            }

            if (actionName === name && !fired) {
                fired = true;
                side();
            }
        });
    };
}

/** hire_staff called straight on its handler, past the schema the MCP layer applies. */
function hireDirect(args: Record<string, unknown>): Record<string, unknown> {
    const result = new StaffTools().hireStaff(args);

    assert.ok(isDeferredMcpResult(result), "hire_staff answers on the deferred path");

    let answer: Record<string, unknown> | null = null;
    result.start(function (value) { answer = value as Record<string, unknown>; });

    assert.ok(answer, "hire_staff never answered");
    return answer as unknown as Record<string, unknown>;
}

/** Staff of one kind standing in the park, counted off the map. */
function staffOnMap(game: FakeGame, staffType: string): number {
    return game.staff.filter(function (member) {
        return member.staffType === staffType;
    }).length;
}

test("hiring puts exactly the number asked for in the park, counted on the map", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "hire_staff", { staffType: "handyman", count: 3 }));

        assert.equal(staffOnMap(session.game, "handyman"), 3, "three handymen have to be standing in the park");
        assert.equal(session.game.staff.length, 3, "and nobody else was hired along with them");
        assert.equal(body.ok, true, String(body.detail));
        assert.equal(body.hired, 3, "and the answer has to agree with the map");
        assert.equal(body.requested, 3);
        assert.equal(body.totalStaff, 3);
    });
});

test("a count left out hires one", function () {
    withSession(function (session) {
        const body = structured(callTool(session, "hire_staff", { staffType: "mechanic" }));

        assert.equal(staffOnMap(session.game, "mechanic"), 1);
        assert.equal(body.requested, 1, "the default has to be reported as the request it stood in for");
        assert.equal(body.hired, 1);
    });
});

test("the count reported back is what was asked for, not what the tool decided to do", function () {
    // hire_staff used to clamp the count to ten and report the clamped number as
    // `requested`, so a call for thirty came back saying ten had been asked for. The
    // schema now refuses anything outside 1 to 10, which leaves `requested` honest.
    withSession(function (session) {
        const body = structured(callTool(session, "hire_staff", { staffType: "security", count: 10 }));

        assert.equal(body.requested, 10);
        assert.equal(staffOnMap(session.game, "security"), 10, "and ten is what the map has to show");
        assert.equal(body.hired, 10);
    });
});

test("hiring one kind of staff counts that kind, not the park's whole payroll", function () {
    withSession(function (session) {
        session.game.addStaff("handyman");
        session.game.addStaff("handyman");
        session.game.addStaff("entertainer");

        const body = structured(callTool(session, "hire_staff", { staffType: "mechanic", count: 2 }));

        assert.equal(staffOnMap(session.game, "mechanic"), 2, "two mechanics were hired");
        assert.equal(body.hired, 2, "and two is what it has to report, not the five people now on the payroll");
        assert.equal(body.totalStaff, 5, "which is what totalStaff is for");
        assert.equal(staffOnMap(session.game, "handyman"), 2, "the handymen already there were left alone");
    });
});

test("when the hiring never takes effect, it says nobody was hired", function () {
    // The false-success direction: actions accepted, never applied, and a tool that counted
    // what it sent would report three new handymen standing in an empty park.
    withSession(function (session) {
        const body = structured(callTool(session, "hire_staff", { staffType: "handyman", count: 3 }));

        assert.ok(session.game.attempted.length > 0, "the hiring was asked for");
        assert.equal(session.game.staff.length, 0, "and nobody actually turned up");
        assert.equal(body.ok, false, "a hiring that did not happen is not a success");
        assert.equal(body.hired, 0);
        assert.equal(body.requested, 3, "the request is still reported as what was asked");
        assert.match(String(body.detail), /Only 0 of 3/);
    }, { inert: true });
});

test("a hiring the game refuses is reported as the refusal it was", function () {
    withSession(function (session) {
        session.game.refuse.staffhire = true;

        const body = structured(callTool(session, "hire_staff", { staffType: "mechanic", count: 2 }));

        assert.equal(session.game.staff.length, 0, "the game turned every one of them down");
        assert.equal(body.ok, false);
        assert.equal(body.hired, 0);
        assert.match(String(body.detail), /Only 0 of 2/);
    });
});

test("a short hire quotes the reason the game gave and invents no other", function () {
    // "check you can afford them" used to be appended to every partial hire, with the park's
    // cash never read. `StaffHireNewAction` carries no cost - staff draw wages monthly, and
    // hiring itself is free - so money could not have been the reason either way. The cure
    // for a made-up cause is the game's own words, not the absence of a cause: the count on
    // its own left the model with nothing to act on.
    withSession(function (session) {
        session.game.refuse.staffhire = true;

        const body = structured(callTool(session, "hire_staff", { staffType: "mechanic", count: 2 }));

        assert.equal(session.game.staff.length, 0, "the game turned both of them down");
        assert.equal(String(body.detail), "Only 0 of 2 were hired. The game refused every one: Refused: test refusal.",
            "the count, and the game's own words for why, and nothing the tool made up");
        assert.doesNotMatch(String(body.detail), /afford|cash|money/,
            "money was never read and the game never mentioned it");
        assert.doesNotMatch(String(body.detail), /costume/,
            "a mechanic wears no costume, so the entertainer explanation must not leak onto one");
    });
});

test("an entertainer a scenario has no costume for is refused in the game's words, not as a bare count", function () {
    // Measured in the running game: hire_staff {entertainer, 3} came back "Only 0 of 3 were
    // hired." while the game had said "Can't hire new staff: Value out of range". Forest
    // Frontiers loads no entertainer costume, so StaffHireNewAction refuses costume 0 - the
    // only costume this tool asks for - and no entertainer can ever be hired there. With the
    // count alone the model retries forever.
    withSession(function (session) {
        session.game.entertainerCostumes = 0;

        const body = structured(callTool(session, "hire_staff", { staffType: "entertainer", count: 3 }));

        assert.equal(session.game.staff.length, 0, "nobody is standing in the park");
        assert.equal(body.ok, false);
        assert.equal(body.hired, 0);
        assert.equal(body.requested, 3);
        assert.match(String(body.detail), /Value out of range/, "the game's own words for the refusal");
        assert.match(String(body.detail), /costume/, "and what they mean, which is the whole of the problem");
        assert.match(String(body.detail), /no entertainer can be hired/,
            "a model that is not told this retries the same hire for the rest of the game");
    });
});

test("a park that has the costume hires entertainers as normal", function () {
    // The other half: the refusal is a property of the scenario, so the working path must be
    // untouched by the explanation for the broken one.
    withSession(function (session) {
        const body = structured(callTool(session, "hire_staff", { staffType: "entertainer", count: 2 }));

        assert.equal(staffOnMap(session.game, "entertainer"), 2, "both are standing in the park");
        assert.equal(body.ok, true, String(body.detail));
        assert.equal(String(body.detail), "Hired 2 entertainer.");
    });
});

test("the costume explanation is only ever given about an entertainer", function () {
    // It is decoded from an InvalidParameters refusal, and `staffhire` reaches that two ways:
    // a staff type out of range, which STAFF_TYPES makes impossible, and a missing costume,
    // which only an entertainer has. Said about a mechanic it would be a guess.
    withSession(function (session) {
        session.game.entertainerCostumes = 0;
        session.game.refuse.staffhire = true;

        const handymen = structured(callTool(session, "hire_staff", { staffType: "handyman", count: 2 }));

        assert.equal(session.game.staff.length, 0, "the game turned both of them down");
        assert.doesNotMatch(String(handymen.detail), /costume/,
            "a handyman refused for some other reason must not be explained as a missing costume");
    });
});

test("entertainers hired alongside a refusal report the count and the reason together", function () {
    // A partial hire is the case a single collapsed message gets most wrong: the model has to
    // see both that somebody turned up and that the rest were refused, and why.
    withSession(function (session) {
        session.game.entertainerCostumes = 1;

        // The park loses its costume part way through: the first hire lands, the rest do not.
        afterFirstApplied("staffhire", function () {
            session.game.entertainerCostumes = 0;
        });

        const body = structured(callTool(session, "hire_staff", { staffType: "entertainer", count: 3 }));

        assert.equal(staffOnMap(session.game, "entertainer"), 1, "one entertainer made it into the park");
        assert.equal(body.ok, false);
        assert.equal(body.hired, 1, "counted off the map, not off the three hirings that were sent");
        assert.match(String(body.detail), /Only 1 of 3/);
        assert.match(String(body.detail), /Value out of range/, "with the game's reason for the two that failed");
        assert.doesNotMatch(String(body.detail), /no entertainer can be hired/,
            "one of them was hired, so 'none can be' would be false");
    });
});

test("a count outside 1 to 10 is refused by name, not clamped to the nearest legal one", function () {
    withSession(function (session) {
        const tooMany = refusal(callTool(session, "hire_staff", { staffType: "handyman", count: 30 }));

        assert.match(tooMany, /count/, "the property at fault has to be named");
        assert.match(tooMany, /1 to 10/, "and the range it had to be in");
        assert.match(tooMany, /30/, "and the value that arrived, so 30 is never mistaken for a request for 10");

        const none = refusal(callTool(session, "hire_staff", { staffType: "handyman", count: 0 }));

        assert.match(none, /count/);
        assert.match(none, /1 to 10/);

        assert.equal(session.game.staff.length, 0, "and neither call put anybody in the park");
        assert.equal(session.game.attempted.length, 0, "nor sent a single action to the game");
    });
});

test("a staff type that does not exist is refused with the four that do", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "hire_staff", { staffType: "clown", count: 2 }));

        assert.match(message, /staffType/, "the property at fault has to be named");
        assert.match(message, /clown/, "the value that was rejected has to be quoted back");
        assert.match(message, /handyman/);
        assert.match(message, /mechanic/);
        assert.match(message, /security/);
        assert.match(message, /entertainer/);
        assert.equal(session.game.staff.length, 0, "and nobody was hired in the meantime");
        assert.equal(session.game.attempted.length, 0);
    });
});

test("a count that is not a whole number is refused rather than floored", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "hire_staff", { staffType: "handyman", count: 2.5 }));

        assert.match(message, /count/);
        assert.match(message, /expected integer/);
        assert.equal(session.game.staff.length, 0);
    });
});

test("hiring with no staff type at all is refused by name", function () {
    withSession(function (session) {
        const message = refusal(callTool(session, "hire_staff", {}));

        assert.match(message, /staffType/);
        assert.equal(session.game.attempted.length, 0);
    });
});

test("called directly, past the MCP layer, it still refuses a staff type it does not know", function () {
    // The enum on `staffType` means the central check catches this first over MCP, so the
    // tool's own refusal would otherwise stop being exercised at all. Both layers have to
    // hold: the plugin's other entry points do not go through schema validation.
    withSession(function (session) {
        const result = new StaffTools().hireStaff({ staffType: "clown", count: 2 });

        assert.ok(isDeferredMcpResult(result), "hire_staff answers on the deferred path");

        let answer: Record<string, unknown> | null = null;
        result.start(function (value) { answer = value as Record<string, unknown>; });

        assert.ok(answer, "it never answered at all");

        const body = answer as unknown as Record<string, unknown>;

        assert.equal(body.ok, false);
        assert.match(String(body.error), /clown/, "the value that was rejected has to be quoted back");
        assert.match(String(body.error), /handyman/);
        assert.match(String(body.error), /entertainer/);
        assert.equal(session.game.staff.length, 0, "and nobody was hired in the meantime");
        assert.equal(session.game.attempted.length, 0);
    });
});

test("called directly, past the MCP layer, 30 is reported as 30 and never clamped to 10", function () {
    // The schema refuses a count outside 1 to 10 before the tool is reached, so over MCP
    // this is unreachable - and the clamp it guards against was a real shipped bug: a call
    // for thirty came back saying ten had been asked for, so the model believed it had got
    // what it wanted. The plugin's other entry points do not go through schema validation.
    withSession(function (session) {
        const body = hireDirect({ staffType: "handyman", count: 30 });

        assert.equal(staffOnMap(session.game, "handyman"), 30,
            "thirty were asked for, so thirty have to be standing in the park");
        assert.equal(session.game.staff.length, 30, "and nobody else");
        assert.equal(body.requested, 30, "the request reported back is the one that arrived, not one the tool decided on");
        assert.equal(body.hired, 30);
        assert.equal(body.ok, true, String(body.detail));
    });
});

test("someone hired while the call is in flight is not counted as one of ours", function () {
    // Counting the payroll instead of the type asked for reads three where two mechanics
    // went in, because a handyman turned up in between. The existing type test seeds its
    // strangers before the call, where a total count subtracts them again and agrees by
    // accident.
    withSession(function (session) {
        onFirstAction("staffhire", function () {
            session.game.addStaff("handyman");
        });

        const body = structured(callTool(session, "hire_staff", { staffType: "mechanic", count: 2 }));

        assert.equal(staffOnMap(session.game, "mechanic"), 2, "two mechanics are standing in the park");
        assert.equal(staffOnMap(session.game, "handyman"), 1, "beside a handyman this call had nothing to do with");
        assert.equal(session.game.staff.length, 3, "so the payroll grew by three");
        assert.equal(body.hired, 2, "and 2 is what was hired, not the 3 the payroll grew by");
        assert.equal(body.totalStaff, 3, "which is the number totalStaff is for");
        assert.equal(body.ok, true, String(body.detail));
    });
});

test("the description says wages are monthly and never calls hiring a cost", function () {
    // OpenRCT2's StaffHireNewAction sets no cost at all - it only tags the expenditure as
    // wages - and FinancePayWages pays a quarter of the monthly wage each week. "Hiring is
    // a running cost" was both wrong about the action and a nudge about whether to hire.
    const definitions = getMcpToolDefinitions(StaffTools).filter(function (definition) {
        return definition.handlerName === "hireStaff";
    });

    assert.equal(definitions.length, 1, "hire_staff is registered once");

    const text = String(definitions[0].description);

    assert.match(text, /Hiring itself costs nothing/, "the hire action is free, and the model can read that");
    assert.match(text, /paid a wage\s+every month/, "what it actually costs is the monthly wage");
    assert.doesNotMatch(text, /running cost/,
        "whether the payroll is affordable is the model's call, not the tool's");
});
