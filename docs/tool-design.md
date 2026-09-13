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

### The same rule binds the prompt

`games/openrct2/prompt.md` is governed by this document too, and it is the larger
influence of the two: a tool description is read when its tool is in play, the prompt is
read on every turn of every run. The line is the same one, drawn precisely. **A fact about
how the simulation works stays** — the model cannot read OpenRCT2's source, so a game rule
is knowledge it has no other way to get, and cutting it hides the rules rather than
protecting the model's judgment. **An instruction, preference or steer goes** — it teaches
nothing and only leans. The test for any sentence is whether it tells the model something
about the *world* or tells the model what to *do*. This binds tool results as tightly as it
binds descriptions and the prompt, because a small model follows text more reliably than it
reasons: a steer sitting in a result does not make a run merely impure, it makes a good run
unmeasurable, since there is no longer any way to tell the model's decision from the text's.

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
| `park_status` | What the game shows on screen: money, rating, guests, every ride, and which tiles a door actually opens onto | What any of it means, and what to do |
| `guest_feedback` | What guests are complaining about | Which complaint is worth acting on |
| `list_ride_objects` | What exists, its footprint, whether it builds in one action | What is worth building |
| `describe_placement` | For the one origin and rotation it was asked about: the ground the ride would stand on, what stops it, how far each door is from a path, and what an entrance at that door would dead-end | Where to put the ride, which way round, which doors, whether to build at all |
| `clear_scenery` | Removing scenery from a named patch of ground | Whether felling it is worth the money and the rating |
| `build_flat_ride` | The create/place/entrance/exit sequence, with correct arguments | What, where, which way round, which doors, what price, whether to open |
| `build_path` | Paving the tiles it was handed, and naming every tile of the run that will not take a path, what is on it, and the call that lifts it | Which tiles carry a path, what shape the line is, and whether a run is a queue |
| `remove_path` | Taking the footpath or queue off named tiles, and what that cost: how much of the network guests can still reach, and any ride whose bound queue went with it | Which tiles to take up, and whether to lay anything back |
| `operate_ride` | The open, close, reprice, inspect and demolish actions, and what the ride is doing afterwards | Whether a ride should be open, what it should cost, how often it needs inspecting, whether to tear it down |
| `open_park` | The two actions that admit guests and set admission | When to open, and what to charge |
| `hire_staff` | The hiring action | Who to hire and how many |
| `buy_land` | The purchase action, what it cost, the scenario's price per tile, and which of the tiles asked for are not for sale | Whether the park needs more ground, and where |
| `set_game_speed` | The speed setting and the pause toggle, neither of whose argument shapes is discoverable, and what the game reads back as afterwards | When to run fast, when to run slow, and when to pause |
| `evaluate` | The whole plugin API, unrestricted | Everything else |

Note what none of them do: none rank options by "best", none choose where a ride goes,
none decide a price, and none pave a tile the model did not name. `describe_placement`
answers about a tile the model named and looks at no other; its `access` list is every door
position that placement has, in the order the tiles ring the footprint, so there is nothing
in it that was ordered or left out.

`build_flat_ride` reports whether guests can actually reach the finished ride. It does
not fix it. Telling the model its ride is unreachable is information; silently laying
the path for it is park design, which is the interesting part of the game.

## Where the line genuinely blurs

`build_path` was the honest hard case, and the first resolution of it was wrong. Routing
around a tree is perception — the model cannot see the trees, and dumping a tile map into
its context to fix that costs more than it is worth. But the *shape* of the line between
two points is park layout, which is one of the few creative decisions in the game. Both
lived in one call.

It shipped routing both, and the parks it produced showed it: braided dirt swathes that no
player would draw. The first resolution was to separate them rather than to route more
prettily: the caller passed `waypoints` — the corners it wanted — and the tool laid the
legs between them, with two bare endpoints still accepted and the description saying
plainly that the tool was then choosing the layout.

That did not hold, and why is in "The line was ours too" below. Each leg between corners
went through the same search, with the same turn cost and the same obstacle avoidance, so
the corners were hints and every tile between them was still the tool's. `build_path` now
takes `tiles`: the literal list, every one of which is paved and no other tile touched,
with nothing routed, nothing filled in between them and nothing reordered.

The perception half did not go with the routing. What the router was actually buying — the
model cannot see trees — comes back as a refusal: every tile of the run that will not carry
a path, named at once, with what stands on each and the `clear_scenery`, `buy_land` or
`remove_path` call that lifts it, and nothing built. That is more than the router ever gave
back. It detoured round the same tree silently, so the model never learned the ground was
blocked and never got the chance to fell it.

Nor does the tool decide what shape a run is. Tiles that do not touch are laid as given and
reported as separate runs, because two stubs or a queue standing on its own are legitimate
things to build, and refusing one would be the tool ruling on the layout it has just handed
over. The gap is reported rather than refused, since whether the tiles just drawn join up is
exactly the thing the caller cannot read back.

Routing better would have hidden the problem. A tool that makes a decision *well* is
still making it.

### The other half of that decision was missing entirely

Nothing could remove a footpath at all, and `build_path`'s own messages named two
situations whose only remedy is removal: an ordinary path laid over a queue unbinds it from
its ride, and a ride's entrance claiming the queue at its door dead-ends that one tile,
cutting off whatever lay past it. Across eight sessions the model was told it had cut its
park in two, and looped — a diagnosis with no lever attached. Naming a mistake the model
cannot undo is the same defect as not naming it, one step later, and it is easier to miss
because the tool that names it is working perfectly.

Those messages blamed the wrong thing while they did it. What they actually said was that a
queue laid across a through route splits the park, because guests cannot walk through one,
and that is not a rule the game has; how it got written down, and what believing it cost,
is further down this page. The gap stands either way: a park that has been cut, however it
was cut, needs a way to take the path back up.

