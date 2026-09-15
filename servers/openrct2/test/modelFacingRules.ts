/**
 * The rules that bind every word the model reads on a turn, in one file because the model
 * cannot tell the two sources apart.
 *
 * `games/openrct2/prompt.md` and the tool descriptions arrive in the same context window on
 * the same turn. `prompt.test.ts` held the prompt to a list of steers, a list of imperative
 * openers and a provenance rule; the descriptions were exempt from all three, and they are
 * roughly three times the prompt's length. The rewrite that cleaned the prompt then moved
 * vocabulary OUT of the audited file INTO the unaudited one - `usually` landed in
 * `view_map`, `Never work that rectangle out from` in `describe_placement` - which is what a
 * rule binding one of two files buys.
 *
 * So the lists live here and both test files import them. A word added to one is added to
 * the other, and there is no longer a cheaper place to put a steer.
 *
 * The rule itself is docs/tool-design.md's: abstract perception and mechanics, never
 * abstract judgment. A fact a player reads off the game's own windows is fair however
 * detailed. A fact about this bridge - what a tool is called, what it takes, what it returns
 * - is fair and necessary. A fact that exists only because someone watched a model get
 * something wrong is an answer key, and goes.
 */

/**
 * Where a sentence came from. `game` is something a player reads off the game; `bridge` is
 * this API; `harness` is the agent loop the model runs inside. There is no fourth value,
 * because the fourth category does not belong in text the model reads.
 */
export type Provenance = "game" | "bridge" | "harness";

/**
 * A transcript citation defending a sentence. Session ids, hit rates out of a call count,
 * and "one run measured ..." are all the same defect: model-facing text justified by what
 * one model did rather than by what the game, the bridge or the harness is.
 */
export const TRANSCRIPT_CITATION =
    /\bsession [0-9a-f]{4,}|\b\d+ of \d+ (?:calls|builds|sessions|runs|recorded)|\bone run (?:measured|recalled|ended|spent)|\b(?:nine|eight|seven|six|five|four|three|two) sessions\b|\brecorded (?:run|session|boardings)\b/i;

/**
 * Steers. Each of these either was in the prompt and was cut, or is the shape of the thing
 * that keeps coming back: a ranking, a preference, a cadence, or a probability offered in
 * place of a reading. The bare words are here because they are how one arrives.
 */
