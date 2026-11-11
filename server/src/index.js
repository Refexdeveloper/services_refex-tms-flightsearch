import express from "express";
import cors from "cors";
import helmet from "helmet";
import { flightsRouter } from "./routes/flights.js";
import { airportsRouter } from "./routes/airports.js";

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "refex-tms-flightsearch-formcomponent",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    policy: {
      advanceBookingDays: Number(process.env.FARE_POLICY_ADVANCE_DAYS || 15),
      timezone: process.env.FARE_TRACKING_TIMEZONE || "Asia/Kolkata"
    },
    provider: "travolution"
  });
});

app.use("/api/airports", airportsRouter);
app.use("/api/flights", flightsRouter);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  console.error("request_failed", {
    status,
    message: err.message,
    details: err.details || undefined,
    causeCode: err.cause?.code,
    causeMessage: err.cause?.message
  });
  res.status(status).json({
    ok: false,
    error: err.message || "Internal server error",
    details: err.details || undefined
  });
});

app.listen(port, () => {
  console.log(`Refex TMS Flight Search service listening on port ${port}`);
});
