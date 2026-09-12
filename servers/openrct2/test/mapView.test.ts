import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { DEFAULT_VIEW_SIZE, MAX_VIEW_SIDE, MIN_VIEW_SIZE, renderMapView } from "../src/park/mapView.ts";
import type { MapViewOutcome, MapViewSuccess } from "../src/park/mapView.ts";
import { MapViewTools } from "../src/tools/mapView.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";

/**
 * A map that draws the right shape at the wrong offset is worse than no map: the model
 * reads it confidently and builds one tile out. So the alignment tests here never use a
 * formula for where a cell should be - they find a planted tile in the text, read that
 * column's x back out of the header rows, and check the two agree. An off-by-one in
 * either the header or the body moves one without the other.
 */

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, size = 40): void {
    const game = new FakeGame(size, size);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

function drawn(outcome: MapViewOutcome): MapViewSuccess {
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
    return outcome as MapViewSuccess;
}

/** How many rows at the top carry the x coordinates: one per digit place of the last x. */
function headerRowCount(view: MapViewSuccess): number {
    return String(view.area.toX).length;
}

function headerRows(view: MapViewSuccess): string[] {
    return view.rows.slice(0, headerRowCount(view));
}

function gridRows(view: MapViewSuccess): string[] {
    return view.rows.slice(headerRowCount(view));
}

/** The y a row says it is, read off the row itself rather than off its position. */
function labelOf(row: string): number {
    const label = /^ *(\d+) /.exec(row);
    assert.ok(label, "a grid row has to start with its own y: " + JSON.stringify(row));
    return Number((label as RegExpExecArray)[1]);
}

/** The x the header rows give for the character at `index`, read down the column. */
function headerXAt(view: MapViewSuccess, index: number): number {
    const digits = headerRows(view).map(function (row) {
        return row.charAt(index);
    }).join("").replace(/ /g, "");

    assert.ok(/^\d+$/.test(digits), "the header column at " + String(index) + " is not a number: "
        + JSON.stringify(digits));
    return Number(digits);
}

function rowFor(view: MapViewSuccess, y: number): string {
    const rows = gridRows(view).filter(function (row) {
        return labelOf(row) === y;
    });

    assert.equal(rows.length, 1, "exactly one row should be labelled " + String(y));
    return rows[0];
}

function prefixWidth(row: string): number {
    return (/^ *\d+ /.exec(row) as RegExpExecArray)[0].length;
}

/**
 * The character at x,y - located through the header rather than through a formula, so the
 * header and the body have to agree before any other assertion in the suite means anything.
 */
function cellAt(view: MapViewSuccess, x: number, y: number): string {
    const row = rowFor(view, y);
    const index = prefixWidth(row) + (x - view.area.fromX);

    assert.equal(headerXAt(view, index), x,
        "the header says column " + String(index) + " is x " + String(headerXAt(view, index))
        + ", not " + String(x));

    return row.charAt(index);
}

function gridText(view: MapViewSuccess): string {
    return gridRows(view).map(function (row) {
        return row.substring(prefixWidth(row));
    }).join("");
}

function countOf(view: MapViewSuccess, glyph: string): number {
    return gridText(view).split(glyph).length - 1;
}

/** A ride the fake will report, without going through ridecreate. */
function addRide(game: FakeGame, id: number): void {
    game.rides.push({
        id: id, name: "Ride " + String(id), type: 0, status: "closed", price: [0],
        stations: [{ start: null, entrance: null, exit: null, length: 0, queueTime: 0 }],
        excitement: -1, intensity: 0, totalCustomers: 0, totalProfit: 0,
        downtime: 0, reliability: 100, flags: 0, value: null
    });
}

function addTrack(game: FakeGame, x: number, y: number, ride: number): void {
    game.tile(x, y).elements.push({ type: "track", baseZ: 96, ride: ride, trackType: 0, direction: 0 });
}

function addWater(game: FakeGame, x: number, y: number): void {
    Object.assign(game.tile(x, y).elements[0], { waterHeight: 112 });
}

// ---------------------------------------------------------------------------
// Alignment. The failure mode here is silent, so this is the part that matters most.
// ---------------------------------------------------------------------------

test("a tile lands in the column the header names for it", function () {
    withGame(function (game) {
        game.addScenery(23, 17);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 12, right: 31, bottom: 25 }));
        const carrying = gridRows(view).filter(function (row) { return row.indexOf("*") >= 0; });

        assert.equal(carrying.length, 1, "only one tile has scenery on it");
        assert.equal(labelOf(carrying[0]), 17, "the row it is on has to say y 17");
        assert.equal(headerXAt(view, carrying[0].indexOf("*")), 23,
            "the header has to say this column is x 23; if it says 22 or 24 the map is one tile out");
    });
});

