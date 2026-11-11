import { createHash } from "crypto";
import { z } from "zod";
import { getSecretValue } from "./secrets.js";

const SESSION_TTL_MS = 20 * 60 * 1000;
const UI_LIMIT = 500;
const MAX_MULTI_CITY_SEGMENTS = 12;

const flightSegmentSchema = z.object({
  fromCity: z.string().min(3).max(3),
  toCity: z.string().min(3).max(3),
  depDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const flightSearchSchema = z.object({
  tripType: z.enum(["oneWay", "roundTrip", "multiCity"]),
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
  segments: z.array(flightSegmentSchema).optional(),
});

const fareClassMap = {
  Economy: "G",
  PremiumEconomy: "W",
  Business: "B",
  First: "F",
};

let cachedSession = {
  cookieHeader: "",
  sessionId: "",
  expiresAt: 0,
};

export async function searchFlights(input) {
  const payload = flightSearchSchema.parse(input);

  validateSearchPayload(payload);

  const config = await getTravolutionConfig();
  const searchRequest = buildTravolutionSearchRequest(payload);
  const logContext = buildSafeSearchLogContext(payload);

  console.log("travolution_search_start", {
    ...logContext,
    tripType: payload.tripType,
    travelType: searchRequest.Data.TravelType,
    segmentCount: getSearchSegments(payload).length,
  });

  try {
    let session = await getValidSession(config);
    let searchResponse = await postTravolutionSearch(
      config,
      session,
      searchRequest,
    );

    if (searchResponse.shouldRetrySession) {
      console.warn("travolution_session_retry", {
        status: searchResponse.httpStatus,
        statusCode: searchResponse.data?.StatusCode,
        description: searchResponse.data?.Description,
      });
      clearCachedSession();
      session = await login(config);
      searchResponse = await postTravolutionSearch(
        config,
        session,
        searchRequest,
      );
    }

    if (!searchResponse.response.ok) {
      const error = new Error("Travolution flight search failed");
      error.status = searchResponse.response.status;
      error.details = searchResponse.data;
      throw error;
    }

    if (searchResponse.data?.Status !== "Success") {
      throwTravolutionBusinessError(searchResponse.data);
    }

    const result = normalizeTravolutionSearchResponse(
      searchResponse.data,
      payload,
    );

    console.log("travolution_search_success", {
      ...logContext,
      tripType: payload.tripType,
      statusCode: searchResponse.data?.StatusCode,
      totalOptionCount: result.totalOptionCount,
      returnedOptionCount: result.returnedOptionCount,
      sectorCounts: countOptionsBySector(result.options),
    });

    return result;
  } catch (error) {
    console.warn("travolution_search_failed", {
      status: error.status,
      message: error.message,
      providerStatus: error.details?.status,
      providerStatusCode: error.details?.statusCode,
    });
    throw error;
  }
}

async function getTravolutionConfig() {
  const [baseUrl, userId, password, role] = await Promise.all([
    getConfigValue("TRAVOLUTION_BASE_URL", "TRAVOLUTION_BASE_URL_SECRET_NAME"),
    getConfigValue("TRAVOLUTION_USER_ID", "TRAVOLUTION_USER_ID_SECRET_NAME"),
    getConfigValue("TRAVOLUTION_PASSWORD", "TRAVOLUTION_PASSWORD_SECRET_NAME"),
    getConfigValue("TRAVOLUTION_ROLE", "TRAVOLUTION_ROLE_SECRET_NAME", "A"),
  ]);

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    userId,
    password,
    role: role || "A",
  };
}

function normalizeBaseUrl(value) {
  const baseUrl = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("TRAVOLUTION_BASE_URL must start with http:// or https://");
  }
  return baseUrl;
}

