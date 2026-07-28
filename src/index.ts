import express from "express";
import rateLimit from "express-rate-limit";

const PORT = process.env.PORT ?? "3000";
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const CLIENT_TOKEN = process.env.CLIENT_TOKEN;

if (!API_FOOTBALL_KEY || !CLIENT_TOKEN) {
  throw new Error("API_FOOTBALL_KEY and CLIENT_TOKEN must both be set");
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const app = express();

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use((req, res, next) => {
  if (req.header("x-flashpoint-client") !== CLIENT_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

// Dumb, single-purpose proxy: forwards one whitelisted upstream path/query verbatim
// and injects the secret key. No caching, no business logic — that lives in the app.
app.get("/fixtures", async (req, res) => {
  const date = req.query.date;
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }

  const upstream = await fetch(
    `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(date)}`,
    { headers: { "x-apisports-key": API_FOOTBALL_KEY } }
  );
  const body = await upstream.text();
  res.status(upstream.status).type("application/json").send(body);
});

app.listen(Number(PORT), () => {
  console.log(`flashpoint-api-proxy listening on ${PORT}`);
});