`remove_path` takes the same addressing as `build_path`, which is now a single field
rather than a family of them: `tiles`, the literal list, so a `build_path` result's own
`tiles` handed straight back lifts exactly what that call laid. Neither half of
`build_path`'s hard case recurs here. There is nothing to route *around*, because a tile
either carries a footpath or it does not; and there is no line left to choose, because the
caller names the tiles at both ends.

What it reports is what removal costs: `tilesRemoved` counted by re-reading each tile,
how much of the path network is still reachable from the park entrance, and
`ridesLeftWithoutQueue` — any ride whose bound queue went with the path, which is the
damage that is otherwise invisible. It puts nothing back and suggests nothing. A ride
entrance, a ride exit and the park gate are not footpaths, so a run crossing one is refused
by name rather than reporting a short removal the model has no way to explain.

## How we got here

The first version of `build_flat_ride` routed its own paths to the nearest footpath.
It worked, and it was wrong: path layout is one of the few genuinely creative decisions
in a park builder, and the tool was making it badly and invisibly. Splitting `build_path`
out made the tool smaller and looked like it gave the decision back. It gave back less than
it looked: the routing moved rather than went, and `build_path` went on choosing the line
for two more versions before it took tiles.

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

## An argument shape is a claim about the world

`clear_scenery` took `x`, `y` and `size`: a square of `size` tiles centred on a tile. For
clearing ground for a path that is exactly right. For clearing the ground a *ride* needs,
it is not awkward — it cannot express the answer at all, because a flat ride's footprint is
not centred on the origin the game builds it from. A 4x4 runs 0..3 from that origin, a 1x4
runs -2..+1, a 2x4 is centred on neither axis. A 3x3 is the one common shape a centred
square gets exactly right, which is why the argument survived as long as it did.

Measured: `size: 4` on a 4x4 dodgems clears 4 of the 16 tiles the ride needs, so the call
is paid for and the ride still will not go up. `size: 5` on a 1x5 swinging ship clears 25
tiles to place 5 — five times the trees felled, five times the money, and a rating hit for
scenery nobody meant to lose. Both report success.

The fix is not a better default or a cleverer `size`. It is a second form that can say the
true thing: `fromX`, `fromY`, `toX`, `toY`, two inclusive corners, copied field for field
off a `describe_placement` footprint, which reports the ride's real ground under exactly
those four names. Nothing is computed on the way across, so there is nothing to get
wrong. The square form stays, because ordinary ground really is a square centred on a tile.
The two forms share no argument at all, so which one a call means is never a judgement, and
half a form is refused rather than completed with a default — a `toX` with no `toY` quietly
squared off would clear different ground from the ground that was named, and clearing is
destructive and costs money.

That form is now the one `buy_land` takes as well, for the same reason rather than for
consistency's sake: the ground a purchase is about is a rectangle, a `describe_placement`
footprint reports its corners under exactly `fromX`, `fromY`, `toX` and `toY`, and all four
are required, so buying the ground a ride would stand on computes nothing on the way across. Buying
resolves exactly one situation — a tile the park does not own — and the description says so,
because the neighbouring problems look identical from the model's side and are not reachable
at all: `landsetrights`, which unowns land or puts it up for sale, carries the game's
`EditorOnly` flag, so land cannot be sold back and a tile the scenario is not selling cannot
be made buyable; and levelling is a different surface again (`landsetheight`, `landraise`,
`landlower`) that nothing in this bridge touches. A rectangle that is half for sale buys the
half that is and names the tiles it did not get, which is the same rule as everywhere else:
read the map back and report what is there, rather than failing the whole call or claiming
the whole rectangle.

The general lesson is worth more than the tool. When a tool keeps needing a workaround, the
question is not what to default; it is what the arguments are asserting about the world, and
whether that assertion is true.

## What the tools still decide

Audited deliberately, because these creep in as conveniences and are invisible once
they ship.

**Justified, because they are measurements or samples:**

- ~~`find_build_sites` orders sites by distance to a footpath and reports `totalFound`, so
  the model can see it is being shown a window rather than everything.~~
- ~~Sites are kept at least the ride's longest side plus two tiles apart. Returning the
  three nearest tiles to a path returns one location three times, which reads as a choice
  and is not.~~ Both struck out: the measurement was honest and the decision was still
  being made by it. See "The measurement was honest and it still chose" below.
- `guest_feedback` samples 100 guests, and says so; `park_status` reports the last dozen
  park messages. Its `paths` samples nothing: it carries the whole reachable network as
  runs — straight lines of one kind of path, each with its ends, its tile count, a queue's
  bound ride, and `cutsIfBlocked` — plus the junctions, the dead ends, and `islands`, the
  fragments the gate cannot reach at all, with any stranded ride doors named on them. Above
  400 reachable tiles severance is not worked out, and `severingComputed` false says so
  rather than reporting that nothing severs. The `ground` census beside it counts clear,
  scenery, sloped, water, path and built tiles per 32-tile block, and says
  `complete: false` when the park owns more blocks than the 64 it shows. Sampling data is
  not choosing with it, as long as the result says which it did.
- Each access option carries `queueCutsOff`: how many path tiles stop being reachable from
  the park entrance once an entrance here claims the queue on that door. Guests walk a queue
  like any other path; what severs a route is a ride *claiming* a tile, and it dead-ends
  exactly the one its door opens onto. So a door on bare ground is 0, and only a door
  already carrying a footpath or an unclaimed queue can be above 0. That is a count of what
  would happen, and the list is deliberately *not* reordered by it — nor by anything else:
  the options come back in the order the tiles ring the footprint, and which door to accept
  the cost at is the model's. The field is right and has always been the right thing to
  report. Two things about it were not: the reason it was first added was false, and for
  three runs nothing read it. Both are below.