function describeFetchError(error, targetUrl) {
  const cause = error?.cause;
  const nested = Array.isArray(cause?.errors) ? cause.errors[0] : cause;
  const code = nested?.code || cause?.code;
  const reason = nested?.message || cause?.message || error?.message || "fetch failed";
  const host = (() => {
    try {
      return new URL(targetUrl).host;
    } catch {
      return targetUrl;
    }
  })();

  const enriched = new Error(
    code
      ? `Unable to reach Travolution (${host}): ${reason} [${code}]`
      : `Unable to reach Travolution (${host}): ${reason}`,
  );
  enriched.status = 502;
  enriched.details = {
    provider: "travolution",
    targetUrl,
    code,
    reason,
  };
  return enriched;
}

async function getConfigValue(directEnvName, secretEnvName, defaultValue) {
  const directValue = process.env[directEnvName];
  if (directValue) {
    return String(directValue).trim();
  }

  const secretName = process.env[secretEnvName];
  if (secretName) {
    return String(await getSecretValue(secretName)).trim();
  }

  if (defaultValue !== undefined) {
    return String(defaultValue).trim();
  }

  throw new Error(`${directEnvName} or ${secretEnvName} is required`);
}

async function getValidSession(config) {
  if (
    cachedSession.cookieHeader &&
    cachedSession.sessionId &&
    cachedSession.expiresAt > Date.now()
  ) {
    return cachedSession;
  }

  return login(config);
}

async function login(config) {
  const loginUrl = `${config.baseUrl}/restwebsvc/auth/loginV1`;
  let response;
  try {
    response = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        AuthType: "WBS",
        IsMobile: "N",
        Password: config.password,
        Role: config.role,
        UserId: config.userId,
      }),
    });
  } catch (error) {
    throw describeFetchError(error, loginUrl);
  }

  const data = await readJsonResponse(response);

  if (!response.ok || data?.Status !== "Success" || !data?.Data?.SessionId) {
    console.warn("travolution_auth_failed", {
      status: response.status,
      providerStatus: data?.Status,
      providerStatusCode: data?.StatusCode,
      description: data?.Description,
    });
    const error = new Error("Travolution authentication failed");
    error.status = response.ok ? 502 : response.status;
    error.details = {
      provider: "travolution",
      status: data?.Status,
      statusCode: data?.StatusCode,
      description: data?.Description,
    };
    throw error;
  }

  const cookieHeader = buildCookieHeader(response.headers, data.Data.SessionId);

  cachedSession = {
    cookieHeader,
    sessionId: data.Data.SessionId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  console.log("travolution_auth_success", {
    statusCode: data.StatusCode,
    hasCookie: Boolean(cookieHeader),
    ttlMinutes: SESSION_TTL_MS / 60000,
  });

  return cachedSession;
}

async function postTravolutionSearch(config, session, searchRequest) {
  const searchUrl = `${config.baseUrl}/restwebsvc/air/searchV1`;
  let response;
  try {
    response = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify(searchRequest),
    });
  } catch (error) {
    throw describeFetchError(error, searchUrl);
  }

  const data = await readJsonResponse(response);
  const shouldRetrySession =
    response.status === 401 ||
    response.status === 403 ||
    isSessionFailure(data);

  return {
    response,
    httpStatus: response.status,
    data,
    shouldRetrySession,
  };
}

function buildTravolutionSearchRequest(payload) {
  const destinations = getSearchSegments(payload).map((segment) => ({
    DepartureAirport: segment.fromCity,
    ArrivalAirport: segment.toCity,
    DepartureDate: toTravolutionDate(segment.depDate),
  }));

  return {
    Data: {
      TravelType: payload.isInternational ? "I" : "D",
      JourneyType: getJourneyType(payload.tripType),
      IsPersonalBooking: "N",
      IsMobileSearchQuery: "N",
      MaxOptionsCount: "100",
      AirOriginDestinations: destinations,
      AirPassengerQuantities: {
        NumAdults: payload.noOfAdults,
        NumChildren: payload.noOfChildren,
        NumInfants: payload.noOfInfant,
      },
      AirSearchPreferences: {
        Carrier: "ANY",
        BookingClass: fareClassMap[payload.fareClass],
        MaxStopovers: 0,
      },
    },
  };
}

