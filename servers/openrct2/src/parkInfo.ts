export interface ParkInfo {
    name: string;
    numGuests: number;
    rating: number;
    cash: number;
    bankLoan: number;
    companyValue: number;
    parkValue: number;
    entranceFee: number;
}

export function getParkInfo(): ParkInfo {
    return {
        name: park.name,
        numGuests: park.guests,
        rating: park.rating,
        cash: park.cash,
        bankLoan: park.bankLoan,
        companyValue: park.companyValue,
        parkValue: park.value,
        entranceFee: park.entranceFee
    };
}
