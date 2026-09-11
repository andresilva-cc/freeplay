import { readMapGrid, toWorld } from "./map.js";

const STEP_DELAY_MS = 200;

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
    /** Tiles still not bare: occupied by something unremovable, or outside the park. */
    tilesStillBlocked: number;
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

/**
 * Removes scenery, walls and banners from a rectangle of tiles, both corners included.
 * Nothing else is touched: rides, paths and park structures are left alone and reported as
 * still blocking.
 *
 * A rectangle rather than a centred square because a centred square cannot describe a
 * ride's footprint. `find_build_sites` reports a site's origin, and a flat ride is not
 * centred on it: a 4x4 runs 0..3 from the origin, a 2x2 runs 0..1, a 1x4 runs -2..+1.
 * `centredSquare` is still the shape for ordinary ground, and turns into one of these.
 */
export function clearRect(area: TileRect, done: (outcome: ClearAreaOutcome) => void): void {
    const bounds = normaliseRect(area);
    const tiles: { x: number; y: number }[] = [];

    for (let x = bounds.left; x <= bounds.right; x++) {
        for (let y = bounds.top; y <= bounds.bottom; y++) {
            tiles.push({ x: x, y: y });
        }
    }

    for (let i = 0; i < tiles.length; i++) {
        const tile = map.getTile(tiles[i].x, tiles[i].y);
        const x = toWorld(tiles[i].x);
        const y = toWorld(tiles[i].y);

        for (let e = 0; e < tile.numElements; e++) {
            const element = tile.getElement(e);

            if (element.type === "small_scenery") {
                const scenery = element as SmallSceneryElement;
                context.executeAction("smallsceneryremove", {
                    x: x, y: y, z: scenery.baseZ, object: scenery.object, quadrant: scenery.quadrant
                }, function () { /* verified by re-read */ });
            } else if (element.type === "large_scenery") {
                const scenery = element as LargeSceneryElement;
                context.executeAction("largesceneryremove", {
                    x: x, y: y, z: scenery.baseZ, direction: scenery.direction, tileIndex: scenery.sequence
                }, function () { /* verified by re-read */ });
            } else if (element.type === "banner") {
                const banner = element as BannerElement;
                context.executeAction("bannerremove", {
                    x: x, y: y, z: banner.baseZ, direction: banner.direction
                }, function () { /* verified by re-read */ });
            } else if (element.type === "wall") {
                const wall = element as WallElement;
                context.executeAction("wallremove", {
                    x: x, y: y, z: wall.baseZ, direction: wall.direction
                }, function () { /* verified by re-read */ });
            }
        }
    }

    context.setTimeout(function () {
        const grid = readMapGrid();
        let blocked = 0;
        let unowned = 0;

        for (let i = 0; i < tiles.length; i++) {
            const cell = grid.at(tiles[i].x, tiles[i].y);

            if (!cell || !cell.owned) {
                unowned++;
                continue;
            }

            if (!cell.clear) {
                blocked++;
            }
        }

        done({
            ok: blocked === 0 && unowned === 0,
            tilesRequested: tiles.length,
            tilesStillBlocked: blocked + unowned,
            area: bounds,
            detail: (blocked === 0 && unowned === 0
                ? "Cleared " + String(tiles.length) + " tiles."
                : "")
                + (unowned > 0
                    ? String(unowned) + " of " + String(tiles.length) + " tiles are outside the park's land."
                    : "")
                + (blocked > 0
                    ? " " + String(blocked) + " are occupied by something that is not scenery - a ride, a path or a"
                        + " park structure. Those have to be removed on their own terms."
                    : "")
        });
    }, STEP_DELAY_MS);
}