test("every column of a window is the x the header gives it", function () {
    // The test above pins one tile. This walks the whole header against `area`, so a
    // header and a body that slipped together by the same amount still fail.
    withGame(function () { /* empty park */ }, function () {
        const view = drawn(renderMapView({ left: 7, top: 3, right: 29, bottom: 19 }));
        const row = rowFor(view, 3);
        const prefix = prefixWidth(row);

        for (let x = view.area.fromX; x <= view.area.toX; x++) {
            assert.equal(headerXAt(view, prefix + (x - view.area.fromX)), x);
        }

        assert.equal(labelOf(gridRows(view)[0]), view.area.fromY);
        assert.equal(labelOf(gridRows(view)[gridRows(view).length - 1]), view.area.toY);
        assert.equal(gridRows(view).length, view.area.toY - view.area.fromY + 1);
    });
});

test("every row is the same fixed width, one character a tile and no gaps", function () {
    withGame(function (game) {
        game.addPath(10, 10);
        game.addScenery(11, 11);
    }, function () {
        const view = drawn(renderMapView({ left: 5, top: 5, right: 20, bottom: 18 }));
        const width = view.area.toX - view.area.fromX + 1;
        const expected = prefixWidth(rowFor(view, 5)) + width;

        for (let i = 0; i < view.rows.length; i++) {
            assert.equal(view.rows[i].length, expected,
                "row " + String(i) + " is " + String(view.rows[i].length) + " characters, not "
                + String(expected) + "; a ragged row is an off-by-one waiting to happen");
        }
    });
});

test("three-digit coordinates get a third header row rather than being cut short", function () {
    withGame(function (game) {
        game.addScenery(104, 101);
    }, function () {
        const view = drawn(renderMapView({ left: 96, top: 95, right: 115, bottom: 110 }));

        assert.equal(headerRowCount(view), 3, "x runs past 99 here, so hundreds, tens and units");
        assert.equal(cellAt(view, 104, 101), "*");
        assert.equal(cellAt(view, 99, 101), ".", "the columns either side of the hundreds roll are still themselves");
        assert.equal(cellAt(view, 100, 101), ".");
    }, 128);
});

// ---------------------------------------------------------------------------
// The legend: one character for one thing, and the same thing for that character.
// ---------------------------------------------------------------------------

test("each glyph is drawn for the thing it means and for nothing else", function () {
    withGame(function (game) {
        addRide(game, 0);
        addTrack(game, 12, 12, 0);
        game.addParkEntrance(6, 6);          // three tiles: 6, 7 and 8 at y 6
        game.addRideEntrance(14, 12, 0, 0);
        game.addRideEntrance(14, 14, 0, 0, true);
        game.addPath(10, 16);
        game.addPath(10, 17, true);
        game.addScenery(8, 16);
        addWater(game, 16, 18);
        game.tile(17, 18).elements[0].slope = 4;
        game.own(18, 18, false);
    }, function () {
        const view = drawn(renderMapView({ left: 5, top: 5, right: 20, bottom: 20 }));

        assert.equal(cellAt(view, 12, 12), "a", "ride 0's track");
        assert.equal(cellAt(view, 6, 6), "G");
        assert.equal(cellAt(view, 14, 12), "N");
        assert.equal(cellAt(view, 14, 14), "X");
        assert.equal(cellAt(view, 10, 16), "P");
        assert.equal(cellAt(view, 10, 17), "Q");
        assert.equal(cellAt(view, 8, 16), "*");
        assert.equal(cellAt(view, 16, 18), "~");
        assert.equal(cellAt(view, 17, 18), "^");
        assert.equal(cellAt(view, 18, 18), "-");
        assert.equal(cellAt(view, 5, 20), ".", "ordinary ground with nothing on it");

        assert.equal(countOf(view, "G"), 3, "the gate is three tiles and nothing else is a gate");
        assert.equal(countOf(view, "N"), 1);
        assert.equal(countOf(view, "X"), 1);
        assert.equal(countOf(view, "P"), 1, "the queue tile must not also count as a footpath");
        assert.equal(countOf(view, "Q"), 1);
        assert.equal(countOf(view, "a"), 1);
        assert.equal(countOf(view, "*"), 1);
        assert.equal(countOf(view, "~"), 1);
        assert.equal(countOf(view, "^"), 1);
        assert.equal(countOf(view, "-"), 1);
    });
});

