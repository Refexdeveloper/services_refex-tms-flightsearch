import { z } from "zod";
import { getSecretValue } from "./secrets.js";

const flightSearchSchema = z.object({
  tripType: z.enum(["oneWay", "roundTrip"]),
  isInternational: z.boolean(),
  fareClass: z.enum(["Economy", "PremiumEconomy", "Business", "First"]),
  fromCity: z.string().min(3).max(3),
  toCity: z.string().min(3).max(3),
  depDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  arrDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  noOfAdults: z.number().int().min(1),
  noOfChildren: z.number().int().min(0),
  noOfInfant: z.number().int().min(0),
});

export async function searchFlights(input) {
  const payload = flightSearchSchema.parse(input);

  if (payload.tripType === "roundTrip" && !payload.arrDate) {
    throw new Error("arrDate is required for roundTrip");
  }

  const [baseUrl, apiKey] = await Promise.all([
    getSecretValue(process.env.TREXEDIA_BASE_URL_SECRET_NAME),
    getSecretValue(process.env.TREXEDIA_API_KEY_SECRET_NAME),
  ]);

  const response = await fetch(`${baseUrl}/rest/obt/external/flight/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TREX-API-KEY": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error("Trexedia flight search failed");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return normalizeTrexediaSearchResponse(data);
}

function normalizeTrexediaSearchResponse(data) {
  const options = [];

  for (const sector of data.searchResults || []) {
    for (const flight of sector.flightResBean || []) {
      const direction = flight.direction?.[0] || {};
      const firstLeg = direction.leg?.[0] || {};
      const lastLeg = direction.leg?.[direction.leg.length - 1] || firstLeg;
      const allFareEntries = Object.entries(flight.faredetails || {});
      const retailFareEntries = allFareEntries.filter(
        ([fareType]) => fareType === "RETAIL",
      );
      const fareEntries = retailFareEntries.length
        ? retailFareEntries
        : allFareEntries.slice(0, 1);

      for (const [fareType, fare] of fareEntries) {
        options.push({
          id: `${data.uuid || "no-uuid"}:${sector.sectorIndex}:${fare.fareKey}`,
          uuid: data.uuid,
          tripType: data.tripType,
          currencyCode: data.currencyCode || "INR",
          sectorIndex: sector.sectorIndex,
          fareType,
          fareKey: fare.fareKey,
          provider: flight.provider,
          airlineName:
            firstLeg.flight_name ||
            sector.airlineMap?.[firstLeg.flight_code] ||
            flight.provider,
          airlineCode: firstLeg.flight_code,
          flightNumber: firstLeg.flight_number,
          flightImage: firstLeg.flight_image,
          fromCity: sector.fromCity,
          toCity: sector.toCity,
          sourceCityCode: firstLeg.source_city_code || sector.fromCity,
          sourceCityName: firstLeg.source_city_name,
          destinationCityCode: lastLeg.destination_city_code || sector.toCity,
          destinationCityName: lastLeg.destination_city_name,
          departureAirport: firstLeg.departure_airport,
          arrivalAirport: lastLeg.arrival_airport,
          departureDate: firstLeg.departure_date || sector.departureDate,
          arrivalDate: lastLeg.arrival_date,
          departureTime: firstLeg.departure_time,
          arrivalTime: lastLeg.arrival_time,
          duration: direction.duration || firstLeg.duration,
          stops: direction.stops ?? 0,
          seatsAvailable: direction.seatsAvailable,
          refundable: fare.refundable,
          baseRate: fare.baseRate,
          tax: fare.tax,
          totalFare: fare.tot ?? fare.calculatedTot,
          baggage: fare.baggage,
          legSummary: (direction.leg || []).map((leg) => ({
            flightCode: leg.flight_code,
            flightNumber: String(leg.flight_number || "").trim(),
            flightName: leg.flight_name,
            from: leg.source_city_code,
            fromCityName: leg.source_city_name,
            fromAirport: leg.departure_airport,
            fromTerminal: leg.departure_terminal,
            to: leg.destination_city_code,
            toCityName: leg.destination_city_name,
            toAirport: leg.arrival_airport,
            toTerminal: leg.arrival_terminal,
            departureDate: leg.departure_date,
            departureTime: leg.departure_time,
            arrivalDate: leg.arrival_date,
            arrivalTime: leg.arrival_time,
            duration: leg.duration,
            layoverTime: leg.layover_time,
            flightImage: leg.flight_image,
          })),
        });
      }
    }
  }

  const sortedOptions = options
    .filter((option) => Number.isFinite(Number(option.totalFare)))
    .sort((a, b) => Number(a.totalFare) - Number(b.totalFare));

  const uiLimit = 500;
  const limitedOptions = sortedOptions.slice(0, uiLimit);

  return {
    status: data.status,
    uuid: data.uuid,
    tripType: data.tripType,
    currencyCode: data.currencyCode || "INR",
    totalOptionCount: options.length,
    returnedOptionCount: limitedOptions.length,
    uiLimit,
    options: limitedOptions,
  };
}