- ~~`find_build_sites` tries a ride at rotations 0 and 1 when none is given, because 2 and 3
  cover exactly the same tiles with the ride facing the other way. A shop is tried at all
  four, because a stall's rotation decides which single neighbour guests are served from.~~
  Struck out with the search: `describe_placement` requires a rotation and fills in none.
  The geometry it rested on is still true and is now in the argument's own description.

**Fixed on audit, because they were choices in disguise:**

- Door positions were trimmed to the six nearest a path, which could hide an entire side
  of a ride — and with it the option of putting both doors on one face. The best option
  on every side was taken first, then the list filled by distance to a cap of eight, with
  `accessTotal` reporting how many existed before the trim. That was the fix at the time;
  the trim is gone altogether now that one placement is described instead of three, and
  every door position comes back.
- `price` defaulted to 10. A ticket price is an economic decision, and defaulting it
  meant one was being made quietly. It is now required.
- Three tool descriptions had drifted into advice. `find_build_sites` said putting both
  doors on the same side "usually makes a shorter, straighter queue than opposite sides";
  `build_flat_ride`'s `open` said it "is usually worth connecting it first";
  `operate_ride`'s `price` said "compare against the ride's `value`". A description is the
  one piece of text the model reads every single turn, so a recommendation sitting in one
  is not a hint, it is the tool playing — and the queue advice was the tool choosing the
  door, which is the decision that tool existed to hand over. Those three went
  first. The measurements they were wrapped around stayed: the sites still report `side`,
  the rides still report `value`, and an open ride guests cannot reach still costs rating.
- Advice comes back, so that is a running total and not a closed list. Eight more sentences
  have gone since. Three were descriptions again: `clear_scenery` called felling scenery "a
  trade, not free ground", `park_status` said to reach a stall's counter with `build_path`
  "rather than rebuilding the stall", and `find_build_sites`' `limit` said to "ask for more
  only when you need the choice" — an argument against seeing the alternatives the tool
  exists to offer. The other five were where the first audit had not looked, and were worse
  for it. Four were in results, each ending by naming the next call: `build_flat_ride`'s
  access step closed with "Use build_path to connect them", which fired on nearly every ride
  the model built, because `reachable` is false by design until the queue goes down; its
  stall step, the shop note on `find_build_sites`, and `build_path`'s queue-unbinding
  warning did the same. The fifth was the prompt's closing line, "Few considered decisions
  beat many speculative ones" — a verdict on one play style in the last thing the model
  reads. Each time the fact the instruction was wrapped around stayed and only the
  imperative went: the access step still says there is no queue and the exit is not
  connected, the stall steps still say which one tile is the counter and that a path on the
  other three sides serves nobody, and the fact that warning carried — an ordinary path laid
  over a queue unbinds it from its ride — is now the reason `build_path` gives for refusing
  to lay one there. Stating the world is the tool doing its job; naming the
  model's next move is the tool taking the turn.
- `hire_staff` clamped a `count` outside 1 to 10 into range and then reported the clamped
  number as `requested`. Asking for 30 and being told 10 were requested is a small lie of
  exactly the kind the next section is about. The schema now refuses it by name.

**Known and deliberate:** ~~the unstated line of a two-point `build_path`, which the model
can take with `waypoints`.~~ Struck out with both forms: `build_path` takes the tiles and
draws no line at all. `waypoints` was the two-point form wearing a different hat, which is
"The line was ours too" below.

### The measurement was honest and it still chose

`find_build_sites` swept the park for every place a ride fitted, filtered them, sorted them
by distance to the nearest footpath the gate reached, dropped any within a footprint of one
already kept, and returned the first three. Every step of that was defensible on its own and
each is argued for above. Measured across every run: the model took site #1 in 11 of 12
builds and access option #1 in 12 of 12, from sets of more than 1,200 candidates. It never
compared two.

So the sort was the decision. Where every ride in every run went was chosen by a comparator
in `src/park/sites.ts`, and no line of the model's reasoning ever weighed one site against
another, because by the time it read anything the weighing had been done. A tool that makes
a decision *well* is still making it — the same finding as `build_path`'s routing, one level
further up, and harder to see because nothing in the result was a recommendation.

The replacement is `describe_placement`. It takes a ride object, an origin and a rotation,
and reports that placement: the footprint rectangle, whether the ground takes it and what
stops it tile by tile, and every door position with what each would cost. It looks at no
other tile. The model picks the spot from `view_map`, `park_status`'s ground census and its
path network, and asks what would happen there.

What stayed is everything the model cannot derive, because deleting a correct measurement to
remove a ranking would be a bad trade. A ride's footprint offsets are not a formula — a 4x4
runs 0..3 from its origin, a 1x4 runs −2..+1, only a 3x3 is centred — and that was a live
bug once. So are the door rules, `queueCutsOff`, the reachability-aware distances, and the
per-option `cost` sentence. What went is the search, the sort, the spread rule and the
`limit`: `findBuildSites` in `src/park/sites.ts`, replaced in place by `describePlacement`,
with the per-placement half kept where it stood.

There is no hidden default left in it. `rotation` is required rather than searched or
defaulted to 0, the origin is the caller's, the `access` list is neither sorted nor trimmed,
and the tool offers no second option anywhere. If the model is going to choose spatially,
the first thing it needs is for nothing else to have chosen.

This is an experiment and it may not survive contact with a run. Reverting it is one commit.

### The line was ours too