test("a queue and a footpath on the same tile are different characters", function () {
    withGame(function (game) {
        game.addPath(9, 9, true);
    }, function (game) {
        const asQueue = drawn(renderMapView({ left: 5, top: 5, right: 14, bottom: 14 }));
        assert.equal(cellAt(asQueue, 9, 9), "Q");

        game.tile(9, 9).elements = game.tile(9, 9).elements.filter(function (element) {
            return element.type !== "footpath";
        });
        game.addPath(9, 9);

        const asPath = drawn(renderMapView({ left: 5, top: 5, right: 14, bottom: 14 }));
        assert.equal(asPath.rows.length, asQueue.rows.length, "same window, same shape");
        assert.equal(cellAt(asPath, 9, 9), "P",
            "the same tile with an ordinary path on it has to read differently from a queue");
    });
});

test("the legend explains every character in the grid and no character that is absent", function () {
    withGame(function (game) {
        addRide(game, 0);
        addTrack(game, 12, 12, 0);
        game.addPath(10, 16);
        game.addScenery(8, 16);
    }, function () {
        const view = drawn(renderMapView({ left: 5, top: 5, right: 20, bottom: 20 }));
        const text = gridText(view);
        const phrases = view.legend.split(" | ");
        const explained: Record<string, boolean> = {};

        for (let i = 1; i < phrases.length; i++) {   // phrase 0 is the precedence note
            const named = /^(a-z|\S) /.exec(phrases[i]);
            assert.ok(named, "a legend entry has to start with the character it explains: " + phrases[i]);
            const glyph = (named as RegExpExecArray)[1];

            if (glyph === "a-z") {
                for (let letter = 0; letter < 26; letter++) {
                    explained["abcdefghijklmnopqrstuvwxyz".charAt(letter)] = true;
                }
            } else {
                explained[glyph] = true;
            }
        }

        for (let i = 0; i < text.length; i++) {
            assert.ok(explained[text.charAt(i)],
                "the grid uses " + JSON.stringify(text.charAt(i)) + " and the legend never says what it is");
        }

        assert.ok(!explained.Q, "no queue is in this window, so the legend must not offer one");
        assert.ok(!explained.G, "no gate is in this window, so the legend must not offer one");
        assert.ok(!explained["~"], "no water is in this window, so the legend must not offer one");
        assert.ok(explained.a, "ride track is in this window");
        assert.ok(explained["*"]);
        assert.ok(view.legend.indexOf("G N X a-z # Q : P = % ? ~ - ^ * .") >= 0,
            "the precedence a one-character cell runs on has to be stated, not assumed");
    });
});

// ---------------------------------------------------------------------------
// Precedence. One character a tile means collapsing, and the legend states the order,
// so the renderer has to follow exactly that order.
// ---------------------------------------------------------------------------

test("ground that can never be built on outranks scenery standing on it", function () {
    withGame(function (game) {
        game.tile(10, 10).elements[0].slope = 4;
        game.addScenery(10, 10);
        game.addScenery(11, 10);
        game.own(12, 10, false);
        game.addScenery(12, 10);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "^",
            "clearing a tree off sloped ground does not make it buildable, so the slope is the fact");
        assert.equal(cellAt(view, 11, 10), "*", "on flat park land the tree is the fact: clearing it works");
        assert.equal(cellAt(view, 12, 10), "-");
    });
});

test("water outranks ownership and ownership outranks slope", function () {
    withGame(function (game) {
        addWater(game, 10, 10);
        game.own(10, 10, false);
        game.own(11, 10, false);
        game.tile(11, 10).elements[0].slope = 4;
        game.tile(12, 10).elements[0].slope = 4;
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "~", "unowned water is still water");
        assert.equal(cellAt(view, 11, 10), "-", "unowned sloped land reads as not the park's");
        assert.equal(cellAt(view, 12, 10), "^");
    });
});

