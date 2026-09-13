import { readMapGrid, toWorld } from "./map.js";

const STEP_DELAY_MS = 200;

/**
 * GameActions::Status::InsufficientFunds. The game answers a removal it will not fund with
 * this and a message naming the price, and the refusal looks from the outside exactly like
 * a tile nothing would ever clear.
 */
const INSUFFICIENT_FUNDS = 4;

/** Everything this tool ever asks the game to take down. Nothing else is touched. */
const REMOVABLE_TYPES: Record<string, boolean> = {
    small_scenery: true,
    large_scenery: true,
    wall: true,
    banner: true
};

/**
 * Whether a tile carries anything this tool would remove.
 *
 * Called once before the removals and once after, because the difference between the two
 * readings is the only thing that says how much ground actually changed. Counting the
 * rectangle instead reported five tiles cleared where the game's own census moved by four.
 */
function hasScenery(x: number, y: number): boolean {
    const tile = map.getTile(x, y);

    for (let i = 0; i < tile.numElements; i++) {
        if (REMOVABLE_TYPES[tile.getElement(i).type]) {
            return true;
        }
    }

    return false;
}

/** A rectangle of tiles, both corners included. */
export interface TileRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ClearAreaOutcome {
    ok: boolean;
    tilesRequested: number;
    /** Tiles that carried scenery when the call started and carry none now: what this call
     *  actually changed, counted off the map afterwards. Not the size of the rectangle. */
    tilesCleared: number;
    /** Tiles of the rectangle that had nothing on them to take down in the first place.
     *  `tilesRequested` minus this is the most any call could ever have cleared, and the
     *  bare tiles among them are ground the model has no other way of knowing was bare. */
    tilesNothingToClear: number;
    /** Tiles still not bare, for whatever reason: the sum of the three counts below. */
    tilesStillBlocked: number;
    /** Tiles a ride, a path or a park structure stands on. Nothing here removes those. */
    tilesOccupied: number;
    /** Tiles whose scenery is still standing because the game refused to take it down.
     *  A different problem from an occupied tile and usually a cheaper one: `refusals`
     *  carries the game's own words for it. */
    tilesRefused: number;
    /** Tiles outside the park's land. */
    tilesOutsidePark: number;
    /** The game's reason for each refusal, in its own words, one entry per distinct reason. */
    refusals: string[];
    /** True when at least one refusal was the game saying the park cannot pay for it. */
    notEnoughCash: boolean;
    /** The tiles this call actually worked on, whichever form asked for them. A square
     *  centred on a site's origin is not the site's footprint, so the caller can see which
     *  ground was taken rather than assuming it got the one it meant. */
    area: TileRect;
    detail: string;
}

/** The rectangle a square of `size` tiles centred on `cx`,`cy` covers. */
export function centredSquare(cx: number, cy: number, size: number): TileRect {
    // A square of n is n tiles across, starting floor(n/2) tiles before its centre. A
    // naive -half..+half loop spans n+1 on even sizes: asking for 4 felled 25 trees.
    const first = Math.floor(size / 2);

    return { left: cx - first, top: cy - first, right: cx - first + size - 1, bottom: cy - first + size - 1 };
}

/** Either pair of opposite corners, put the right way round. */
export function normaliseRect(area: TileRect): TileRect {
    return {
        left: Math.min(area.left, area.right),
        top: Math.min(area.top, area.bottom),
        right: Math.max(area.left, area.right),
        bottom: Math.max(area.top, area.bottom)
    };
}

/** How many tiles a rectangle covers, counted before anything is removed. */
export function rectTileCount(area: TileRect): number {
    const bounds = normaliseRect(area);

    return (bounds.right - bounds.left + 1) * (bounds.bottom - bounds.top + 1);
}

/** The game's own words for a refusal. Same shape `src/park/build.ts` quotes them in. */
function actionError(result: GameActionResult): string {
    return (result.errorTitle || "") + (result.errorMessage ? ": " + result.errorMessage : "");
}

/**
 * Removes scenery, walls and banners from a rectangle of tiles, both corners included.
 * Nothing else is touched: rides, paths and park structures are left alone and reported as
 * still blocking.
 *
 * A rectangle rather than a centred square because a centred square cannot describe a
 * ride's footprint. `describe_placement` reports a placement's origin, and a flat ride is not
 * centred on it: a 4x4 runs 0..3 from the origin, a 2x2 runs 0..1, a 1x4 runs -2..+1.
 * `centredSquare` is still the shape for ordinary ground, and turns into one of these.
 *
 * A tile that is still not bare afterwards is sorted by what the world says about it, not
 * by assumption. `clearable` says whether what survived is scenery or a structure, so a
 * refused removal is never reported as a ride standing on the ground; and the game's own
 * answer to each removal is kept, so the refusal is quoted rather than guessed at. Told
 * "occupied by a ride" when the truth was "Not enough cash", a model bulldozes elsewhere
 * and never learns it only needed money.
 */