The same finding, one tool along, and this one had been written down. `build_path` took two
tiles and routed between them, and `src/tools/path.ts` said so in its own description:
convenient, but it means it is choosing your layout. Saying it did not stop it being true,
and `waypoints` did not either — each leg between corners went through the same search with
the same turn cost and the same avoidance, so the corners were hints and every tile between
them was the tool's. A `waypoints` of two points is the two-point form wearing a different
hat.

What made the cost visible was a run that could not wire one ride. Wiring a ride is two runs
that must not collide: a queue from the tile the entrance door opens onto, and ordinary path
from the tile the exit door opens onto. Ordinary path laid over a queue unbinds it from its
ride, so the two lines cannot share a tile. The router picked each line independently, they
overlapped, the queue went over part of the exit's path, and the exit was orphaned. The
model could see what had happened and could not say *these tiles, not those*, because the
tool did not take tiles.

So it takes tiles, and both routed forms went rather than one. Leaving either in means the
tile list is never exercised, because this model takes whichever option is easiest — which
is the same measurement as site #1 in 11 of 12 builds, read off a different tool.

What survived the change is worth more than the change. The router was buying one real
thing, which is that the model cannot see trees, and that is perception, which this document
says to keep. It is kept, in the shape a refusal takes: every blocked tile of the run named
at once, with what stands on each and the call that lifts it, and nothing laid. The router
held exactly the same knowledge and spent it on a detour, so a run that went round a tree
taught the model nothing about the tree. Handing the fact over instead of acting on it is
the whole rule in one field.

### Correct, honest, measured, and still choosing

Neither of the tools this section has replaced was lying, hinting or recommending. Both were
right. `find_build_sites` sorted by a distance it measured correctly and said how many
candidates it had found; `build_path`'s router found a real path around a real tree and
reported the tiles it had actually laid. Each would pass a review for accuracy, and each was
making the decision anyway.

That is a sharper failure than a tool that lies, and harder to catch for the same reason:
every test written about either one passed, and there was nothing wrong in the output to
point at. What was wrong was that the result arrived with the choice already made.

A field can do it without even being used. `queueCutsOff` was computed exactly right,
reported plainly, and deliberately not used to reorder or mark anything — and over three
runs of the model choosing a door it wrote `pathDistance` 77 times in its own reasoning and
`queueCutsOff` 3 times. In the run that laid a queue across the park's trunk path it
enumerated all seven options, copying `door`, `pathDistance` and `needsClearing` for each
and `queueCutsOff` for none. It was not weighing the number and overriding it. It never saw
it. A correct field nothing reads is a presentation defect, and "the model decides" is only
true if the model has read the thing it is deciding with.

`pathDistance` is the same defect from the other end: a real cost, measured honestly, that
inverts on a ride's door. 0 on a shop's serving tile means guests can already stand there,
which is the best case there is. 0 on a ride's door means the opposite — the door needs a
free tile, and 0 says the tile is not free, so the queue has to take paving that is already
carrying traffic. Same field, opposite sense, and nothing in the number to tell them apart.

Neither was answered by ranking. Every access option now carries a `cost` sentence saying
the three figures together, in words, in the place the reading actually happens: the path to
lay, the tile the queue takes and what stands on it, and what loses its route to the gate.
It states a price and stops — nothing is reordered, filtered, marked or recommended by it,
and the list is the same list in the same order it was before.

That the sentence is what got the number read is the part that did not hold up. The same
treatment on `cutsIfBlocked` produced 117 sentences and 0 reads, and `cost` itself read 0 in
that run. See "A prose sentence is not what made the number get read" below: the defect
named here is real, the fix named here is not established, and `cost` stays only until a run
with completed builds settles it.

So the rule at the top of this page needs a third clause beside advice and ranking. A tool
can be entirely accurate and still hold the decision: by having already made it, or by
putting the fact the decision needs somewhere nobody looks. Being right is not the test.
Whether the choice is still open when the result is read is the test.

### What this is expected to cost

Both changes may produce worse parks, and that is not a disclaimer. A worse site, a clumsier
line and a door that strands a corner of the park, all chosen by the model, are the
experiment. A better park chosen by a comparator in `src/park/sites.ts` and a router in
`src/park/pathbuild.ts` is not evidence about the model at all, which is the only thing
these runs exist to produce. Nothing here has been measured as an improvement in play and
nothing here claims to be one.

## Corollary: tools must not lie

A tool that reports success for work that did not happen is worse than no tool, because
it teaches the model a false model of the world and there is no way to detect it from
inside the game.

This is not hypothetical here. OpenRCT2 reported a ride as `status: "open"` with a real
excitement rating when nothing had been built on the ground. A later version of the build
tool reported "8 of 8 path tiles placed" while the ride sat unreachable, because it was
counting actions it had queued rather than tiles that existed. And `guestsCanReach`
reported `false` for four rides while the game recorded 29 boardings at them, because the
tool demanded a bound queue the game has never required: a guest steps onto a ride from
ordinary path abutting its door, one at a time.

So every step verifies by reading the world back, and reports what it found rather than
what it attempted. Game actions apply on a later tick, so a tool that acts and checks in
the same breath will always see the old world.

### Reading the world back is not enough if you read the wrong tiles

The rule has a failure mode that reading state back does not catch, and it cost the most
of anything here. `src/park/flatRides.ts` turned a track piece's tile offsets the wrong
way — `(dx,dy) → (-dy,dx)` where OpenRCT2's `CoordsXY::rotate` is `(dx,dy) → (dy,-dx)` —
which swapped rotations 1 and 3 for every footprint not symmetric about its origin. The
access tiles, the `sceneryToClear` count and the buildability check were then all answered
honestly, about ground the ride was never going to stand on. A build could report
`ok: true` for a ride whose entrance sat two tiles clear of it, having verified every step.

