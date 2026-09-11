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
| `find_build_sites` | Where land is level, owned, clear, and how far from a path | Which site, whether to build at all |
| `build_flat_ride` | The create/place/entrance/exit action sequence, with correct arguments | What to build, where, at what price, whether to open |
| `build_path` | Placement and routing around obstacles | Where paths go, and whether a run is a queue |
| `evaluate` | The whole plugin API, unrestricted | Everything else |

`build_flat_ride` reports whether guests can actually reach the finished ride. It does
not fix it. Telling the model its ride is unreachable is information; silently laying
the path for it is park design, which is the interesting part of the game.

## How we got here

The first version of `build_flat_ride` routed its own paths to the nearest footpath.
It worked, and it was wrong: path layout is one of the few genuinely creative decisions
in a park builder, and the tool was making it badly and invisibly. Splitting `build_path`
out gave the decision back and made the tool smaller at the same time.

The tell to watch for: if a tool's arguments stop describing *what the player wants* and
start describing *nothing at all* — `build_me_a_good_park()` — it has crossed over.

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
