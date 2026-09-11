# What belongs in a tool

Every tool added to a game bridge takes something away from the model. The question
is what it is allowed to take.

## The rule

**Abstract perception and mechanics. Never abstract judgment.**

A human playing OpenRCT2 clicks "build Merry-Go-Round", clicks a tile, then places an
entrance and an exit. They never learn that world coordinates are tile × 32, that
`inspectionInterval` is an enum from 0 to 6 rather than a number of minutes, that the
3×3 flat-ride track piece is type 266, that bit 0 of `constructFlags` is what makes a
path a queue, or that an entrance's `direction` points at the ride so its door faces
the other way. None of that is the game. It is the cost of reaching the game through an
API instead of a mouse, and it is invisible to the person the model is being compared
against.

The same human *does* decide what to build, where to put it, how to lay the paths,
what to charge, when to open the park, and what to do about a falling rating. That is
the game. A tool that makes those choices is not helping the model play; it is playing
instead of it, and the run stops being evidence of anything.

## Why perception counts as mechanics

The model has no eyes. A person looking at the map sees a flat green clearing near the
main path in one glance. Handing the model the same fact — these tiles are owned, level,
unobstructed, and this far from a footpath — restores a sense it never had. It does not
decide anything: which site to use, and whether to build there at all, remain open.

Ranking those sites by "best" would cross the line. Reporting the distance to the nearest
path does not.

## The line in practice

| Tool | Gives the model | Leaves to the model |
|---|---|---|
| `park_status` | What the game shows on screen: money, rating, guests, every ride | What any of it means, and what to do |
| `guest_feedback` | What guests are complaining about | Which complaint is worth acting on |
| `list_ride_objects` | What exists, its footprint, whether it builds in one action | What is worth building |
| `find_build_sites` | Where a ride fits, and how far each door is from a path | Which site, which doors, whether to build at all |
| `clear_scenery` | Removing trees from a square | Whether felling them is worth the money and the rating |
| `build_flat_ride` | The create/place/entrance/exit sequence, with correct arguments | What, where, which way round, which doors, what price, whether to open |
| `build_path` | Placement and routing around obstacles | Where paths go, and whether a run is a queue |
| `hire_staff` | The hiring action | Who to hire and how many |
| `evaluate` | The whole plugin API, unrestricted | Everything else |

Note what none of them do: none rank options by "best", none choose a site, none decide
a price, and none lay a path the model did not ask for. `find_build_sites` sorts by
distance to a footpath because that is a measurement, and reports `totalFound` so the
model knows the list is a window rather than the whole truth.

`build_flat_ride` reports whether guests can actually reach the finished ride. It does
not fix it. Telling the model its ride is unreachable is information; silently laying
the path for it is park design, which is the interesting part of the game.

## Where the line genuinely blurs

`build_path` is the honest hard case. Routing around a tree is perception — the model
cannot see the trees, and dumping a tile map into its context to fix that costs more than
it is worth. But the *shape* of the line between two points is park layout, which is one
of the few creative decisions in the game. Both live in one call.

It shipped routing both, and the parks it produced showed it: braided dirt swathes that
no player would draw. The resolution is to separate them rather than to route more
prettily. The caller passes `waypoints` — the corners it wants — and the tool lays
straight runs between them, handling only the tiles. Two bare endpoints still work, and
the description says plainly that the tool is then choosing the layout.

Routing better would have hidden the problem. A tool that makes a decision *well* is
still making it.

## How we got here

The first version of `build_flat_ride` routed its own paths to the nearest footpath.
It worked, and it was wrong: path layout is one of the few genuinely creative decisions
in a park builder, and the tool was making it badly and invisibly. Splitting `build_path`
out gave the decision back and made the tool smaller at the same time.

The tell to watch for: if a tool's arguments stop describing *what the player wants* and
start describing *nothing at all* — `build_me_a_good_park()` — it has crossed over.

## Perception is most of the value

The tools that earn their place fastest are the ones that simply let the model see. A
person reads cash, rating, guest count and every ride's queue off the screen constantly
and for free. Without `park_status` the model spends a call and a paragraph of
JavaScript rebuilding that picture every turn, and usually rebuilds a worse one.

`guest_feedback` is the same idea pointed at the game's own diagnostics. OpenRCT2 already
knows why guests are unhappy and will say so — "can't find", "too expensive", "hungry".
Surfacing that is not advice; it is reading a window that was already open.

The clearest case was a filter nobody would have called a decision. `find_build_sites`
originally returned only tiles with nothing on them at all. In a forest scenario that
was about 40 sites out of 1,325 — it silently hid 97% of the buildable park, because
trees are removable and a player would simply fell them. Reporting `sceneryToClear` and
offering `clear_scenery` handed back a park the model never knew it had.

## Corollary: tools must not lie

A tool that reports success for work that did not happen is worse than no tool, because
it teaches the model a false model of the world and there is no way to detect it from
inside the game.

This is not hypothetical here. OpenRCT2 reported a ride as `status: "open"` with a real
excitement rating when nothing had been built on the ground. A later version of the build
tool reported "8 of 8 path tiles placed" while the ride sat unreachable, because it was
counting actions it had queued rather than tiles that existed. And a ride whose entrance
is touched by an ordinary footpath looks finished from every angle the API offers, while
guests crowd around it and never board, because an entrance needs a *queue* path bound to
that ride.

So every step verifies by reading the world back, and reports what it found rather than
what it attempted. Game actions apply on a later tick, so a tool that acts and checks in
the same breath will always see the old world.

The same applies to the bridge itself: each build is stamped with an id it reports over
MCP, and `scripts/deploy-plugin.sh` refuses to continue until the running game reports
the id that was just built. An hour went into debugging a stale bundle before that
existed.

## The clock is the harness's problem, not the model's

A local model takes seconds to tens of seconds per decision. If the game is running
while it thinks, thinking time is charged against the scenario clock, and a slower model
scores worse for being slow rather than for playing worse. In a test run the game
advanced a full scenario year while the bridge was being debugged, and the objective
failed on time alone.

So pacing belongs to the harness: pause while the model decides, advance a fixed number
of ticks after it acts. `gamesetspeed` and `pausetoggle` are ordinary game actions, which
makes this straightforward — but it has to be deliberate, or every run silently measures
inference speed instead of play.
