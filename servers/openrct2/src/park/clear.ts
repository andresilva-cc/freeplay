import { readMapGrid, toWorld } from "./map.js";

const STEP_DELAY_MS = 200;

export interface ClearAreaOutcome {
    ok: boolean;
    tilesRequested: number;
    tilesStillBlocked: number;
    detail: string;
}

/**
 * Removes scenery, walls and banners from a square. Nothing else is touched: rides,
 * paths and park structures are left alone and reported as still blocking.
 */
export function clearArea(cx: number, cy: number, size: number, done: (outcome: ClearAreaOutcome) => void): void {
    const half = Math.floor(size / 2);
    const tiles: { x: number; y: number }[] = [];

    for (let dx = -half; dx <= half; dx++) {
        for (let dy = -half; dy <= half; dy++) {
            tiles.push({ x: cx + dx, y: cy + dy });
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

        for (let i = 0; i < tiles.length; i++) {
            const cell = grid.at(tiles[i].x, tiles[i].y);

            if (!cell || !cell.clear) {
                blocked++;
            }
        }

        done({
            ok: blocked === 0,
            tilesRequested: tiles.length,
            tilesStillBlocked: blocked,
            detail: blocked === 0
                ? "Cleared " + String(tiles.length) + " tiles."
                : String(blocked) + " of " + String(tiles.length) + " tiles are still occupied by something that is not"
                    + " scenery - a ride, a path or a park structure. Those have to be removed on their own terms."
        });
    }, STEP_DELAY_MS);
}