export function clearRect(area: TileRect, done: (outcome: ClearAreaOutcome) => void): void {
    const bounds = normaliseRect(area);
    const tiles: { x: number; y: number }[] = [];
    /** Every refusal the game gave, keyed by the tile it was asked about. */
    const refused: Record<string, GameActionResult[]> = {};
    /** Which tiles had something to take down, read before a single action is fired. */
    const hadScenery: boolean[] = [];

    for (let x = bounds.left; x <= bounds.right; x++) {
        for (let y = bounds.top; y <= bounds.bottom; y++) {
            tiles.push({ x: x, y: y });
        }
    }

    const recorder = function (key: string): (result: GameActionResult) => void {
        return function (result) {
            if (!result || !result.error) {
                return;
            }

            if (!refused[key]) {
                refused[key] = [];
            }

            refused[key].push(result);
        };
    };

    for (let i = 0; i < tiles.length; i++) {
        const tile = map.getTile(tiles[i].x, tiles[i].y);
        const x = toWorld(tiles[i].x);
        const y = toWorld(tiles[i].y);
        const record = recorder(String(tiles[i].x) + "," + String(tiles[i].y));

        hadScenery.push(hasScenery(tiles[i].x, tiles[i].y));

        for (let e = 0; e < tile.numElements; e++) {
            const element = tile.getElement(e);

            if (element.type === "small_scenery") {
                const scenery = element as SmallSceneryElement;
                context.executeAction("smallsceneryremove", {
                    x: x, y: y, z: scenery.baseZ, object: scenery.object, quadrant: scenery.quadrant
                }, record);
            } else if (element.type === "large_scenery") {
                const scenery = element as LargeSceneryElement;
                context.executeAction("largesceneryremove", {
                    x: x, y: y, z: scenery.baseZ, direction: scenery.direction, tileIndex: scenery.sequence
                }, record);
            } else if (element.type === "banner") {
                const banner = element as BannerElement;
                context.executeAction("bannerremove", {
                    x: x, y: y, z: banner.baseZ, direction: banner.direction
                }, record);
            } else if (element.type === "wall") {
                const wall = element as WallElement;
                context.executeAction("wallremove", {
                    x: x, y: y, z: wall.baseZ, direction: wall.direction
                }, record);
            }
        }
    }

    context.setTimeout(function () {
        const grid = readMapGrid();
        let occupied = 0;
        let stillThere = 0;
        let unowned = 0;
        let cleared = 0;
        let nothingToClear = 0;
        let notEnoughCash = false;
        const reasons: string[] = [];

        const noteReason = function (text: string): void {
            if (reasons.indexOf(text) < 0) {
                reasons.push(text);
            }
        };

        for (let i = 0; i < tiles.length; i++) {
            const cell = grid.at(tiles[i].x, tiles[i].y);

            // Counted off the two readings, not off the request: a tile that was already
            // bare was never cleared by this call, however cleanly the rectangle came back.
            if (!hadScenery[i]) {
                nothingToClear++;
            } else if (!hasScenery(tiles[i].x, tiles[i].y)) {
                cleared++;
            }

            if (!cell || !cell.owned) {
                unowned++;
                continue;
            }

            if (cell.clear) {
                continue;
            }

            // What survived decides which problem this is. Only scenery left means the
            // removal was turned down; anything else means a ride, a path or a structure
            // is standing there and no bulldozing was ever going to move it.
            if (!cell.clearable) {
                occupied++;
                continue;
            }

            stillThere++;
            const answers = refused[String(tiles[i].x) + "," + String(tiles[i].y)] || [];

            for (let a = 0; a < answers.length; a++) {
                if (answers[a].error === INSUFFICIENT_FUNDS) {
                    notEnoughCash = true;
                }

                noteReason(actionError(answers[a]));
            }

            if (answers.length === 0) {
                noteReason("the game accepted the removal without an error and the scenery is still standing");
            }
        }

        const blocked = occupied + stillThere + unowned;
        const parts: string[] = [];

        // Always "n of m", never a bare count: "Cleared 5 tiles" for a five-tile rectangle
        // with scenery on four of them reads as the size of the rectangle, which is the
        // number that was wrong, and left the model's idea of the ground one tile out of
        // step with the park's own census with nothing it could call to find out why.
        parts.push("Cleared " + String(cleared) + " of the " + String(tiles.length) + " tiles asked for.");

        if (nothingToClear > 0) {
            parts.push(String(nothingToClear) + " of them had no scenery, wall or banner on it to take down.");
        }

        if (unowned > 0) {
            parts.push(String(unowned) + " of " + String(tiles.length) + " tiles are outside the park's land.");
        }

        if (occupied > 0) {
            parts.push(String(occupied) + " of " + String(tiles.length)
                + " are occupied by something that is not scenery - a ride, a path or a park structure."
                + " Those have to be removed on their own terms.");
        }

        if (stillThere > 0) {
            parts.push("The game would not take the scenery down on " + String(stillThere) + " of "
                + String(tiles.length) + " tiles. It said: " + reasons.join("; ") + ".");
        }

        done({
            ok: blocked === 0,
            tilesRequested: tiles.length,
            tilesCleared: cleared,
            tilesNothingToClear: nothingToClear,
            tilesStillBlocked: blocked,
            tilesOccupied: occupied,
            tilesRefused: stillThere,
            tilesOutsidePark: unowned,
            refusals: reasons,
            notEnoughCash: notEnoughCash,
            area: bounds,
            detail: parts.join(" ")
        });
    }, STEP_DELAY_MS);
}