function normalizeTravolutionSearchResponse(data, payload) {
  const responseData = data?.Data || {};
  const searchResults = Array.isArray(responseData.AirSearchResult)
    ? responseData.AirSearchResult
    : [];
  const searchFormData =
    responseData.SearchFormData || data.SearchFormData || "";
  const uuid =
    responseData.SearchQueryId ||
    responseData.SearchId ||
    responseData.UUID ||
    responseData.Uuid ||
    data?.uuid ||
    data?.Uuid ||
    buildSearchUuid(searchFormData, payload);
  const options = searchResults.map((option, index) =>
    normalizeTravolutionOption(option, payload, uuid, index),
  );
  const sortedOptions = options
    .filter((option) => Number.isFinite(Number(option.totalFare)))
    .sort((a, b) => Number(a.totalFare) - Number(b.totalFare));
  const limitedOptions = limitOptions(sortedOptions, payload.tripType);

  return {
    status: data.Status || "Success",
    uuid,
    tripType: payload.tripType,
    currencyCode: responseData.CurrencyCode || data.CurrencyCode || "INR",
    totalOptionCount: options.length,
    returnedOptionCount: limitedOptions.length,
    uiLimit: UI_LIMIT,
    searchFormData,
    options: limitedOptions,
  };
}

function buildSearchUuid(searchFormData, payload) {
  if (searchFormData) {
    return `travolution-${createHash("sha256").update(searchFormData).digest("hex").slice(0, 16)}`;
  }

  return `travolution-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
}

function normalizeTravolutionOption(option, payload, uuid, index) {
  const segments = Array.isArray(option?.OptionSegmentsInfo)
    ? option.OptionSegmentsInfo
    : [];
  const firstSegment = segments[0] || {};
  const lastSegment = segments[segments.length - 1] || firstSegment;
  const departure = parseSegmentDateTime(firstSegment, "Departure");
  const arrival = parseSegmentDateTime(lastSegment, "Arrival");
  const priceInfo = option?.OptionPriceInfo || {};
  const baseRate = parseAmount(
    priceInfo.TotalBasePrice ?? option.TotalBasePrice,
  );
  let tax = parseAmount(priceInfo.TotalTax ?? option.TotalTax);
  const totalFare = parseAmount(priceInfo.TotalPrice ?? option.TotalPrice);

  if (
    !Number.isFinite(tax) &&
    Number.isFinite(totalFare) &&
    Number.isFinite(baseRate)
  ) {
    tax = totalFare - baseRate;
  }

  const optionId = parseOptionId(option.OptionId ?? index + 1);
  const fareKey = String(option.FareKey ?? option.OptionId ?? index + 1);

  return {
    id: `travolution:${uuid || "no-uuid"}:${option.OptionId ?? index + 1}`,
    uuid,
    tripType: payload.tripType,
    currencyCode: priceInfo.CurrencyCode || option.CurrencyCode || "INR",
    sectorIndex: getSectorIndex(option, firstSegment, payload),
    fareType: firstSegment.FareType || option.FareType || "RETAIL",
    fareKey,
    optionId,
    provider: "Travolution",
    airlineName:
      firstSegment.MarketingAirline ||
      firstSegment.AirlineName ||
      firstSegment.CarrierCode ||
      "",
    airlineCode: firstSegment.CarrierCode || "",
    flightNumber: String(firstSegment.FlightNumber || "").trim(),
    flightImage: "",
    fromCity: payload.fromCity,
    toCity: payload.toCity,
    sourceCityCode: firstSegment.DepartureAirport || "",
    sourceCityName: firstSegment.DepartureAirportName || "",
    destinationCityCode: lastSegment.ArrivalAirport || "",
    destinationCityName: lastSegment.ArrivalAirportName || "",
    departureAirport: firstSegment.DepartureAirport || "",
    arrivalAirport: lastSegment.ArrivalAirport || "",
    departureDate: departure.date,
    arrivalDate: arrival.date,
    departureTime: departure.time,
    arrivalTime: arrival.time,
    duration: formatDuration(option.JourneyTime || firstSegment.JourneyTime),
    stops: Math.max(segments.length - 1, 0),
    seatsAvailable: getSeatsAvailable(segments, option),
    refundable: option.Refundable || priceInfo.Refundable || "",
    baseRate,
    tax,
    totalFare,
    baggage:
      firstSegment.BaggageRequest ||
      firstSegment.Baggage ||
      option.BaggageRequest ||
      option.Baggage ||
      "",
    cabinClass: firstSegment.CabinClass || option.CabinClass || "",
    legSummary: segments.map(normalizeLegSummary),
  };
}

function getSeatsAvailable(segments, option) {
  for (const segment of segments || []) {
    const value =
      segment.SeatAvailableCount ??
      segment.SeatsAvailable ??
      segment.AvailableSeats;
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return (
    option.SeatAvailableCount ??
    option.SeatsAvailable ??
    option.AvailableSeats ??
    ""
  );
}

function normalizeLegSummary(segment) {
  const departure = parseSegmentDateTime(segment, "Departure");
  const arrival = parseSegmentDateTime(segment, "Arrival");

  return {
    flightCode: segment.CarrierCode || "",
    flightNumber: String(segment.FlightNumber || "").trim(),
    flightName: segment.MarketingAirline || segment.AirlineName || "",
    from: segment.DepartureAirport || "",
    fromCityName: segment.DepartureAirportName || "",
    fromAirport: segment.DepartureAirport || "",
    fromTerminal: segment.DepartureTerminal || "",
    to: segment.ArrivalAirport || "",
    toCityName: segment.ArrivalAirportName || "",
    toAirport: segment.ArrivalAirport || "",
    toTerminal: segment.ArrivalTerminal || "",
    departureDate: departure.date,
    departureTime: departure.time,
    arrivalDate: arrival.date,
    arrivalTime: arrival.time,
    duration: formatDuration(segment.JourneyTime),
    layoverTime: formatDuration(segment.LayoverTime),
    baggage: segment.BaggageRequest || segment.Baggage || "",
    seatsAvailable: segment.SeatAvailableCount ?? segment.SeatsAvailable ?? "",
    flightImage: "",
  };
}

function getSectorIndex(option, firstSegment, payload) {
  if (payload.tripType === "oneWay") {
    return 0;
  }

  if (payload.tripType === "multiCity") {
    return getMultiCitySectorIndex(option, firstSegment, payload);
  }

  if (option.ResultType === "O") {
    return 0;
  }

  if (option.ResultType === "R") {
    return 1;
  }

  const searchSegmentId = Number(option.SearchSegmentId);
  if (searchSegmentId === 0 || searchSegmentId === 1) {
    return searchSegmentId;
  }

  if (searchSegmentId === 2) {
    return 1;
  }

  if (
    firstSegment.DepartureAirport === payload.fromCity &&
    firstSegment.ArrivalAirport === payload.toCity
  ) {
    return 0;
  }

  if (
    firstSegment.DepartureAirport === payload.toCity &&
    firstSegment.ArrivalAirport === payload.fromCity
  ) {
    return 1;
  }

  return 0;
}

function limitOptions(sortedOptions, tripType) {
  if (tripType === "oneWay") {
    return sortedOptions.slice(0, UI_LIMIT);
  }

  if (tripType === "multiCity") {
    return limitBalancedOptions(sortedOptions);
  }

  const selected = [
    ...sortedOptions
      .filter((option) => option.sectorIndex === 0)
      .slice(0, UI_LIMIT / 2),
    ...sortedOptions
      .filter((option) => option.sectorIndex === 1)
      .slice(0, UI_LIMIT / 2),
  ];
  const selectedIds = new Set(selected.map((option) => option.id));

  for (const option of sortedOptions) {
    if (selected.length >= UI_LIMIT) {
      break;
    }
    if (!selectedIds.has(option.id)) {
      selected.push(option);
      selectedIds.add(option.id);
    }
  }

  return selected.sort((a, b) => Number(a.totalFare) - Number(b.totalFare));
}

function validateSearchPayload(payload) {
  if (payload.tripType === "roundTrip" && !payload.arrDate) {
    throw new Error("arrDate is required for roundTrip");
  }

  if (payload.tripType !== "multiCity") {
    if (!payload.fromCity || !payload.toCity || !payload.depDate) {
      throw new Error("fromCity, toCity and depDate are required");
    }
    return;
  }

  if (!Array.isArray(payload.segments)) {
    throw new Error("segments are required for multiCity");
  }

  if (payload.segments.length < 2) {
    throw new Error("multiCity requires at least 2 segments");
  }

  if (payload.segments.length > MAX_MULTI_CITY_SEGMENTS) {
    throw new Error(
      `multiCity supports a maximum of ${MAX_MULTI_CITY_SEGMENTS} segments`,
    );
  }

  payload.segments.forEach((segment, index) => {
    if (segment.fromCity === segment.toCity) {
      throw new Error(
        `multiCity segment ${index + 1} cannot have the same fromCity and toCity`,
      );
    }
  });
}

function getSearchSegments(payload) {
  if (payload.tripType === "multiCity") {
    return payload.segments;
  }

  const segments = [
    {
      fromCity: payload.fromCity,
      toCity: payload.toCity,
      depDate: payload.depDate,
    },
  ];

  if (payload.tripType === "roundTrip") {
    segments.push({
      fromCity: payload.toCity,
      toCity: payload.fromCity,
      depDate: payload.arrDate,
    });
  }

  return segments;
}

function getJourneyType(tripType) {
  if (tripType === "roundTrip") {
    return "R";
  }

  if (tripType === "multiCity") {
    return "M";
  }

  return "O";
}

function getMultiCitySectorIndex(option, firstSegment, payload) {
  const searchSegmentId = Number(option.SearchSegmentId);

  if (Number.isInteger(searchSegmentId)) {
    if (searchSegmentId >= 0 && searchSegmentId < payload.segments.length) {
      return searchSegmentId;
    }

    if (searchSegmentId >= 1 && searchSegmentId <= payload.segments.length) {
      return searchSegmentId - 1;
    }
  }

  const routeMatchedIndex = payload.segments.findIndex(
    (segment) =>
      firstSegment.DepartureAirport === segment.fromCity &&
      firstSegment.ArrivalAirport === segment.toCity,
  );

  return routeMatchedIndex >= 0 ? routeMatchedIndex : 0;
}

function limitBalancedOptions(sortedOptions) {
  const sectorIndexes = [
    ...new Set(sortedOptions.map((option) => option.sectorIndex)),
  ]
    .filter((sectorIndex) => Number.isInteger(Number(sectorIndex)))
    .sort((a, b) => Number(a) - Number(b));

  if (!sectorIndexes.length) {
    return sortedOptions.slice(0, UI_LIMIT);
  }

  const basePerSector = Math.floor(UI_LIMIT / sectorIndexes.length);
  let remainder = UI_LIMIT % sectorIndexes.length;
  const selected = [];
  const selectedIds = new Set();

  for (const sectorIndex of sectorIndexes) {
    const sectorLimit = basePerSector + (remainder > 0 ? 1 : 0);
    remainder = Math.max(remainder - 1, 0);
    for (const option of sortedOptions
      .filter((candidate) => candidate.sectorIndex === sectorIndex)
      .slice(0, sectorLimit)) {
      selected.push(option);
      selectedIds.add(option.id);
    }
  }

  for (const option of sortedOptions) {
    if (selected.length >= UI_LIMIT) {
      break;
    }
    if (!selectedIds.has(option.id)) {
      selected.push(option);
      selectedIds.add(option.id);
    }
  }

  return selected.sort((a, b) => Number(a.totalFare) - Number(b.totalFare));
}

function buildSafeSearchLogContext(payload) {
  return {
    segments: getSearchSegments(payload).map((segment, index) => ({
      index,
      fromCity: segment.fromCity,
      toCity: segment.toCity,
      depDate: segment.depDate,
    })),
  };
}

function countOptionsBySector(options) {
  return options.reduce((counts, option) => {
    const key = String(option.sectorIndex ?? 0);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function throwTravolutionBusinessError(data) {
  const error = new Error("Travolution flight search failed");
  error.status = 502;
  error.details = {
    provider: "travolution",
    status: data?.Status,
    statusCode: data?.StatusCode,
    description: data?.Description,
  };
  throw error;
}

function isSessionFailure(data) {
  if (data?.Status === "Success") {
    return false;
  }

  const statusCode = String(data?.StatusCode || "").toLowerCase();
  const description = String(data?.Description || "").toLowerCase();

  return (
    statusCode.includes("session") ||
    statusCode.includes("auth") ||
    description.includes("session") ||
    description.includes("expired") ||
    description.includes("login") ||
    description.includes("unauthor")
  );
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function buildCookieHeader(headers, sessionId) {
  const cookieParts = getSetCookieHeaders(headers)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean);

  if (!cookieParts.some((cookie) => cookie.startsWith("JSESSIONID="))) {
    cookieParts.push(`JSESSIONID=${sessionId}`);
  }

  return [...new Set(cookieParts)].join("; ");
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combinedSetCookie = headers.get("set-cookie");
  if (!combinedSetCookie) {
    return [];
  }

  return combinedSetCookie.split(/,(?=\s*[^;,]+=)/);
}

function clearCachedSession() {
  cachedSession = {
    cookieHeader: "",
    sessionId: "",
    expiresAt: 0,
  };
}

function toTravolutionDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function parseTravolutionDateTime(value) {
  if (!value) {
    return {
      date: "",
      time: "",
    };
  }

  const normalizedValue = String(value).trim();
  if (/^\d{2}:\d{2}/.test(normalizedValue)) {
    return {
      date: "",
      time: normalizeTime(normalizedValue),
    };
  }

  const [datePart, timePart = ""] = normalizedValue
    .split(",")
    .map((part) => part.trim());

  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    return {
      date: datePart,
      time: normalizeTime(timePart),
    };
  }

  const dateMatch = datePart.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const date = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
    : "";

  return {
    date,
    time: normalizeTime(timePart),
  };
}

function parseSegmentDateTime(segment, fieldPrefix) {
  const dateValue = segment[`${fieldPrefix}Date`];
  const timeValue = segment[`${fieldPrefix}Time`];
  const parsedTimeValue = parseTravolutionDateTime(timeValue);

  if (parsedTimeValue.date || !dateValue) {
    return parsedTimeValue;
  }

  const parsedDateValue = parseTravolutionDateTime(dateValue);

  return {
    date: parsedDateValue.date,
    time: parsedTimeValue.time || parsedDateValue.time,
  };
}

function normalizeTime(value) {
  const timeMatch = String(value || "").match(/^(\d{2}):(\d{2})/);
  return timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : "";
}

function minutesToDuration(minutes) {
  const numericMinutes = Number(minutes);
  if (!Number.isFinite(numericMinutes)) {
    return "";
  }

  const hours = Math.floor(numericMinutes / 60);
  const remainingMinutes = numericMinutes % 60;

  if (!hours) {
    return `${remainingMinutes}m`;
  }

  if (!remainingMinutes) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function formatDuration(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (Number.isFinite(Number(value))) {
    return minutesToDuration(Number(value));
  }

  return String(value);
}

function parseAmount(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const amount = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : undefined;
}

function parseOptionId(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : value;
}
