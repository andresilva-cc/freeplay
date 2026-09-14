/**
 * Which flat rides can be placed as a single piece, how much room each needs, and
 * whether it is a shop. Generated from OpenRCT2's RideTypeDescriptor values: the
 * plugin API exposes none of this, and guessing fails placement with no useful error.
 */

export interface FlatRideShape {
    /** Footprint in tiles. Equal width and depth means it fits a square site. */
    width: number;
    depth: number;
    /** Track piece the game uses to place this ride in one action. */
    trackType: number;
    /** Shops and stalls have no entrance or exit: guests buy from the path beside them. */
    isShop: boolean;
    name: string;
}

const FLAT_RIDE_SHAPES: Record<number, FlatRideShape | undefined> = {
    21: { width: 2, depth: 2, trackType: 258, isShop: false, name: "spiral_slide" },
    25: { width: 4, depth: 4, trackType: 259, isShop: false, name: "dodgems" },
    26: { width: 1, depth: 5, trackType: 261, isShop: false, name: "swinging_ship" },
    27: { width: 1, depth: 4, trackType: 263, isShop: false, name: "swinging_inverter_ship" },
    28: { width: 1, depth: 1, trackType: 262, isShop: true, name: "food_stall" },
    30: { width: 1, depth: 1, trackType: 262, isShop: true, name: "drink_stall" },
    32: { width: 1, depth: 1, trackType: 262, isShop: true, name: "shop" },
    33: { width: 3, depth: 3, trackType: 266, isShop: false, name: "merry_go_round" },
    35: { width: 1, depth: 1, trackType: 264, isShop: true, name: "information_kiosk" },
    36: { width: 1, depth: 1, trackType: 262, isShop: true, name: "toilets" },
    37: { width: 1, depth: 4, trackType: 265, isShop: false, name: "ferris_wheel" },
    38: { width: 2, depth: 2, trackType: 258, isShop: false, name: "motion_simulator" },
    39: { width: 3, depth: 3, trackType: 266, isShop: false, name: "3d_cinema" },
    40: { width: 3, depth: 3, trackType: 266, isShop: false, name: "top_spin" },
    41: { width: 3, depth: 3, trackType: 266, isShop: false, name: "space_rings" },
    45: { width: 1, depth: 1, trackType: 262, isShop: true, name: "cash_machine" },
    46: { width: 3, depth: 3, trackType: 266, isShop: false, name: "twist" },
    47: { width: 3, depth: 3, trackType: 266, isShop: false, name: "haunted_house" },
    48: { width: 1, depth: 1, trackType: 262, isShop: true, name: "first_aid" },
    49: { width: 3, depth: 3, trackType: 266, isShop: false, name: "circus" },
    70: { width: 4, depth: 4, trackType: 259, isShop: false, name: "flying_saucers" },
    71: { width: 3, depth: 3, trackType: 266, isShop: false, name: "crooked_house" },
    77: { width: 1, depth: 4, trackType: 257, isShop: false, name: "magic_carpet" },
    81: { width: 4, depth: 4, trackType: 259, isShop: false, name: "enterprise" }
};

/** The shape of a flat ride, or undefined when this ride type needs track laid piece by piece. */
export function flatRideShape(rideType: number): FlatRideShape | undefined {
    return FLAT_RIDE_SHAPES[rideType];
}

/**
 * Every ride type the table describes.
 *
 * Exists so a test can walk the whole table instead of the handful of rows anyone
 * remembered to name. A row nothing reads is a row any `trackType` satisfies, and a wrong
 * `trackType` builds nothing while the game still reports the ride as constructed.
 */
export function flatRideTypes(): number[] {
    return Object.keys(FLAT_RIDE_SHAPES).map(function (key) { return Number(key); });
}

/**
 * The one tile a shop or stall is served from: its neighbour in the direction it is
 * rotated to face. 0 is -x, 1 is +y, 2 is +x, 3 is -y, the game's own TileDirectionDelta.
 *
 * Measured, not reasoned: a rotation-1 stall was ringed with footpath on all four sides in
 * the running game, and only the +y tile formed a footpath edge to it. The other three
 * touch the building and serve nobody. Exported rather than inlined because park/status.ts
 * answers the neighbouring question - whether guests can reach a stall that is already
 * built - and the two have to be able to agree on one rule.
 */
export function shopServingTile(x: number, y: number, rotation: number): { x: number; y: number } {
    const turns = ((rotation % 4) + 4) % 4;
    const deltas = [{ dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }];

    return { x: x + deltas[turns].dx, y: y + deltas[turns].dy };
}
export interface Offset {
    dx: number;
    dy: number;
}

/**
 * Tiles a flat ride covers, relative to the origin passed to `trackplace`.
 *
 * Read from the game, because there is no formula. A 3x3 is centred on its origin
 * (-1..+1) and so is a 1x4 (-2..+1), but a 4x4 runs 0..3 from its origin and a 2x4 is
 * centred on neither axis. Assuming a rule put a dodgems' entrance three tiles clear of
 * the ride, with every check agreeing it was adjacent.
 *
 * `computeFootprintOffsets` remains as a fallback for when the game is not there.
 */
export function footprintOffsets(shape: FlatRideShape, rotation: number): Offset[] {
    const fromGame = segmentOffsets(shape.trackType, rotation);
    return fromGame === null ? computeFootprintOffsets(shape, rotation) : fromGame;
}