export const STEERS: { pattern: RegExp; why: string }[] = [
    { pattern: /holding the park back/i, why: "prescribes diagnose-then-remediate, and one thing per turn" },
    { pattern: /says nothing new/i, why: "talks the model out of looking, and is only probably true" },
    { pattern: /few considered decisions/i, why: "a verdict on one play style, cut once already" },
    { pattern: /fix the missing piece/i, why: "an imperative wrapped round a fact that already stands alone" },
    { pattern: /never a reason to rebuild/i, why: "same fact, stated as a prohibition" },
    { pattern: /\busually\b/i, why: "a probability standing in for a reading" },
    // `usually` was the only frequency word on this list, and the prompt walked straight past
    // it: "a coordinate you derived is the commonest way a run is wasted" is the same steer in
    // a different word, and it was measured across one model's transcripts at that. A claim
    // about how often something happens is never a reading of this park; the tools are.
    { pattern: /\bcommonest\b|\bmost common\b/i, why: "a frequency claim standing in for a reading, and one counted over transcripts rather than read off the park" },
    { pattern: /\bmost often\b|\bmore often than not\b|\bmost of the time\b/i, why: "how often something happened elsewhere is not what is true here" },
    // `how often` is the inspection interval's own subject - `operate_ride.inspectionInterval`
    // IS a frequency the game keeps - so the exemption is for the question, not for an answer
    // to it. "It often names a problem outright" was the sentence this caught, in park_status.
    { pattern: /(?<!\bhow )\boften\b/i, why: "a frequency claim about what a field tends to contain, in place of the field" },
    { pattern: /\btypically\b|\bgenerally\b|\bnormally\b|\bas a rule\b|\bin most cases\b/i, why: "a hedge that answers a question the model is meant to answer by looking" },
    { pattern: /\bis the normal answer\b|\bthe normal case\b/i, why: "says what a field usually holds, which is the reading the call is for" },
    { pattern: /\btends? to\b|\bare likely to\b|\bis likely to\b/i, why: "a tendency is a prediction, and the tools report the state" },
    { pattern: /\brarely\b|\bseldom\b|\balmost always\b/i, why: "the same probability steer from the other end" },
    { pattern: /\bprefer/i, why: "ranks two options the model is supposed to choose between" },
    { pattern: /\bideally\b/i, why: "names a preferred outcome" },
    { pattern: /\bbest\b/i, why: "ranking is the tool playing" },
    { pattern: /\bshould\b/i, why: "the plain word for an instruction wearing a statement's clothes" },
    { pattern: /\bweaker (?:way|option|answer)\b|\bstronger (?:way|option|answer)\b/i, why: "ranks two tools, which is the model's choice of what to read" },
    { pattern: /\bcheaper than\b/i, why: "ranks this call against another one, at the moment the model is choosing between them" },
    // Narrowed from /\bworth\b/: `park_status` describes a ride's `value` as roughly what a
    // guest thinks the ride is worth, which is the natural wording of the rule FACTS pins as
    // the one that makes a price good or bad. The steer is the verdict, not the noun.
    { pattern: /\bworth (?:it|doing)\b/i, why: "whether something is worth it is the decision itself" },
    { pattern: /\bconsider(?:s|ing|ed)?\b/i, why: "steers attention rather than stating a fact" },
    { pattern: /\bmake sure\b/i, why: "an instruction" },
    { pattern: /\bremember\b/i, why: "an instruction" },
    { pattern: /\bsimply\b/i, why: "argues a course of action is easy, which is a judgment" },
    { pattern: /\bbetter\b/i, why: "a comparison between options" },
    { pattern: /\bmost important\b/i, why: "a ranking" },
    { pattern: /\bfocus on\b/i, why: "directs attention at one thing" },
    { pattern: /\bstart by\b/i, why: "prescribes an opening move" },
    { pattern: /\bpriorit/i, why: "ordering the model's options is the model's job" }
];

/**
 * Openers that address the model directly. Not a list of forbidden English: each one can only
 * be followed by an action HERE, so a sentence starting with it is an instruction however
 * carefully the rest of it is worded.
 *
 * Why the list is words and not a part-of-speech test: "Miss one and the ride is finished,
 * paid for, and earning nothing" opens with a bare verb and is a statement about the ride,
 * not a command - the clause after it has its own subject and finite verb. A parser cannot
 * tell those apart reliably and a curated list can, so a verb goes on this list only when
 * nothing but an action can follow it in a document that is supposed to describe a world.
 *
 * `Derive` and `Take` joined the list with the tool descriptions: "Derive nothing from it"
 * and "Take them from the footprint" were both orders addressed to the model, sitting in the
 * one file the prompt's list could not see.
 */
export const IMPERATIVE_OPENERS = [
    "Open with", "Start with", "Start by", "Decide", "Pick", "Choose",
    "Say", "Copy", "Use", "Call", "Check", "Look", "Read", "Keep", "Avoid",
    "Ensure", "Note", "Try", "Aim", "Prefer", "Remember", "Always", "Never",
    "Don't", "Do not", "First", "Then", "Next", "Begin", "Focus", "Consider",
    "Derive", "Take"
];

/**
 * Start of a line, of a markdown heading, of a bullet, of a numbered step, or of a sentence.
 *
 * The heading prefix is the second hole: `## Copy values across; never work them out` failed
 * none of these patterns, because `##` was not one of the prefixes a line could open with, so
 * the most prominent line in a section was the one place an instruction could sit unseen.
 */