test("anything built outranks the ground it stands on", function () {
    withGame(function (game) {
        addRide(game, 0);
        game.addPath(10, 10);
        game.addRideEntrance(10, 10, 0, 0);
        game.tile(11, 10).elements[0].slope = 4;
        game.addPath(11, 10);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "N",
            "the building is the salient thing; a P here would hide a ride door");
        assert.equal(cellAt(view, 11, 10), "P", "a path on sloped ground is still a path");
    });
});

// ---------------------------------------------------------------------------
// Ride letters.
// ---------------------------------------------------------------------------

test("each ride gets its own letter and `rides` says which is which", function () {
    withGame(function (game) {
        addRide(game, 0);
        addRide(game, 2);
        addTrack(game, 10, 10, 0);
        addTrack(game, 11, 10, 0);
        addTrack(game, 13, 10, 2);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 16, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "a");
        assert.equal(cellAt(view, 11, 10), "a");
        assert.equal(cellAt(view, 13, 10), "c", "ride 2 is the third letter, not the second ride drawn");
        assert.deepEqual(view.rides, [{ letter: "a", ride: 0 }, { letter: "c", ride: 2 }]);
    });
});

test("a ride numbered past z says so rather than borrowing another ride's letter", function () {
    withGame(function (game) {
        addRide(game, 0);
        addRide(game, 26);
        addTrack(game, 10, 10, 0);
        addTrack(game, 12, 10, 26);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 16, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "a");
        assert.equal(cellAt(view, 12, 10), "#", "ride 26 has no letter, and must not be drawn as `a`");
        assert.deepEqual(view.rides, [{ letter: "a", ride: 0 }],
            "`#` is not a letter of its own, so listing it as ride 26 would be wrong the moment a second ride overflows");
        assert.ok(view.legend.indexOf("# ride track") >= 0,
            "the legend has to explain the character the grid actually used");
    });
});

// ---------------------------------------------------------------------------
// Honesty: nothing inferred, nothing filled in.
// ---------------------------------------------------------------------------

test("an empty park draws as empty and invents nothing", function () {
    withGame(function () { /* nothing at all */ }, function () {
        const view = drawn(renderMapView({ left: 4, top: 4, right: 12, bottom: 12 }));

        assert.equal(gridText(view).replace(/\./g, ""), "",
            "every tile of untouched park is flat owned ground with nothing on it");
        assert.deepEqual(view.rides, []);
        assert.equal(view.clipped, false);
    });
});

test("a tile with no surface element reads as unknown rather than as ground", function () {
    withGame(function (game) {
        game.tile(10, 10).elements = [];
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "?");
        assert.ok(view.legend.indexOf("? unreadable") >= 0);
    });
});

test("an element this map cannot name is shown, not quietly dropped", function () {
    withGame(function (game) {
        game.tile(10, 10).elements.push({ type: "something_new", baseZ: 96 });
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 14 }));

        assert.equal(cellAt(view, 10, 10), "%",
            "a blocker with no glyph must not read as empty buildable ground");
        assert.ok(view.legend.indexOf("% unnamed") >= 0);
    });
});

// ---------------------------------------------------------------------------
// The window: clipping, refusals, and what the result says about both.
// ---------------------------------------------------------------------------

test("a window over the map edge is cut down and says so", function () {
    withGame(function (game) {
        game.addScenery(38, 38);
    }, function () {
        const view = drawn(renderMapView({ left: 30, top: 30, right: 50, bottom: 45 }));

        assert.equal(view.clipped, true);
        assert.deepEqual(view.area, { fromX: 30, fromY: 30, toX: 39, toY: 39 });
        assert.deepEqual(view.requested, { fromX: 30, fromY: 30, toX: 50, toY: 45 });
        assert.ok(typeof view.note === "string" && (view.note as string).indexOf("cut to the map") >= 0,
            "a smaller grid handed back in silence reads as `there is nothing out there`");
        assert.equal(cellAt(view, 38, 38), "*");
    });
});

test("a window entirely off the map is refused rather than drawn empty", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = renderMapView({ left: 60, top: 60, right: 70, bottom: 70 });

        assert.equal(outcome.ok, false);
        assert.ok(outcome.ok === false && outcome.error.indexOf("off the map") >= 0);
    });
});

