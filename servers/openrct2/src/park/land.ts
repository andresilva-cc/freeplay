import { normaliseRect } from "./clear.js";
import type { TileRect } from "./clear.js";
import { toWorld } from "./map.js";
import type { Tile } from "./paths.js";

const STEP_DELAY_MS = 200;

/** `LandBuyRightSetting::buyLand`. 1 is construction rights, which build nothing guests use. */
const SETTING_BUY_LAND = 0;

/**
 * OpenRCT2's `OWNERSHIP_*` bits, from `world/tile_element/SurfaceElement.h`.
 *
 * The plugin API hands the byte over raw as `SurfaceElement.ownership`, and it is the only
 * place the game says what a tile is on offer for. A tile still unowned after a purchase the
 * game accepted used to be reported as "not for sale", which was inferred from ownership not
 * having changed rather than read: a tile the scenario offers as construction rights is not
 * for sale *as land*, which is what `setting: 0` asks for, and the old wording said something
 * about the scenario that the scenario had not said.
 */
/* `OWNERSHIP_OWNED`, 1 << 5, is not here: the API derives `hasOwnership` from it and
 * `parkOwns` reads that. These are the three bits nothing else in this bridge reads. */
const OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED = 1 << 4;
const OWNERSHIP_CONSTRUCTION_RIGHTS_AVAILABLE = 1 << 6;
const OWNERSHIP_AVAILABLE = 1 << 7;

/** How many tile names one message will spell out before it starts counting instead. */
const MAX_NAMED_TILES = 12;

export interface BuyLandOutcome {
    ok: boolean;
    tilesRequested: number;
    /** How many of the requested tiles the park owns now, read back off the map. */
    tilesOwned: number;
    /** How many of them it did not own before this call. */
    tilesBought: number;
    /**
     * What the game charged, in tenths of a currency unit. The one figure here that is the
     * game's own answer rather than a re-read of the map: cash changes for other reasons in
     * the ticks this call spans, so a before-and-after difference would not be this purchase.
     */
    cost: number;
    /** What one tile costs in this scenario, in tenths. Null when the game does not report it. */
    landPrice: number | null;
    /**
     * Requested tiles the park still does not own, whatever the reason. Deliberately not
     * called `notForSale`: when the purchase is refused for cash, every tile in it is left
     * unowned and most of them were on the market. `detail` carries which of the two it was.
     */
    notOwned: Tile[];
    /** The rectangle actually worked on, both corners included. */
    area: TileRect;
    detail: string;
    /** Set only when the arguments were refused before anything was bought. */
    error?: string;
}

/** An outcome for a purchase that never started, in the shape every other outcome uses. */
export function buyLandRefusal(detail: string, area: TileRect): BuyLandOutcome {
    return {
        ok: false,
        tilesRequested: 0,
        tilesOwned: 0,
        tilesBought: 0,
        cost: 0,
        landPrice: readLandPrice(),
        notOwned: [],
        area: area,
        detail: detail,
        error: detail
    };
}

function tileName(tile: Tile): string {
    return String(tile.x) + "," + String(tile.y);
}

function plural(count: number, singular: string): string {
    return String(count) + " " + singular + (count === 1 ? "" : "s");
}

function nameTiles(tiles: Tile[]): string {
    const named = tiles.slice(0, MAX_NAMED_TILES).map(tileName).join(" ");

    return tiles.length > MAX_NAMED_TILES
        ? named + " and " + String(tiles.length - MAX_NAMED_TILES) + " more"
        : named;
}

/**
 * The scenario's price for one tile. Older builds of the game do not expose it, and a
 * guessed number here would be read as the real one.
 */
export function readLandPrice(): number | null {
    const price = (park as unknown as { landPrice?: unknown }).landPrice;

    return typeof price === "number" ? price : null;
}

/** Whether the park owns this tile, straight off its surface element. */
export function parkOwns(tile: Tile): boolean {
    if (tile.x < 0 || tile.y < 0 || tile.x >= map.size.x || tile.y >= map.size.y) {
        return false;
    }

    const mapTile = map.getTile(tile.x, tile.y);

    for (let i = 0; i < mapTile.numElements; i++) {
        const element = mapTile.getElement(i);

        if (element.type === "surface") {
            return (element as SurfaceElement).hasOwnership;
        }
    }

    return false;
}

/** The tile's own `ownership` byte, or null where no surface could be read. */
export function readOwnership(tile: Tile): number | null {
    if (tile.x < 0 || tile.y < 0 || tile.x >= map.size.x || tile.y >= map.size.y) {
        return null;
    }

    const mapTile = map.getTile(tile.x, tile.y);

    for (let i = 0; i < mapTile.numElements; i++) {
        const element = mapTile.getElement(i);

        if (element.type === "surface") {
            const ownership = (element as SurfaceElement).ownership;

            return typeof ownership === "number" ? ownership : null;
        }
    }

    return null;
}

/**
 * What one tile's ownership flags say, as a phrase that follows its coordinates.
 *
 * Every bit that is set is named. Nothing here decides whether the tile is worth having or
 * what to ask for instead: it reports the byte the game keeps and stops.
 */
function ownershipPhrase(tile: Tile): string {
    const flags = readOwnership(tile);

    if (flags === null) {
        return "no surface could be read, so the game says nothing about what it is on offer for";
    }

    const says: string[] = [];

    if ((flags & OWNERSHIP_AVAILABLE) !== 0) {
        says.push("the land is for sale");
    }

    if ((flags & OWNERSHIP_CONSTRUCTION_RIGHTS_AVAILABLE) !== 0) {
        says.push("construction rights are for sale, which this call does not ask for: it sends"
            + " landbuyrights setting 0, land only");
    }

    if ((flags & OWNERSHIP_CONSTRUCTION_RIGHTS_OWNED) !== 0) {
        says.push("the park already holds construction rights, not the land");
    }

    if (says.length === 0) {
        return "the scenario has it on offer neither as land nor as construction rights";
    }

    return says.join(", and ");
}

