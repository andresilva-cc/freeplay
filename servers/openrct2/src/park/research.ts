/**
 * Whether the scenario has unlocked a ride object yet.
 *
 * A scenario loads every ride object it may ever offer and invents them over time, posting
 * "X is now available" as each one lands. The loaded list is therefore not the buildable
 * list, and a tool that reports one as the other is claiming something it never read.
 *
 * `park.research.isObjectResearched` is the game's own answer: it calls `ResearchIsInvented`,
 * which for an object of type `ride` is `RideEntryIsInvented(index)` - indexed by the object's
 * own `.index`, the same number `list_ride_objects` reports and `build_flat_ride` expects.
 *
 * This is measured and never acted on. `RideCreateAction::Query` and `TrackPlaceAction::Query`
 * carry no invention check - only the new-ride window and the track-design actions do - so the
 * two actions a flat-ride build fires are not refused for an uninvented ride. Refusing one here
 * would be this file inventing a rule the game does not have.
 */
export function rideObjectResearched(index: number): boolean {
    return park.research.isObjectResearched("ride", index);
}