test("a window larger than the cap is refused with its own measurements", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = renderMapView({ left: 0, top: 0, right: MAX_VIEW_SIDE, bottom: 5 });

        assert.equal(outcome.ok, false);
        assert.ok(outcome.ok === false && outcome.error.indexOf(String(MAX_VIEW_SIDE + 1) + " by 6") >= 0,
            "the refusal has to name the size that was asked for: " + (outcome.ok === false ? outcome.error : ""));
    }, 64);
});

test("a window of exactly the cap is drawn", function () {
    withGame(function () { /* empty */ }, function () {
        const view = drawn(renderMapView({ left: 0, top: 0, right: MAX_VIEW_SIDE - 1, bottom: MAX_VIEW_SIDE - 1 }));

        assert.equal(gridRows(view).length, MAX_VIEW_SIDE);
    });
});

// ---------------------------------------------------------------------------
// The tool layer: which form a call means, and what a half-written one is told.
// ---------------------------------------------------------------------------

interface ToolFailure {
    ok: false;
    error: string;
}

function callTool(args: Record<string, unknown>): MapViewOutcome | ToolFailure {
    return new MapViewTools().viewMap(args) as MapViewOutcome | ToolFailure;
}

test("view_map is registered, and declares the bounds mcp.ts enforces", function () {
    const definitions = getMcpToolDefinitions(MapViewTools);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "view_map");
    assert.equal(definitions[0].inputSchema.additionalProperties, false);
    assert.equal(typeof definitions[0].inputSchema.required, "undefined",
        "a call with no arguments at all is the commonest one and has to be legal");

    const properties = definitions[0].inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(properties).sort(),
        ["fromX", "fromY", "margin", "size", "toX", "toY", "x", "y"]);
    assert.equal(properties.size.maximum, MAX_VIEW_SIDE);
    assert.equal(properties.size.minimum, MIN_VIEW_SIZE);
    assert.equal(properties.margin.minimum, 0);
    assert.equal(typeof properties.margin.maximum, "number");
    assert.equal(properties.x.minimum, 0);
    assert.equal(properties.fromX.minimum, 0);

    const registered = getMcpTools().filter(function (tool) { return tool.name === "view_map"; });
    assert.equal(registered.length, 1, "the tool has to be in the registry or the model never sees it");
    assert.equal(registered[0].annotations?.readOnlyHint, true, "this tool changes nothing");
});

test("no arguments at all draws a square around the park's own gate", function () {
    withGame(function (game) {
        game.addParkEntrance(18, 20);   // 18, 19 and 20 at y 20
    }, function () {
        const view = drawn(callTool({}) as MapViewOutcome);

        assert.equal(view.area.fromX <= 19 && 19 <= view.area.toX, true);
        assert.equal(view.area.fromY <= 20 && 20 <= view.area.toY, true);
        assert.equal(view.area.toX - view.area.fromX + 1, DEFAULT_VIEW_SIZE);
        assert.equal(cellAt(view, 19, 20), "G");
    });
});

test("a park with no gate is told which two forms to use instead", function () {
    withGame(function () { /* no entrance anywhere */ }, function () {
        const outcome = callTool({}) as ToolFailure;

        assert.equal(outcome.ok, false);
        assert.ok(outcome.error.indexOf("no gate") >= 0);
        assert.ok(outcome.error.indexOf("fromX") >= 0 && outcome.error.indexOf("`x`") >= 0);
    });
});

test("a site's four bounds are drawn with room around them", function () {
    withGame(function (game) {
        game.addScenery(20, 20);
    }, function () {
        const view = drawn(callTool({ fromX: 15, fromY: 15, toX: 18, toY: 18, margin: 3 }) as MapViewOutcome);

        assert.deepEqual(view.area, { fromX: 12, fromY: 12, toX: 21, toY: 21 });
        assert.equal(cellAt(view, 20, 20), "*", "the margin is drawn, not just the site");
    });
});

test("the margin has a default, so four copied bounds are enough on their own", function () {
    withGame(function () { /* empty */ }, function () {
        const view = drawn(callTool({ fromX: 15, fromY: 15, toX: 18, toY: 18 }) as MapViewOutcome);

        assert.deepEqual(view.area, { fromX: 11, fromY: 11, toX: 22, toY: 22 });
    });
});

