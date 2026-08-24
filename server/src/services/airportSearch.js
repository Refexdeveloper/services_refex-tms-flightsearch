import fs from "node:fs";
import path from "node:path";

let airportCache = null;

const PREFERRED_AIRPORTS_BY_QUERY = {
  paris: ["CDG", "ORY", "LBG"],
  london: ["LHR", "LGW", "STN", "LTN", "LCY"],
  "new york": ["JFK", "EWR", "LGA"],
  newyork: ["JFK", "EWR", "LGA"],
  nyc: ["JFK", "EWR", "LGA"],
  dubai: ["DXB", "DWC"],
  singapore: ["SIN"],
  munich: ["MUC"],
  chennai: ["MAA"],
  madras: ["MAA"],
  delhi: ["DEL"],
  "new delhi": ["DEL"],
  newdelhi: ["DEL"],
  bengaluru: ["BLR"],
  bangalore: ["BLR"],
  mumbai: ["BOM"],
  bombay: ["BOM"],
  hyderabad: ["HYD"],
  kolkata: ["CCU"],
  calcutta: ["CCU"]
}; 

const AIRPORT_QUERY_ALIASES = {
  bangalore: "bengaluru",
  bombay: "mumbai",
  calcutta: "kolkata",
  madras: "chennai",
  newdelhi: "new delhi",
  nyc: "new york"
};

function loadAirportData() {
  if (airportCache) {
    return airportCache;
  }

  const filePath = path.resolve("public/data/airports.json");
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));

  airportCache = {
    source: parsed.source,
    generatedAt: parsed.generatedAt,
    count: parsed.count,
    airports: parsed.airports || []
  };

  return airportCache;
}

function getAirportRank(airport, query) {
  const code = String(airport.code || "").toLowerCase();
  const city = String(airport.city || "").toLowerCase();
  const name = String(airport.name || "").toLowerCase();
  const country = String(airport.country || "").toLowerCase();
  const searchText = String(airport.searchText || "").toLowerCase();

  let bucket = 999;
  let score = 0;

  if (code === query) {
    bucket = 1;
    score = 100;
  } else if (city === query) {
    bucket = 2;
    score = 100;
  } else if (city.startsWith(query)) {
    bucket = 3;
    score = 80;
  } else if (name.startsWith(query)) {
    bucket = 4;
    score = 70;
  } else if (code.includes(query)) {
    bucket = 5;
    score = 60;
  } else if (city.includes(query)) {
    bucket = 6;
    score = 50;
  } else if (name.includes(query)) {
    bucket = 7;
    score = 40;
  } else if (searchText.includes(query)) {
    bucket = 8;
    score = 20;
  } else {
    return null;
  }

  const countryBoost = country === "in" ? 2 : 0;
  const sizeBoost = airport.type === "large_airport" ? 2 : airport.type === "medium_airport" ? 1 : 0;

  return {
    bucket,
    score: score + countryBoost + sizeBoost,
    countryBoost,
    sizeBoost
  };
}

export function searchAirports(term, limit = 10) {
  const rawQuery = String(term || "").trim().toLowerCase();
  const compactQuery = rawQuery.replace(/\s+/g, "");

  const query = AIRPORT_QUERY_ALIASES[compactQuery] || rawQuery;

  if (query.length < 2) {
    return [];
  }

  const data = loadAirportData();

  return data.airports
    .map((airport) => ({
      airport,
      rank: getAirportRank(airport, query)
    }))
    .filter((item) => item.rank)
    .sort((a, b) => {
      const preferredCodes = PREFERRED_AIRPORTS_BY_QUERY[query.replace(/\s+/g, " ")] || PREFERRED_AIRPORTS_BY_QUERY[query.replace(/\s+/g, "")] || [];
      const aPreferredIndex = preferredCodes.indexOf(a.airport.code);
      const bPreferredIndex = preferredCodes.indexOf(b.airport.code);

      if (aPreferredIndex !== -1 || bPreferredIndex !== -1) {
        if (aPreferredIndex === -1) return 1;
        if (bPreferredIndex === -1) return -1;
        return aPreferredIndex - bPreferredIndex;
      }

      if (a.rank.bucket !== b.rank.bucket) {
        return a.rank.bucket - b.rank.bucket;
      }

      if (b.rank.score !== a.rank.score) {
        return b.rank.score - a.rank.score;
      }

      const sizeRank = {
        large_airport: 0,
        medium_airport: 1,
        small_airport: 2
      };

      const aSize = sizeRank[a.airport.type] ?? 9;
      const bSize = sizeRank[b.airport.type] ?? 9;

      if (aSize !== bSize) {
        return aSize - bSize;
      }

      const aCountry = a.airport.country === "IN" ? 0 : 1;
      const bCountry = b.airport.country === "IN" ? 0 : 1;

      if (aCountry !== bCountry) {
        return aCountry - bCountry;
      }

      return String(a.airport.display || "").localeCompare(String(b.airport.display || ""));
    })
    .slice(0, limit)
    .map(({ airport }) => ({
      code: airport.code,
      city: airport.city,
      name: airport.name,
      country: airport.country,
      type: airport.type,
      display: airport.display,
      latitude: airport.latitude,
      longitude: airport.longitude
    }));
}

export function getAirportStats() {
  const data = loadAirportData();

  return {
    source: data.source,
    generatedAt: data.generatedAt,
    count: data.count
  };
}