/**
 * The piece's own tile offsets, turned to face `rotation`.
 *
 * One turn is (dx, dy) -> (dy, -dx), which is what OpenRCT2's `CoordsXY::rotate` does to
 * every block of a piece in `TrackPlaceAction`, and the turn that carries direction 0's
 * tile delta onto direction 1's. Turning the other way is indistinguishable on anything
 * symmetric about its origin - a 3x3, a 1x5, a 1x1 - and off by one tile on everything
 * else, which put entrances diagonal to 1x4 rides and evaluated a 4x4's buildability on
 * sixteen tiles the ride was never going to occupy.
 */
export function segmentOffsets(trackType: number, rotation: number): Offset[] | null {
    if (typeof context === "undefined" || typeof context.getTrackSegment !== "function") {
        return null;
    }

    const segment = context.getTrackSegment(trackType);

    if (!segment || !segment.elements || segment.elements.length === 0) {
        return null;
    }

    const turns = ((rotation % 4) + 4) % 4;
    const offsets: Offset[] = [];

    for (let i = 0; i < segment.elements.length; i++) {
        let dx = segment.elements[i].x / 32;
        let dy = segment.elements[i].y / 32;

        for (let t = 0; t < turns; t++) {
            const spun = { dx: dy, dy: -dx };
            dx = spun.dx;
            dy = spun.dy;
        }

        offsets.push({ dx: dx || 0, dy: dy || 0 });
    }

    return offsets;
}

/** The shape a footprint would have if pieces followed a rule. They do not. */
export function computeFootprintOffsets(shape: FlatRideShape, rotation: number): Offset[] {
    const alongX = (rotation % 2) === 0 ? shape.depth : shape.width;
    const alongY = (rotation % 2) === 0 ? shape.width : shape.depth;

    // `|| 0` because -Math.floor(1 / 2) is -0, which leaks into every returned offset.
    const firstX = -Math.floor(alongX / 2) || 0;
    const firstY = -Math.floor(alongY / 2) || 0;
    const offsets: Offset[] = [];

    for (let dx = firstX; dx < firstX + alongX; dx++) {
        for (let dy = firstY; dy < firstY + alongY; dy++) {
            offsets.push({ dx: dx || 0, dy: dy || 0 });
        }
    }

    return offsets;
}

/**
 * Tiles orthogonally touching the footprint: every place an entrance or exit can go, walked
 * round the footprint rather than emitted in whatever order the footprint's own tiles came in.
 *
 * It used to step {+x, -x, +y, -y} off each footprint tile in turn, and everything that reads
 * this called the result "the order the tiles ring the footprint" - which it was not. The
 * practical effect was that the first option was the +x face of the ride every single time,
 * and the first option is the one the model takes: 12 of 12 measured builds. A stated order
 * that is not the order is worse than either, because it is what a reader checks against.
 *
 * So it is a real walk now: clockwise round the box one tile outside the footprint, starting
 * at its -y side, then +x, then +y, then -x. Adjacent entries are adjacent on the ground,
 * which is what makes the `side` of two options readable side by side.
 *
 * This still picks a default - any fixed order does, and the first entry is now always on the
 * -y face instead of always on the +x face. Nothing here can fix that; what it can do is not
 * claim the order means anything. The count is in `accessTotal`, the faces are in `side`, and
 * nothing is sorted.
 *
 * The trailing sweep is for a footprint that is not a filled rectangle: nothing in the table
 * is one today, and a perimeter tile in a notch would otherwise be dropped rather than
 * reported last. A position left out of this list is a door position nothing ever offers.
 */
export function perimeterOffsets(offsets: Offset[]): Offset[] {
    const inside: Record<string, boolean> = {};
    let minDx = offsets[0].dx;
    let minDy = offsets[0].dy;
    let maxDx = offsets[0].dx;
    let maxDy = offsets[0].dy;

    for (let i = 0; i < offsets.length; i++) {
        inside[String(offsets[i].dx) + "," + String(offsets[i].dy)] = true;
        minDx = Math.min(minDx, offsets[i].dx);
        minDy = Math.min(minDy, offsets[i].dy);
        maxDx = Math.max(maxDx, offsets[i].dx);
        maxDy = Math.max(maxDy, offsets[i].dy);
    }

    const touching: Record<string, boolean> = {};
    const steps = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

    for (let i = 0; i < offsets.length; i++) {
        for (let s = 0; s < steps.length; s++) {
            const dx = offsets[i].dx + steps[s].dx;
            const dy = offsets[i].dy + steps[s].dy;
            const key = String(dx) + "," + String(dy);

            if (!inside[key]) {
                touching[key] = true;
            }
        }
    }

    const perimeter: Offset[] = [];
    const taken: Record<string, boolean> = {};
    const take = function (dx: number, dy: number): void {
        const key = String(dx) + "," + String(dy);

        if (!touching[key] || taken[key]) {
            return;
        }

        taken[key] = true;
        perimeter.push({ dx: dx || 0, dy: dy || 0 });
    };

    const ringMinX = minDx - 1;
    const ringMaxX = maxDx + 1;
    const ringMinY = minDy - 1;
    const ringMaxY = maxDy + 1;

    for (let dx = ringMinX; dx <= ringMaxX; dx++) {
        take(dx, ringMinY);
    }

    for (let dy = ringMinY + 1; dy <= ringMaxY; dy++) {
        take(ringMaxX, dy);
    }

    for (let dx = ringMaxX - 1; dx >= ringMinX; dx--) {
        take(dx, ringMaxY);
    }

    for (let dy = ringMaxY - 1; dy > ringMinY; dy--) {
        take(ringMinX, dy);
    }

    for (let i = 0; i < offsets.length; i++) {
        for (let s = 0; s < steps.length; s++) {
            take(offsets[i].dx + steps[s].dx, offsets[i].dy + steps[s].dy);
        }
    }

    return perimeter;
}