test("a square is centred on x,y exactly as clear_scenery centres one", function () {
    withGame(function () { /* empty */ }, function () {
        const view = drawn(callTool({ x: 20, y: 20, size: 5 }) as MapViewOutcome);

        assert.deepEqual(view.area, { fromX: 18, fromY: 18, toX: 22, toY: 22 });
    });
});

test("mixing the two forms is refused, and the refusal sorts the arguments out", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = callTool({ x: 10, y: 10, fromX: 4, fromY: 4, toX: 8, toY: 8 }) as ToolFailure;

        assert.equal(outcome.ok, false);
        assert.ok(outcome.error.indexOf("mixes them") >= 0);
        assert.ok(outcome.error.indexOf("`x`, `y`") >= 0);
        assert.ok(outcome.error.indexOf("`fromX`, `fromY`, `toX`, `toY`") >= 0);
    });
});

test("half a rectangle is refused rather than squared off into different ground", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = callTool({ fromX: 4, fromY: 4, toX: 8 }) as ToolFailure;

        assert.equal(outcome.ok, false);
        assert.ok(outcome.error.indexOf("`toY`") >= 0);
    });
});

test("an x with no y is refused, and told about the gate-centred default", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = callTool({ x: 10 }) as ToolFailure;

        assert.equal(outcome.ok, false);
        assert.ok(outcome.error.indexOf("only `x`") >= 0);
        assert.ok(outcome.error.indexOf("gate") >= 0);
    });
});

test("a rectangle plus its margin can outgrow the cap, and is refused by measurement", function () {
    withGame(function () { /* empty */ }, function () {
        const outcome = callTool({ fromX: 5, fromY: 5, toX: 45, toY: 9, margin: 3 }) as ToolFailure;

        assert.equal(outcome.ok, false);
        assert.ok(outcome.error.indexOf("47 by 11") >= 0,
            "the numbers in the refusal are the drawn size, margin included: " + outcome.error);
    }, 64);
});

test("size on its own resizes the gate-centred square", function () {
    withGame(function (game) {
        game.addParkEntrance(18, 20);
    }, function () {
        const view = drawn(callTool({ size: 7 }) as MapViewOutcome);

        assert.equal(view.area.toX - view.area.fromX + 1, 7);
        assert.equal(view.area.toY - view.area.fromY + 1, 7);
    });
});

test("a busy window of the default size stays inside a thousand characters", function () {
    // Charged on every turn it is called, into a 64k context that gets compacted, so this
    // is a budget rather than a nicety.
    withGame(function (game) {
        addRide(game, 0);

        for (let x = 12; x <= 15; x++) {
            for (let y = 12; y <= 15; y++) {
                addTrack(game, x, y, 0);
            }
        }

        for (let y = 5; y <= 25; y++) {
            game.addPath(20, y);
        }

        for (let i = 0; i < 40; i++) {
            game.addScenery(10 + (i * 7) % 15, 10 + (i * 11) % 15);
        }
    }, function () {
        const view = drawn(callTool({ x: 17, y: 17 }) as MapViewOutcome);
        const wire = JSON.stringify(view).length;

        assert.ok(wire < 1000, "a " + String(DEFAULT_VIEW_SIZE) + " square came to " + String(wire)
            + " characters; the budget for this is a few hundred tokens");
    });
});

// ---------------------------------------------------------------------------
// Ownership, which one character has to carry for paving because paving is the one
// built thing the park lays, replaces and joins onto.
// ---------------------------------------------------------------------------

/**
 * Forest Frontiers, in the shape that cost a run 2,400 pounds.
 *
 * The park's entrance corridor is footpath on land the park neither owns nor can buy, and
 * it runs west out of the park to the gate. Inside the boundary the same line is the park's
 * own trunk walk. Both drew as `P`, so the picture said the park's walk ran eight tiles
 * further west than it does; the model bought land towards a path that was never the
 * park's, said in its own words that a path on non-park land "doesn't make sense", and had
 * nothing in the render it could use to settle it.
 *
 * The owned empty ground beside the corridor is the other half of the lie: `.` next to `P`
 * reads as "pave from here to there", and here there is no there.
 */
function entranceCorridorPark(game: FakeGame): void {
    for (let x = 0; x < 40; x++) {
        for (let y = 0; y < 40; y++) {
            game.own(x, y, x >= 12 && x <= 20 && y >= 8 && y <= 14);
        }
    }

    for (let x = 4; x <= 11; x++) {
        game.addPath(x, 11);          // the corridor: paving, and not the park's
    }

    for (let x = 12; x <= 18; x++) {
        game.addPath(x, 11);          // the trunk: the park's own walk
    }
}

