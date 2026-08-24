import express from "express";
import { searchFlights } from "../services/travolutionClient.js";

export const flightsRouter = express.Router();

flightsRouter.post("/search", async (req, res, next) => {
  try {
    const result = await searchFlights(req.body);
    res.json({
      ok: true,
      source: "travolution",
      result
    });
  } catch (error) {
    next(error);
  }
});