Three things are worth taking from that rather than one.

**A verification is only as good as the coordinates it verifies at.** "Report what you
read" assumes you read the right place. Where a tool computes *where* to look, that
computation is part of the claim and needs its own evidence.

**The evidence has to be independent of the thing being checked.** This was settled three
ways — the game's own `getTrackSegment` offsets at each rotation, OpenRCT2's C++ source,
and a mutation test — and it needed all three, because a table regenerated by the same
reasoning that produced the bug would have agreed with it.

**A green suite is evidence about the tests, not about the code.** Flipping the rotation
in shipped code broke no test at all. Every rotation any test covered was one of the two
that cannot tell the two rules apart: 0 and 2 are mirror images either way round, and a
3x3, a 1x5 or a 1x1 comes out identical either way round. The coverage was real and the
confidence it produced was not. Tests now pin all four rotations of the asymmetric pieces,
and one states the rule itself so it fails on the rule rather than on a table.

### `ok` has to mean one thing

`build_flat_ride` used to return `ok: false` when the ride went up but a door failed to
attach, or when it went up and the game refused to open it. Both are true statements about
a step. Both were read as "nothing happened", and the model built a second copy — one
session produced two half-built burger bars that way.

`ok` now means exactly one thing: the ride exists with its track on the ground.
`doorsAttached`, `open` and `reachable` are reported separately, and the description says
that `ok: true` with any of them false is a ride you already own. The only outcome that
leaves nothing behind is `ok: false`. This is the same rule pointed the other way: a tool
that reports failure for work that *did* happen teaches a false model of the world just as
effectively, and costs money as well.

### An error that names a category cannot be acted on

A refusal is a tool result like any other, and it is the one the model reads when it is
already off track. The transcripts are blunt about what works: across the runs so far the
model recovered from 14 of 14 errors that named the failing value and the call that fixes
it, and from 0 of 6 that named only a category. "Value out of range" names no field and is
unrecoverable; "`inspectionInterval` must be a whole number between 0 and 6 — it is an
index into the game's inspection intervals and not a number of minutes" is a turn spent
usefully.

So refusals name the property, the value that arrived, and the legal set — and where there
is a next call, they name it: which coordinate was wrong, which condition failed, and the
`operate_ride` or `build_path` call that fixes it. What they deliberately do not do is
guess: `open_park` only names free park entry or a no-money scenario as the reason a fee
did not take when that flag is actually set, because an explanation appended to every
refusal reads as a fact and gets acted on as one.

There is a trap in this that is easy to walk into now that the MCP layer enforces ranges.
A tool's own range check is a second line of defence — over MCP the schema refuses the call
first, so that carefully written refusal is text the model will never see. Anything it
needs in order to *avoid* the mistake therefore has to live in the property's
`description`, which it reads every turn, and not only in a message that has become
unreachable. The tool-level check stays for direct callers and for the constraints a schema
cannot express — `build_flat_ride`'s four door coordinates are all-or-nothing,
`operate_ride`'s `demolish` cannot be combined with `price` or `open`, `clear_scenery`'s
two forms are mutually exclusive — all of which are relationships between arguments rather
than facts about one.

### The fake game has to be at least as strict as the real one

That is now a test, not a habit. `test/fakeGame.ts` stands in for the OpenRCT2 globals
and reproduces the timing that causes the bug: actions queue, and `setTimeout` applies
the queue before running its callback. Construct it with `{ inert: true }` and actions
are accepted and never applied, which is how the false-success direction is checked —
every tool must then report that nothing happened. The whole suite runs against it, so a
tool that starts lying about a build fails the suite rather than a run.

The fake earns that only by being honest itself, and it was not. It now applies the actions
it queues rather than merely recording them, rotates track pieces the way `TrackPlaceAction`
does, binds queue chains to rides the way `FootpathChainRideQueue` does — and, importantly,
throws on an action it does not model instead of answering "that worked". A test double that
cheerfully accepts anything is the same bug as a tool that cheerfully reports success, one
layer down, and it hides exactly the bugs the suite exists to catch.

The same applies to the bridge itself: each build is stamped with an id it reports over
MCP, and `scripts/deploy-plugin.sh` refuses to continue until the running game reports
the id that was just built. An hour went into debugging a stale bundle before that
existed.

## Reading a run: the tools are on trial too

When a run goes badly there are two possible causes, and they demand opposite responses.

- **A tooling failure.** The model was told something false, was not told something it
  needed, or had no way to carry out the thing it correctly decided to do. Fix the tool.
- **A play failure.** It had accurate, sufficient information, could act on it, and chose
  badly anyway. That is a finding about the model.

They look identical from outside: a park full of unreachable rides earning nothing. The
test that separates them is to replay the transcript and ask of each action, *given
exactly what it had been told at that moment, was this reasonable?* A model that prices
every ride at 5.00 is playing badly if it can see each ride is worth 3.60, and is playing
sensibly on bad information if it cannot.

This matters more here than in most projects, because the model is deliberately small.
A small model amplifies tooling defects: it will not notice that a tool contradicted
itself two calls ago, it takes a description literally, and it does not recover from a
misleading result the way a larger one might. So a weak tool produces something that
looks exactly like a weak model, and the temptation is to conclude the obvious thing.

Being strict about this is not generosity toward the model. Attributing a tooling bug to
the model hides the bug, and the run after it fails the same way.

The honest accounting so far is uncomfortable, and got worse rather than better on
inspection: nearly every failure across the first five runs traced to a tool. Entrances
could not be discovered; door options were invisible; `hasQueue` was true for queues nobody
could reach; a ride's footprint was computed by a rule that does not hold; builds that
succeeded were reported as failures; there was no way to open a ride once built; there was
no way to open the *park*, so five of five runs hand-wrote `park.setFlag("open", true)`
through `evaluate`.

