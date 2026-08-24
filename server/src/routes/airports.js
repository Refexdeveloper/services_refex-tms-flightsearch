import express from "express";
import { getAirportStats, searchAirports } from "../services/airportSearch.js";

export const airportsRouter = express.Router();

airportsRouter.get("/search", (req, res) => {
  const term = req.query.term || "";
  const limit = Math.min(Number(req.query.limit || 10), 20);

  res.json({
    ok: true,
    query: term,
    limit,
    results: searchAirports(term, limit)
  });
});

airportsRouter.get("/stats", (_req, res) => {
  res.json({
    ok: true,
    ...getAirportStats()
  });
});
