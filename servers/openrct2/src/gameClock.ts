/**
 * The game's calendar, and where its clock stands right now.
 *
 * OpenRCT2's year is eight months long and its months are not the same length, so one date
 * cannot be subtracted from another without the table. It lives here rather than inside the
 * first tool that needed it, because a second copy of the calendar is a second thing that
 * can be wrong about the same fact.
 */

/** Days per month, March to October, as OpenRCT2's `days_in_month` in `Date.cpp`. */
export const DAYS_IN_MONTH = [31, 30, 31, 30, 31, 31, 30, 31];

export const MONTHS_PER_YEAR = DAYS_IN_MONTH.length;

export const DAYS_IN_YEAR = DAYS_IN_MONTH.reduce(function (total, days) {
    return total + days;
}, 0);

/**
 * `monthProgress` runs 0 to this and then the month turns over, climbing by 4 a tick. The
 * game derives the day of the month from it, so it is the only sub-day resolution there is.
 */
const MONTH_PROGRESS_PER_MONTH = 65536;

export interface DateReading {
    year: number;
    month: number;
    day: number;
}

/** Whole days since the start of year 1, so two dates subtract across a month or a year. */
export function dayNumber(reading: DateReading): number {
    let days = (reading.year - 1) * DAYS_IN_YEAR;

    for (let month = 0; month < reading.month && month < MONTHS_PER_YEAR; month++) {
        days += DAYS_IN_MONTH[month];
    }

    return days + (reading.day - 1);
}

/** Days before the start of a month, counted from total elapsed months as the game does. */
function daysBeforeElapsedMonth(monthsElapsed: number): number {
    const months = Math.max(0, Math.floor(monthsElapsed));
    const month = months % MONTHS_PER_YEAR;
    let days = Math.floor(months / MONTHS_PER_YEAR) * DAYS_IN_YEAR;

    for (let i = 0; i < month; i++) {
        days += DAYS_IN_MONTH[i];
    }

    return days;
}

/**
 * The same whole day number as `dayNumber`, from the pair a park message carries: total
 * elapsed months and the day within that month. A message records no year of its own.
 */
export function dayNumberFromElapsedMonths(monthsElapsed: number, dayOfMonth: number): number {
    return daysBeforeElapsedMonth(monthsElapsed) + Math.max(0, Math.floor(dayOfMonth) - 1);
}

/** Today, on that same scale, so an arrival day subtracts from it directly. */
export function currentDayNumber(): number {
    return dayNumberFromElapsedMonths(date.monthsElapsed, date.day);
}

/**
 * Where the clock stands, in days since the scenario began, the part-day included.
 *
 * Whole days are too coarse for measuring one turn. At speed 1 a game day is about thirteen
 * real seconds, so a turn that spent most of a day would report 0 and read as free - and a
 * number that is 0 whenever it is small is a number that teaches the wrong thing. The
 * fraction is the game's own `monthProgress`, the same counter the day of the month is
 * derived from, not an interpolation of ours.
 *
 * Undefined when there is no clock to read at all, which is every caller running outside a
 * game. A missing reading is never substituted with 0: 0 days is a measurement.
 */
export function readGameDayPosition(): number | undefined {
    const clock: Partial<GameDate> | undefined = typeof date === "undefined" ? undefined : date;

    if (!clock || typeof clock.monthsElapsed !== "number" || typeof clock.monthProgress !== "number"
        || isNaN(clock.monthsElapsed) || isNaN(clock.monthProgress)) {
        return undefined;
    }

    const month = Math.max(0, Math.floor(clock.monthsElapsed)) % MONTHS_PER_YEAR;

    return daysBeforeElapsedMonth(clock.monthsElapsed)
        + clock.monthProgress / MONTH_PROGRESS_PER_MONTH * DAYS_IN_MONTH[month];
}

/**
 * Game days between two readings, to one decimal place.
 *
 * A reloaded or cheated scenario can move the date backwards, and there is no honest bill
 * for negative time: that reads as 0 rather than as a number with a minus sign in front of
 * it, which nothing downstream would know what to do with.
 */
export function gameDaysBetween(before: number, after: number): number {
    return after > before ? Math.round((after - before) * 10) / 10 : 0;
}