A deliberate audit found more, and they are worth listing plainly because each one had been
sitting behind a tool that looked like it worked:

- Footprints were read from the game but then **rotated the wrong way**, so rotations 1 and
  3 were swapped for every asymmetric ride. Doors, clearing and buildability were all
  measured on the wrong tiles, and the build reported success.
- `clear_scenery` could only describe a centred square, which **cannot express a ride's
  footprint at all**: `size: 4` cleared 4 of a dodgems' 16 tiles, and a 1x5 ship took 25
  tiles of trees to place 5.
- `find_build_sites` resolved a ride object **by its position in the list** while
  `build_flat_ride` used the object's own `.index`, so the two disagreed whenever the
  loaded object list had a gap in it.
- Stalls reported `guestsCanReach: false` **always**, contradicting the build tool that had
  just said guests could reach them; and `find_build_sites` filtered out a stall's real
  serving tile for having a path on it, then offered tiles that connect nothing.
- `park_status`'s `monthlyProfit` summed **11 of the game's 14 expenditure streams**,
  showing a month in profit that the game's own finance graph showed in the red.
- `queryAction` returned `{"ok":true,"result":null}` for **every** query, valid or not, so
  a misspelled action name was indistinguishable from a successful one. One run was told
  twice that a ride had been demolished and then failed to build because it was still
  standing.
- The deferred path never noticed a client disconnect, never cancelled its watchdog, and
  turned a failure on a later tick into a 30-second timeout — so the model was told the
  tool was slow rather than what broke.

All of those are fixed, and the one commit that did it took the suite from 66 tests to 298.
But the shape of that list is the finding rather than the fixes in it: every entry is a
tool that passed its own tests, and most were found by asking what a result would look like
if it were wrong, not by a run failing. The model's actual play has still barely been
measured.

### A complete list the model could not use

`park_status` used to hand the reachable path network over as a flat list of tiles,
`reachableSample`, capped, with `reachableSampleComplete` beside it saying whether the cap
had bitten. It had, and a run read the sample as the network: it reasoned about what
connected to what among the tiles it had been shown, as though nothing else were paved, and
the park it was describing was not the park. That is why the list was made complete rather
than merely longer. A window the model cannot see the edge of is not a window, it is a false
map, and the answer to one is never a bigger cap — it is the whole thing, or a number saying
what was left out.

Completeness turned out not to be sufficient. Handed all 31 reachable tiles of a small park,
the model still could not do set membership over them, and said so in as many words:
"(51,26) and (52,26) are BOTH in the reachableSample! Why are they not connected?" The list
was correct, complete, and the wrong shape. It answered *which tiles*, when every question
the model actually had was *what joins what* — and across nine classified runs, 63% of the
spatial failures were connectivity: a path laid to nowhere, a queue dead-ending the only
route through, an ordinary path laid back over its own queue.

So `paths` reports the shape instead: runs, junctions, dead ends, and the islands the gate
cannot reach with the ride doors stranded on them. Completeness survived the change and got
better for it, because it stopped being a promise and became something the reader can check
— every reachable tile lies on exactly one run, so the runs' `tiles` add up to
`reachableTiles`. It is also cheaper: the tile list cost about 1,111 tokens at its cap,
while runs scale with the number of corridors rather than the number of tiles. That is what
makes re-sending the whole network every turn affordable, which matters more than it sounds,
because what survives a context compaction is stale coordinates — three consecutive
summaries in one run carried a demolished ride's — so the live shape has to arrive whole
each turn rather than be remembered.

Where the whole answer genuinely cannot be given, the gap is named. Severance costs a walk
of the network per tile, on the game's own thread where a long loop is a frozen game, so
above 400 reachable tiles it is not computed and `severingComputed` is false. Reporting 0
there would have been the same defect as the truncated sample, one field along: a number
that looks like an answer, in exactly the parks too large to have a way round everything.

### Six places agreeing with each other is not evidence

The worst of them belongs on that list and is not on it, because nothing was broken. Every
tool involved did exactly what it was written to do. What they were written from was a rule
the game does not have.

The rule was that guests cannot walk through a queue — a queue reaches a ride and dead-ends
there, so laying one across a route guests use splits the park in two. Nobody measured it.
It was written down once and then read back out of six places that had each taken it from
one of the others: the reachability flood in `src/park/paths.ts`, `build_path`'s severance
warnings, `queueCutsOff` in what was then `find_build_sites`, four tool descriptions, the
prompt, and a
test written to hold it honest. Six things in step with each other, one source between
them, and the game disagreeing with all six.

What settled it was reading the thing guest movement is actually made of. Every footpath
element carries an `edges` bitfield — the sides a guest may leave that tile by — and
`PathGetPermittedEdges`, the one function the guest pathfinder asks which way it may go,
returns that bitfield verbatim. The bits are not a hint about connectivity; they are the
connectivity. Turning two tiles of a running park's main walk into a queue changed no bit
at all, 10 before and 10 after, so guests walked straight over it. Binding a queue to a
ride's entrance did change bits, and changed exactly one link: the tile the door opens onto
lost its edge to what lay beyond, 10 to 3, and stripping the queue put it back. A queue
tile in the middle of a bound line kept its edge to the ordinary path beside it. Across 35
footpaths there was not one pair of tiles where the two sides disagreed about a link.

So a queue is ordinary walkable path, and what severs a route is a ride *claiming* a tile.
An entrance dead-ends exactly one: the tile its door opens onto.