/** Tiles the park still does not own, gathered by what their own flags say. */
function ownershipGroups(tiles: Tile[]): string {
    const order: string[] = [];
    const grouped: Record<string, Tile[]> = {};

    for (let i = 0; i < tiles.length; i++) {
        const phrase = ownershipPhrase(tiles[i]);

        if (!grouped[phrase]) {
            grouped[phrase] = [];
            order.push(phrase);
        }

        grouped[phrase].push(tiles[i]);
    }

    return order.map(function (phrase) {
        return nameTiles(grouped[phrase]) + " - " + phrase;
    }).join(". ");
}

function tilesOf(area: TileRect): Tile[] {
    const tiles: Tile[] = [];

    for (let y = area.top; y <= area.bottom; y++) {
        for (let x = area.left; x <= area.right; x++) {
            tiles.push({ x: x, y: y });
        }
    }

    return tiles;
}

/**
 * Buy the land rights to a rectangle of tiles.
 *
 * `landbuyrights` is the only lever a plugin has over park boundaries during a scenario.
 * Its sibling `landsetrights` — which unowns land, or puts it up for sale — carries the
 * game's `EditorOnly` flag and refuses outside the scenario editor and sandbox mode, so
 * there is no selling land back and no making an unlisted tile buyable, through this tool
 * or through `evaluate`. Levelling ground is a different surface again — `landsetheight`,
 * `landraise` and `landlower` are ordinary actions `evaluate` can reach, so the capability
 * exists; what does not exist is a typed tool for it, and the description says exactly that
 * rather than claiming the ground cannot be moved.
 *
 * The game walks the rectangle itself, skipping tiles the park already owns at no cost
 * and tiles the scenario is not selling with an error it then ignores, so a rectangle
 * that is half for sale buys the half that is. Which half that was is only knowable by
 * reading the map back, which is what this does.
 */
export function buyLand(area: TileRect, done: (outcome: BuyLandOutcome) => void): void {
    const bounds = normaliseRect(area);
    const tiles = tilesOf(bounds);
    const ownedBefore: Record<string, boolean> = {};

    for (let i = 0; i < tiles.length; i++) {
        ownedBefore[tileName(tiles[i])] = parkOwns(tiles[i]);
    }

    let refusal: string | null = null;
    let charged = 0;

    context.executeAction("landbuyrights", {
        x1: toWorld(bounds.left),
        y1: toWorld(bounds.top),
        x2: toWorld(bounds.right),
        y2: toWorld(bounds.bottom),
        setting: SETTING_BUY_LAND
    }, function (result) {
        // The action result is used for two things only: the money the game says it took,
        // and a refusal that applied to the whole rectangle - insufficient funds is the one
        // that actually happens. What was bought is read off the map below.
        if (result && typeof result.error === "number" && result.error !== 0) {
            refusal = typeof result.errorMessage === "string" && result.errorMessage.length > 0
                ? result.errorMessage
                : "the game refused the purchase";
            return;
        }

        charged = result && typeof result.cost === "number" ? result.cost : 0;
    });

    context.setTimeout(function () {
        const notOwned: Tile[] = [];
        let ownedNow = 0;
        let bought = 0;

        for (let i = 0; i < tiles.length; i++) {
            if (!parkOwns(tiles[i])) {
                notOwned.push(tiles[i]);
                continue;
            }

            ownedNow++;

            if (!ownedBefore[tileName(tiles[i])]) {
                bought++;
            }
        }

        const price = readLandPrice();
        const alreadyOwned = tiles.length - notOwned.length - bought;
        const clauses: string[] = [];

        clauses.push("The park owns " + String(ownedNow) + " of the " + plural(tiles.length, "tile")
            + " asked for" + (bought > 0 ? ", " + String(bought) + " of them bought by this call for "
                + String(charged) : "") + ".");

        if (bought === 0 && alreadyOwned > 0 && notOwned.length === 0) {
            clauses.push("All of them were already owned, so nothing was bought and nothing was charged.");
        }

        if (notOwned.length > 0) {
            // Only name a cause that is actually present. A purchase the game refused outright
            // has the game's own words for it; otherwise every tile still unowned is read back
            // off its own ownership flags, which is the one place the scenario states what a
            // tile is on offer for. This used to infer "not for sale" from ownership failing to
            // change, and reported a tile offered as construction rights as unsellable.
            clauses.push(refusal !== null
                ? "The game refused the whole purchase: " + String(refusal) + ". Nothing was bought."
                : plural(notOwned.length, "tile") + " " + (notOwned.length === 1 ? "is" : "are")
                    + " still not the park's, and " + (notOwned.length === 1 ? "its" : "their")
                    + " ownership flags read back: " + ownershipGroups(notOwned) + ".");
        }

        if (price !== null) {
            clauses.push("Land costs " + String(price) + " a tile here.");
        }

        done({
            ok: notOwned.length === 0,
            tilesRequested: tiles.length,
            tilesOwned: ownedNow,
            tilesBought: bought,
            cost: charged,
            landPrice: price,
            notOwned: notOwned,
            area: bounds,
            detail: clauses.join(" ")
        });
    }, STEP_DELAY_MS);
}
