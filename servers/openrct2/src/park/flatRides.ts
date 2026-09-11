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
export interface Offset {
    dx: number;
    dy: number;
}

/**
 * Tiles a flat ride covers, relative to the origin passed to `trackplace`.
 *
 * Verified in game: a 1x1 stall covers only its origin, and a 1x4 Ferris Wheel placed
 * at rotation 0 covers -2..+1 along x. So a run of N tiles spans -floor(N/2) to
 * N-1-floor(N/2), which also matches the 3x3 case where the origin is the centre.
 * Odd rotations swap the two axes.
 */
export function footprintOffsets(shape: FlatRideShape, rotation: number): Offset[] {
    const alongX = (rotation % 2) === 0 ? shape.depth : shape.width;
    const alongY = (rotation % 2) === 0 ? shape.width : shape.depth;

    const firstX = -Math.floor(alongX / 2);
    const firstY = -Math.floor(alongY / 2);
    const offsets: Offset[] = [];

    for (let dx = firstX; dx < firstX + alongX; dx++) {
        for (let dy = firstY; dy < firstY + alongY; dy++) {
            offsets.push({ dx: dx, dy: dy });
        }
    }

    return offsets;
}

/** Tiles orthogonally touching the footprint: every place an entrance or exit can go. */
export function perimeterOffsets(offsets: Offset[]): Offset[] {
    const inside: Record<string, boolean> = {};

    for (let i = 0; i < offsets.length; i++) {
        inside[String(offsets[i].dx) + "," + String(offsets[i].dy)] = true;
    }

    const seen: Record<string, boolean> = {};
    const perimeter: Offset[] = [];
    const steps = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

    for (let i = 0; i < offsets.length; i++) {
        for (let s = 0; s < steps.length; s++) {
            const dx = offsets[i].dx + steps[s].dx;
            const dy = offsets[i].dy + steps[s].dy;
            const key = String(dx) + "," + String(dy);

            if (inside[key] || seen[key]) {
                continue;
            }

            seen[key] = true;
            perimeter.push({ dx: dx, dy: dy });
        }
    }

    return perimeter;
}