Believing otherwise cost in both directions at once, which is most of why it survived.
`queueCutsOff` is the field that exists to stop the model cutting up its own park. A door
standing on bare ground was charged the worst severance of its four neighbours, on the
theory that the queue run leading to it would block the path it joined — so the field added
to prevent that mistake was telling the model that building beside the main path would
commit it. Those are 0 now, measured rather than assumed. A door already carrying a queue
no ride had claimed read 0, and is now measured, because that is the one tile an entrance
really does dead-end. Meanwhile `guestsCanReach` demanded a bound queue before it would
call a ride reachable, so it called rides unreachable while guests were riding them: one
park went from 48 to 96 paying customers on a ride the tool was still reporting as cut off,
with 94 of its 106 guests standing on the far side of the queue they supposedly could not
cross.

The correction moved a fact rather than deleting one. A bound queue is throughput, not
admission: without one, the single guest at the door is the whole line, and anyone who
arrives while they are still there is turned away. That is what `hasQueue` now says, and it
is the difference between a ride taking 3 customers in a run and another taking 16.
Reachability and throughput had been folded into one flag, and the flag was answering
neither question.

The test is the part worth keeping. There was one, written for exactly this rule, and it
could not fail: its queue was a dead end with no path beyond it, so the true rule and the
false one returned the same answer on the only ground it ever ran on. That is the fifth
test this session alone has caught proving something other than what it claimed, which is
too many to file as accidents — it is a property of how tests get written here. A test
whose fixture cannot tell a rule from its negation is not thin coverage; it is a green
light wired to nothing, and it is worse than no test at all, because the rule it appears to
guard stops being asked about. The replacements are built the other way round: one lays a
queue across a walk *with path beyond it* and asserts guests still get past, one cuts the
single edge the game actually cuts and asserts they do not, and a third asserts the
sentence is absent from the tool descriptions — because a falsehood copied into six places
comes back from a stale branch or a half-remembered paragraph, and a description is read on
every turn its tool is in play.

The general point is the one this whole section keeps arriving at from different sides. The
bridge's job is to report what the game says, and agreement between our own components is
not a reading of the game. Six copies of an unmeasured claim are one claim, and the thing
that would have caught it — asking the game — was available the whole time.

### A prose sentence is not what made the number get read

The fix this page recommends twice above is the same one. `queueCutsOff` was correct and
unread, so the three figures it sat among were said again as a `cost` sentence, in the place
the reading actually happens — and the mentions moved from 3 against `pathDistance`'s 77 to a
4.6:1 ratio, with the number weighed out loud for the first time. That was the clearest
measured win the project had. `cutsIfBlocked` was the same defect one tool along, so it got
the same treatment: a `cuts` sentence beside the figure, on every run of every `park_status`.

**It did not replicate.** In one run: 117 sentences delivered across 12 `park_status` calls,
every one of them carrying a figure above 0, and 0 mentions in the model's reasoning — plus 0
paraphrases, with "lose their route", "cut off", "sever" and "disconnect" all at zero. That is
15,327 bytes of result JSON, roughly 2,500 tokens, for nothing. In the same run `cost` got 0
reads as well. What the model read was `pathDistance`, 23 times, and it wrote its own sentence
around it unprompted: *"These all have pathDistance 3, meaning I need to lay 3 tiles of
path."*

So the honest statement is narrower than the one written down. A short numeric field with a
nameable key gets read; a pre-written sentence does not, whether it hangs off an access option
or off a path run. The prose did not fix the unread-field defect. It doubled its token cost.

This is a correction to the inference, not a retraction of the observation. `queueCutsOff` did
go from 3 mentions to 5 and was weighed once; that happened. What does not survive is the rule
drawn from it — that saying a number in words is what gets it read — because the same
treatment on the same kind of field produced nothing at all, and the second measurement is the
larger of the two.

The first one also cannot be re-checked, which is its own finding. The script that produced it
is gone. A single run, counted once, by a method nobody kept, is the same shape of evidence as
the six components agreeing with each other above: one claim that reads like a result. **A
result whose method was not kept is a result that cannot be checked**, and it should not have
been load-bearing for a second change.

So the `cuts` sentence is gone and `cutsIfBlocked` stays. `cost` is left standing for now, and
deliberately rather than by omission. It is the larger of the two — a sentence per access
option, and a 4x4 returns sixteen — but pulling it on this evidence would repeat the same
mistake facing the other way: its supporting measurement was taken on a different model, and
the run that gave it 0 reads is the run described below, where every ride that was described
was then abandoned, so there was barely a door choice for it to be read for. What would settle
it is a run with at least three completed builds on the model now in use, counting mentions and
paraphrases of `cost`, `pathDistance` and `queueCutsOff` separately, with the counting script
committed alongside the numbers. If `cost` reads 0 while `pathDistance` reads above 0 in the
same results, it goes the way `cuts` went.

### The sharpest thing in that run was not a tool failure

Three rides that fitted were abandoned at the same step. The map was read correctly each time,
`describe_placement` had answered, the ground took the ride, the door options were there, and
the figures had already been copied out. Then, five times over and close to verbatim: *"this is
getting too complicated. Let me wait a bit more."* The model made two `build_path` calls in the
whole run, laid seven tiles, and both succeeded first time. Its own post-mortem blamed the path
network for being small — describing its own inaction as a property of the park.

Nothing in the tool layer should try to fix that, and it is recorded here rather than turned
into a change. The test this section sets is *given exactly what it had been told at that
moment, was this reasonable?*, and the answer is no. It had the measurement, it had the call,
the call worked every time it made it, and it stopped. The capability was present, correct,
read, and declined.

That is a play failure, and it is the cleanest one the project has — nearly every other entry
in this accounting is ours. This page says so plainly whenever the fault is the bridge's, so it
has to say so here.

## The clock is the model's problem, and that is a reversal