export function openerPattern(opener: string): RegExp {
    // A bare newline is NOT a boundary: prompt.md is hard-wrapped, so "there is nothing to\n
    // look up" would read as a sentence opening "look". What opens something is the start of
    // the text, a blank line, a line that begins with a heading, bullet or step marker, or
    // sentence punctuation - and the marker itself is then stepped over.
    const boundary = "(?:^|\\n[ \\t]*\\n|\\n(?=[ \\t]*(?:#{1,6}|[-*]|\\d+[.)])[ \\t])|[.!?;:]\\s|—\\s)";
    const marker = "[ \\t]*(?:#{1,6}[ \\t]+|[-*][ \\t]+|\\d+[.)][ \\t]+)?";

    return new RegExp(boundary + marker + "(" + opener + ")\\b", "i");
}

/**
 * The steer a banned-word list cannot see, and the reason this file has a second half.
 *
 * A reviewer wrote a sentence that passes every pattern above, every opener above and the
 * heading rule: "A queue eight tiles long carries eight guests to a ride that a bare door
 * carries one to." That is a deleted throughput measurement - "one run measured 3 customers
 * against 16" - restored as prose. The vocabulary is clean because vocabulary was never what
 * made it an answer key; the QUANTITY was.
 *
 * So the second rule is about arithmetic rather than words. A sentence that puts a NUMBER on
 * a guest outcome, or that RANKS two ways of running a park by one, is pre-answering the
 * question the run is supposed to measure - unless it is a rule of the simulation, in which
 * case someone can say which window a player reads it off. `DECLARED_CLAIMS` is where they
 * say so, and a claim that is not in it fails the build.
 *
 * What this does not catch is stated where it is enforced, in modelFacingText.test.ts.
 */
const CARDINAL = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)";
const GUEST_NOUN = "(?:guests?|customers?|riders?|visitors?|boardings?|people|peeps?)";
const OUTCOME_NOUN = "(?:guests?|customers?|riders?|visitors?|boardings?|takings|profit|money|cash|rating|value)";

/** A count of guests, riders or boardings written into the text as a figure. */
export const QUANTIFIED_OUTCOME = new RegExp(CARDINAL + "[ \\t\\n]+(?:more[ \\t\\n]+)?" + GUEST_NOUN + "\\b", "i");

/** Two ways of running the park, ranked against each other by what the park gets out of it. */
export const OUTCOME_COMPARISON_HINGE =
    /\b(?:more|fewer|less|higher|lower|faster|slower|longer|shorter|twice|half as)\b[^.]{0,70}\bthan\b/i;
export const OUTCOME_NOUN_PATTERN = new RegExp(OUTCOME_NOUN, "i");

/**
 * Every quantified or ranked outcome claim the model is allowed to read, with the source
 * that makes it fair. The list is short on purpose: a rule of the simulation states what
 * the game does, and stating what the game does almost never needs a number in it.
 */
export const DECLARED_CLAIMS: { claim: string; from: Provenance; why: string }[] = [
    {
        claim: "the one guest at the door is the whole line",
        from: "game",
        why: "the game boards a guest off the tile the entrance door opens onto, so with nothing bound to that door the tile holds one guest. It is the door's geometry, which a player sees, and not a throughput figure"
    },
    {
        claim: "a ride boards one guest at a time",
        from: "game",
        why: "the same door rule, stated beside `hasQueue`, which is the field that would otherwise read as an admission condition"
    },
    {
        claim: "one guest carrying two thoughts lands in two counts",
        from: "bridge",
        why: "what `count` counts - thought slots rather than guests - which is arithmetic about this payload and says nothing about any park"
    }
];

/** Sentences, for text that has already been folded to a single line. */
export function sentencesOf(text: string): string[] {
    return text.split(/(?<=[.!?])\s+/).filter(function (sentence) {
        return sentence.trim().length > 0;
    });
}

/**
 * The first sentence of a description names what the tool or the argument DOES - "Buy the
 * land rights to a rectangle of tiles", "Open the ride once it is built" - which is the one
 * place an imperative is the interface and not a steer. Everything after it is prose the
 * model reads on the same turn as the prompt, and is held to the prompt's rules.
 */
export function afterOpeningSentence(text: string): string {
    const sentences = sentencesOf(text);

    return sentences.length < 2 ? "" : sentences.slice(1).join(" ");
}
