/** The only hosts that are this machine. An origin is one of these, with an optional port. */
const LOOPBACK_ORIGIN_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * This runs on a loopback port inside the player's game, so the Origin header is the only
 * thing between a web page they happen to have open and their park.
 *
 * It has to match the whole host, not a prefix: `http://localhost.evil.test` is a name an
 * attacker registers and points wherever they like, and it starts with `http://localhost`.
 * An opaque origin - the literal string `null`, which is what a sandboxed iframe sends -
 * is likewise refused rather than waved through: no legitimate client produces one, and a
 * page that wants to bypass the check can always ask for one. A real MCP client over plain
 * HTTP sends no Origin header at all, and that is the case this lets through.
 *
 * Shared rather than private to the MCP server, because it was private to the MCP server:
 * `POST /mcp` was the only route that called it, while `GET /v1/eval?q=` ran the same
 * model-authored JavaScript in the same game with no check at all. A cross-origin GET is a
 * simple request - any page the player has open can make one, with no preflight to refuse
 * it - so every route that evaluates script has to ask this, not just the one that was
 * written with it in mind.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
    if (typeof origin === "undefined") {
        return true;
    }

    const parsed = /^http:\/\/([^/?#]+)\/?$/.exec(origin.toLowerCase());

    if (parsed === null) {
        return false;
    }

    return LOOPBACK_ORIGIN_HOSTS.indexOf(parsed[1].replace(/:[0-9]+$/, "")) >= 0;
}
