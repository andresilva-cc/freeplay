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
| `find_build_sites` | Where a ride fits, the ground it stands on, how far each door is from a path, and what a queue at that door would cut off | Which site, which doors, whether to build at all |
| `clear_scenery` | Removing scenery from a named patch of ground | Whether felling it is worth the money and the rating |
| `build_flat_ride` | The create/place/entrance/exit sequence, with correct arguments | What, where, which way round, which doors, what price, whether to open |
| `build_path` | Placement and routing around obstacles | Where paths go, and whether a run is a queue |
| `operate_ride` | The open, close, reprice, inspect and demolish actions, and what the ride is doing afterwards | Whether a ride should be open, what it should cost, how often it needs inspecting, whether to tear it down |
| `open_park` | The two actions that admit guests and set admission | When to open, and what to charge |
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
off a `find_build_sites` site, which reports the ride's real footprint rectangle under
exactly those four names. Nothing is computed on the way across, so there is nothing to get
wrong. The square form stays, because ordinary ground really is a square centred on a tile.
The two forms share no argument at all, so which one a call means is never a judgement, and
half a form is refused rather than completed with a default — a `toX` with no `toY` quietly
squared off would clear different ground from the ground that was named, and clearing is
destructive and costs money.

The general lesson is worth more than the tool. When a tool keeps needing a workaround, the
question is not what to default; it is what the arguments are asserting about the world, and
whether that assertion is true.

## What the tools still decide

Audited deliberately, because these creep in as conveniences and are invisible once
they ship.

**Justified, because they are measurements or samples:**

- `find_build_sites` orders sites by distance to a footpath and reports `totalFound`, so
  the model can see it is being shown a window rather than everything.
- Sites are kept at least the ride's longest side plus two tiles apart. Returning the
  three nearest tiles to a path returns one location three times, which reads as a choice
  and is not.
- `guest_feedback` samples 100 guests; `park_status` lists the reachable path network in
  full up to 250 tiles and the last dozen park messages. Sampling data is not choosing
  with it.
- Each access option carries `queueCutsOff`: how many path tiles stop being reachable from
  the park entrance if a queue reaches that door. A queue does not stop at the door — it is
  laid onto the footpath it joins, and guests cannot walk through one — so joining a tile
  that carries a through route splits the park in two. That is a count of what would
  happen, and the list is deliberately *not* reordered by it; the ordering stays distance
  to a path, and which door to accept the cost at is the model's.
- `find_build_sites` tries a ride at rotations 0 and 1 when none is given, because 2 and 3
  cover exactly the same tiles with the ride facing the other way. A shop is tried at all
  four, because a stall's rotation decides which single neighbour guests are served from.
  That is the game's geometry, not a preference.

**Fixed on audit, because they were choices in disguise:**

- Door positions were trimmed to the six nearest a path, which could hide an entire side
  of a ride — and with it the option of putting both doors on one face. The best option
  on every side is taken first, then the list is filled by distance to a cap of eight,
  and `accessTotal` reports how many existed before the trim.
- `price` defaulted to 10. A ticket price is an economic decision, and defaulting it
  meant one was being made quietly. It is now required.
- Three tool descriptions had drifted into advice. `find_build_sites` said putting both
  doors on the same side "usually makes a shorter, straighter queue than opposite sides";
  `build_flat_ride`'s `open` said it "is usually worth connecting it first";
  `operate_ride`'s `price` said "compare against the ride's `value`". A description is the
  one piece of text the model reads every single turn, so a recommendation sitting in one
  is not a hint, it is the tool playing — and the queue advice was the tool choosing the
  door, which is the decision `find_build_sites` exists to hand over. Those three went
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
  other three sides serves nobody, and the warning still says an ordinary path laid over a
  queue unbinds it from its ride. Stating the world is the tool doing its job; naming the
  model's next move is the tool taking the turn.
- `hire_staff` clamped a `count` outside 1 to 10 into range and then reported the clamped
  number as `requested`. Asking for 30 and being told 10 were requested is a small lie of
  exactly the kind the next section is about. The schema now refuses it by name.

**Known and deliberate:** the unstated line of a two-point `build_path`. See above; the
model can take it with `waypoints`, and the description says who is choosing when it
does not.

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