test("a footpath on land the park does not own is a different character from one on its own", function () {
    withGame(entranceCorridorPark, function () {
        const view = drawn(renderMapView({ left: 4, top: 9, right: 21, bottom: 13 }));

        assert.equal(cellAt(view, 8, 11), "=", "the entrance corridor is paving the park does not own");
        assert.equal(cellAt(view, 15, 11), "P", "the trunk inside the boundary is the park's own walk");
        assert.notEqual(cellAt(view, 8, 11), cellAt(view, 15, 11),
            "one character has to tell these apart: before it did not, and the model bought land"
            + " to reach a path that was never the park's");

        // The exact geometry, so a render that is right in kind and wrong by two columns -
        // which is what the model read - cannot pass.
        assert.equal(countOf(view, "="), 8, "the corridor is x 4 to 11 at y 11 and nothing else");
        assert.equal(countOf(view, "P"), 7, "the trunk is x 12 to 18 at y 11 and nothing else");

        assert.equal(cellAt(view, 11, 11), "=", "the last corridor tile before the boundary");
        assert.equal(cellAt(view, 12, 11), "P", "and the first tile of the park's own walk");

        // The configuration that lied: unowned paving with the park's own empty ground
        // beside it. Both facts have to survive into the picture.
        assert.equal(cellAt(view, 12, 10), ".", "the park's ground, flat and empty, beside the corridor's end");
        assert.equal(cellAt(view, 8, 10), "-", "and the ground beside the corridor itself is not the park's");
        assert.equal(cellAt(view, 19, 11), ".", "past the trunk the park's ground is empty again");
    });
});

test("the legend names the ownership of the paving that was actually drawn, and no other", function () {
    withGame(entranceCorridorPark, function () {
        const both = drawn(renderMapView({ left: 4, top: 9, right: 21, bottom: 13 }));

        assert.ok(both.legend.indexOf("= path, not the park's land") >= 0,
            "a character in the grid the legend does not explain is a character the model invents a meaning for");
        assert.ok(both.legend.indexOf("P path on the park's land") >= 0,
            "and `P` has to say it is the park's, or `P` alone still reads as `any path`");

        // Generated from what rendered, not printed as a fixed list: a window holding only
        // the park's own walk must not offer the model a `=` to find in it.
        const trunkOnly = drawn(renderMapView({ left: 13, top: 9, right: 18, bottom: 13 }));
        assert.equal(countOf(trunkOnly, "P"), 6, "this window is the trunk and nothing else");
        assert.equal(countOf(trunkOnly, "="), 0);
        assert.ok(trunkOnly.legend.indexOf("= path") < 0, "no unowned paving is in view, so none is explained");
        assert.ok(trunkOnly.legend.indexOf("P path on the park's land") >= 0);

        const corridorOnly = drawn(renderMapView({ left: 5, top: 9, right: 10, bottom: 13 }));
        assert.equal(countOf(corridorOnly, "="), 6, "this window is the corridor and nothing else");
        assert.equal(countOf(corridorOnly, "P"), 0,
            "the corridor must not borrow the character that means the park's own walk");
        assert.ok(corridorOnly.legend.indexOf("= path, not the park's land") >= 0);
        assert.ok(corridorOnly.legend.indexOf("P path on the park's land") < 0);
    });
});

test("a queue on land the park does not own is a different character from its own queue", function () {
    withGame(function (game) {
        game.addPath(10, 10, true);
        game.own(12, 10, false);
        game.addPath(12, 10, true);
    }, function () {
        const view = drawn(renderMapView({ left: 8, top: 8, right: 14, bottom: 12 }));

        assert.equal(cellAt(view, 10, 10), "Q", "the park's own queue");
        assert.equal(cellAt(view, 12, 10), ":", "a queue on ground the park does not own");
        assert.notEqual(cellAt(view, 10, 10), cellAt(view, 12, 10));
        assert.equal(countOf(view, "Q"), 1, "the unowned queue must not also count as the park's");
        assert.equal(countOf(view, ":"), 1);
        assert.ok(view.legend.indexOf(": queue, not the park's land") >= 0);
        assert.ok(view.legend.indexOf("Q queue on the park's land") >= 0);
    });
});
