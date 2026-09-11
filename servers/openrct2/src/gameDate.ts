export interface GameDateInfo {
    ticksElapsed: number;
    monthsElapsed: number;
    yearsElapsed: number;
    monthProgress: number;
    day: number;
    month: number;
    year: number;
}

export function getGameDateInfo(): GameDateInfo {
    return {
        ticksElapsed: date.ticksElapsed,
        monthsElapsed: date.monthsElapsed,
        yearsElapsed: date.yearsElapsed,
        monthProgress: date.monthProgress,
        day: date.day,
        month: date.month,
        year: date.year
    };
}
