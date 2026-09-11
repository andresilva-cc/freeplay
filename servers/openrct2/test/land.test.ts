import assert from "node:assert/strict";
import test from "node:test";

import { FakeGame } from "./fakeGame.ts";
import { buyLand } from "../src/park/land.ts";
import type { BuyLandOutcome } from "../src/park/land.ts";
import type { TileRect } from "../src/park/clear.ts";
import { getMcpToolDefinitions } from "../src/tools/decorators.ts";
import { getMcpTools } from "../src/tools/index.ts";
import { LandTools } from "../src/tools/land.ts";
import type { DeferredMcpResult } from "../src/tools/types.ts";

function withGame(build: (game: FakeGame) => void, run: (game: FakeGame) => void, options?: { inert?: boolean }): void {
    const game = new FakeGame(24, 24, options);
    build(game);
    const restore = game.install();

    try {
        run(game);
    } finally {
        restore();
    }
}

/** `context.setTimeout` applies the queued actions, so the outcome is ready on return. */
function buy(area: TileRect): BuyLandOutcome {
    let outcome: BuyLandOutcome | null = null;

    buyLand(area, function (result) { outcome = result; });

    assert.ok(outcome, "buyLand never called back");
    return outcome as unknown as BuyLandOutcome;
}

/** The same call as the model makes it: raw arguments, through the MCP tool layer. */
function callTool(args: Record<string, unknown>): BuyLandOutcome {
    let outcome: BuyLandOutcome | null = null;

    (new LandTools().buyLand(args) as DeferredMcpResult).start(function (result) {
        outcome = result as BuyLandOutcome;
    });

    assert.ok(outcome, "buy_land never answered");
    return outcome as unknown as BuyLandOutcome;
}

function owns(game: FakeGame, x: number, y: number): boolean {
    return game.tile(x, y).elements[0].hasOwnership === true;
}

/** Every tile of a rectangle unowned, and marked for sale unless told otherwise. */
function offerForSale(game: FakeGame, area: TileRect, forSale = true): void {
    for (let y = area.top; y <= area.bottom; y++) {
        for (let x = area.left; x <= area.right; x++) {
            game.own(x, y, false);
            game.putUpForSale(x, y, forSale);
        }
    }
}

test("a rectangle of tiles for sale becomes the park's, and is paid for", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 6 });
        game.parkValues.cash = 10000;
        game.parkValues.landPrice = 200;
    }, function (game) {
        buy({ left: 5, top: 5, right: 6, bottom: 6 });

        for (let y = 5; y <= 6; y++) {
            for (let x = 5; x <= 6; x++) {
                assert.equal(owns(game, x, y), true, "the park does not own " + String(x) + "," + String(y));
            }
        }

        assert.equal(game.parkValues.cash, 10000 - 4 * 200, "four tiles at 200 each have to leave the bank");
    });
});

test("tiles the scenario is not selling are left alone and named", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 6 });
        // 6,6 is unowned and not on the market, which is the ordinary case at a park edge.
        game.putUpForSale(6, 6, false);
        game.parkValues.cash = 10000;
        game.parkValues.landPrice = 200;
    }, function (game) {
        const outcome = buy({ left: 5, top: 5, right: 6, bottom: 6 });

        assert.equal(owns(game, 6, 6), false, "a tile that is not for sale must not change hands");
        assert.equal(owns(game, 5, 5), true, "the tiles that were for sale still have to be bought");
        assert.equal(game.parkValues.cash, 10000 - 3 * 200, "only the three that sold are paid for");
        assert.equal(outcome.ok, false, "the park does not own everything that was asked for");
        assert.equal(outcome.cost, 3 * 200,
            "cost is what the game charged for the three it sold, not the price of the rectangle");
        assert.deepEqual(outcome.notOwned, [{ x: 6, y: 6 }]);
        assert.match(outcome.detail, /not for sale/);
        assert.match(outcome.detail, /6,6/);
    });
});

test("a rectangle the park already owns costs nothing", function () {
    withGame(function (game) {
        game.parkValues.cash = 10000;
    }, function (game) {
        const outcome = buy({ left: 5, top: 5, right: 6, bottom: 6 });

        assert.equal(game.parkValues.cash, 10000, "already-owned tiles are skipped, not bought again");
        assert.equal(outcome.ok, true);
        assert.equal(outcome.tilesBought, 0);
        assert.match(outcome.detail, /already owned/);
    });
});

test("a purchase the park cannot afford buys no part of the rectangle", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 6 });
        game.parkValues.landPrice = 200;
        // Enough for three tiles of the four, which the game turns down in one piece.
        game.parkValues.cash = 600;
    }, function (game) {
        const outcome = buy({ left: 5, top: 5, right: 6, bottom: 6 });

        for (let y = 5; y <= 6; y++) {
            for (let x = 5; x <= 6; x++) {
                assert.equal(owns(game, x, y), false,
                    "a refused purchase must leave " + String(x) + "," + String(y) + " unowned");
            }
        }

        assert.equal(game.parkValues.cash, 600, "nothing was bought, so nothing may be charged");
        assert.equal(outcome.ok, false);
        assert.equal(outcome.notOwned.length, 4,
            "`notOwned` means the park does not have them, not that they were unsellable");
        assert.match(outcome.detail, /Not enough cash/, "the game's own words, not a guess at the cause");
        assert.doesNotMatch(outcome.detail, /not for sale/,
            "the tiles were on the market; blaming the scenario would send the model to the wrong fix");
    });
});