A local model takes seconds to tens of seconds per decision. If the game is running
while it thinks, thinking time is charged against the scenario clock, and a slower model
scores worse for being slow rather than for playing worse. In a test run the game
advanced a full scenario year while the bridge was being debugged, and the objective
failed on time alone.

This page used to conclude from that that pacing belonged to the harness — pause while the
model decides, advance a fixed number of ticks after it acts. That is no longer the
decision, and the earlier one is recorded here rather than quietly deleted.

The argument that overturned it is this document's own rule pointed at the clock. A human
playing OpenRCT2 controls game speed and the pause key, and uses them constantly: running
fast through a quiet stretch and pausing to lay out a junction are both *playing*, not
scaffolding around playing. A harness that paces the game for the model takes that away and
makes a decision on its behalf, which is the thing the whole page is against — and it makes
the runs measure a different game from the one a person plays.

So `set_game_speed` hands both levers over, and the model spends or saves scenario time the
way a player does. This is knowingly a lever over its own scoring: a model that leaves the
game at speed 4 while it deliberates will lose months it did not mean to spend, and that
will show up as a failed objective. That is the point. Mispacing is now a play failure and
reads as one in the transcript, where before it was invisible in the harness's settings.

The tool states the mechanic and nothing else. Both actions have undiscoverable shapes —
`gamesetspeed` takes a setting that looks like a multiplier and is not (the loop runs
`1 << (speed - 1)` updates, so 1, 2, 3, 4 mean normal, twice, four times and eight times,
and asking for 8 meaning eight times is out of range), and `pausetoggle` flips rather than
sets, so asking to pause twice unpauses unless something reads the state first. Carrying
those is mechanics. Saying when to use them would be playing, so the description says
plainly that when to run fast, when to run slow and when to pause are the model's.

### The bill for thinking was the half that went unreported

The paragraph above claims mispacing "reads as one in the transcript". Measured, it did not.

Over year one of a scenario that was lost on the clock: seven `wait` calls spent 62 of the
year's 248 days — 25% — and the other 186 days, 75%, elapsed while the model was thinking. At
speed 4 the clock runs about 0.6 game days per real second whether or not a wait is in
progress, confirmed on three separate deliberation gaps: 20 real seconds bought 12 days, 16
seconds bought 9, 69 seconds bought 43. After a single `set_game_speed 4` that was never reset,
waiting cost 60 days and thinking cost 163 — 2.7 times as much scenario time as the tool whose
whole job is to spend it.

The model was not ignoring the clock. It noticed the deadline seventeen times and chose to wait
anyway. What it could not see is which half of the bill was larger, because only one half was
reported: `wait` returns `gameDays`, and thinking returned nothing. `park_status` gives the date
and the speed as a level, never a rate, and nothing anywhere said how much time had passed since
the last call. A person watching the screen gets that for free — they see the days tick past
while they deliberate.

So every tool result now carries `gameDaysSinceLastCall`. Arithmetic on two readings of a clock
the bridge already had.

It goes on every result rather than in one place, because every turn ends in a tool call and the
figure is what that turn cost. On `park_status` alone it would silently aggregate several turns
into one unattributable number, and `park_status` was 12 calls of a run with many more. It is
measured from the previous *result* rather than from the previous call, so it and a `wait`'s own
`gameDays` tile the timeline instead of overlapping — the wait reports the seconds it ran, this
reports everything between two calls. It carries one decimal place, because a game day is about
thirteen real seconds at speed 1 and whole days would read 0 for most turns at that speed: a
number that is 0 whenever it is small teaches that thinking is free. The first call of a session
carries no figure at all, because there is no previous result to measure from and 0 would be a
measurement. It costs about eight tokens a call — against the ~2,500 a run the `cuts` sentence
was costing for nothing.

And it says nothing about itself. No cap, no warning, no mention of the objective, no refusal of
a long wait. The clock was handed over on purpose and spending it badly is a legitimate way to
lose; a model that noticed the deadline seventeen times does not need reminding of it. What it
did not have was the bill.

### The same missing sense, one field along: how old is this?

`park_status` reports the last dozen park messages the game raised, newest last, and said nothing
about when any of them arrived — so a complaint from month 2 sat beside one from month 7 looking
identical. Both are the game naming a problem in its own words, and one of them may have been
fixed months ago. In an earlier run the model read *"Guests can't get to the entrance of Ferris
Wheel 1!"* on two separate turns after that ride's `exitConnected` had gone true, and called it
stale both times. It was right — and it got there by noticing the message contradicted another
field, which works while the contradiction is obvious and not otherwise.

The game records the arrival itself: a `ParkMessage` carries `month`, total elapsed months, and
`day` within that month. So the version of this that would have been disproportionate — the
bridge remembering first-seen ticks per message, which is bridge-side state that outlives a
read — was not needed and was not built.

Each message now carries `gameDaysAgo`. An age rather than a date, for the reason `cutsIfBlocked`
is a count rather than a pair of tile lists: a date leaves the subtraction to the reader, and
OpenRCT2's year is eight months of unequal length, which is exactly the arithmetic this bridge
does everywhere else so the model does not have to. Whole days, because the day is the resolution
the game records and nothing may claim a finer one. Denominated in game days like `wait`'s
`gameDays` and `gameDaysSinceLastCall`, so game time has one unit across the whole bridge.

Nothing is filtered, reordered or marked by it, and no message is called stale or resolved.
Whether a seven-week-old complaint still stands is the reader's call — and it is a call the model
got right, in the run above, as soon as it had the means to make it.

`wait` already does the "new since" version of this, with `newMessages`, and can, because it
holds a before and an after. One `park_status` call has no memory of the previous read. That is
precisely why a stamp on the message is the shape that fits and a delta is not.