test("a purchase the game never applied is reported as nothing bought", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 6 });
        game.parkValues.cash = 10000;
    }, function (game) {
        const outcome = buy({ left: 5, top: 5, right: 6, bottom: 6 });

        assert.equal(owns(game, 5, 5), false, "an inert game must leave the land unowned");
        assert.equal(outcome.ok, false, "nothing changed hands, so this is not ok");
        assert.equal(outcome.tilesBought, 0);
        assert.equal(outcome.tilesOwned, 0);
    }, { inert: true });
});

test("a rectangle larger than the ceiling is refused before the game is asked", function () {
    withGame(function (game) {
        offerForSale(game, { left: 0, top: 0, right: 19, bottom: 19 });
    }, function (game) {
        const outcome = callTool({ fromX: 0, fromY: 0, toX: 19, toY: 19 });

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /400/, "the refusal has to name the size that was asked for");
        assert.match(String(outcome.error), /256/, "and the ceiling");
        assert.equal(owns(game, 0, 0), false, "a refused call must not have bought anything");
        assert.deepEqual(game.attempted, [], "nor even asked the game");
    });
});

test("buy_land refuses a rectangle with a corner missing rather than squaring it off", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 6 });
    }, function (game) {
        const outcome = callTool({ fromX: 5, fromY: 5, toX: 6 });

        assert.equal(outcome.ok, false);
        assert.match(String(outcome.error), /`toY`/, "the missing corner has to be named");
        assert.equal(owns(game, 5, 5), false);
        assert.deepEqual(game.attempted, []);
    });
});

test("corners given the other way round buy the same rectangle", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 7, bottom: 7 });
        game.parkValues.cash = 10000;
        game.parkValues.landPrice = 100;
    }, function (game) {
        const outcome = callTool({ fromX: 7, fromY: 7, toX: 5, toY: 5 });

        assert.equal(owns(game, 5, 5), true);
        assert.equal(owns(game, 7, 7), true);
        assert.equal(game.parkValues.cash, 10000 - 9 * 100);
        assert.deepEqual(outcome.area, { left: 5, top: 5, right: 7, bottom: 7 });
    });
});

test("the scenario's land price is reported as the game states it", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 5, bottom: 5 });
        game.parkValues.cash = 10000;
        game.parkValues.landPrice = 450;
    }, function (game) {
        const outcome = buy({ left: 5, top: 5, right: 5, bottom: 5 });

        assert.equal(game.parkValues.cash, 10000 - 450, "one tile at the scenario's own price");
        assert.equal(outcome.landPrice, 450);
        assert.equal(outcome.cost, 450);
    });
});

test("buy_land is registered as a deferred tool called buy_land, with all four corners required", function () {
    const definitions = getMcpToolDefinitions(LandTools);

    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, "buy_land");
    assert.equal(definitions[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(definitions[0].inputSchema.properties || {}).sort(),
        ["fromX", "fromY", "toX", "toY"]);
    assert.deepEqual((definitions[0].inputSchema.required || []).slice().sort(),
        ["fromX", "fromY", "toX", "toY"],
        "all four are needed, so the MCP layer has to refuse a missing one by name before the tool runs");

    const registered = getMcpTools().filter(function (tool) { return tool.name === "buy_land"; });
    assert.equal(registered.length, 1, "the tool has to be in the registry or the model never sees it");

    const game = new FakeGame(8, 8);
    const restore = game.install();

    try {
        const deferred = new LandTools().buyLand({ fromX: 1, fromY: 1, toX: 1, toY: 1 }) as DeferredMcpResult;
        assert.equal(deferred.deferred, true, "the purchase lands on a later tick, so the tool has to wait");
    } finally {
        restore();
    }
});

test("buy_land sends the game one landbuyrights over the whole rectangle, in world coordinates", function () {
    withGame(function (game) {
        offerForSale(game, { left: 5, top: 5, right: 6, bottom: 7 });
        game.parkValues.cash = 10000;
    }, function (game) {
        buy({ left: 5, top: 5, right: 6, bottom: 7 });

        const sent = game.attempted.filter(function (action) { return action.name === "landbuyrights"; });

        assert.equal(sent.length, 1, "the game walks the rectangle itself; one action covers it");
        assert.deepEqual(sent[0].args, {
            x1: 160, y1: 160, x2: 192, y2: 224, setting: 0
        }, "tile coordinates are multiplied by 32, and setting 0 is buying land rather than build rights");
    });
});
