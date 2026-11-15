import type { StatementFamily } from "@finn/shared";
import { closeDb, getDb } from "./client";

interface SeedCompany {
  symbol: string;
  name: string;
  family: StatementFamily;
  sector: string;
  holding: boolean;
}

/** Demo portfolio (18) plus the ad-hoc research set (4). Mixed sectors, sizes and statement formats. */
export const SEED_COMPANIES: SeedCompany[] = [
  { symbol: "RELIANCE", name: "Reliance Industries Ltd", family: "industrial", sector: "Energy & Retail", holding: true },
  { symbol: "HDFCBANK", name: "HDFC Bank Ltd", family: "banking", sector: "Banks", holding: true },
  { symbol: "ICICIBANK", name: "ICICI Bank Ltd", family: "banking", sector: "Banks", holding: true },
  { symbol: "TCS", name: "Tata Consultancy Services Ltd", family: "industrial", sector: "IT Services", holding: true },
  { symbol: "INFY", name: "Infosys Ltd", family: "industrial", sector: "IT Services", holding: true },
  { symbol: "BHARTIARTL", name: "Bharti Airtel Ltd", family: "industrial", sector: "Telecom", holding: true },
  { symbol: "ITC", name: "ITC Ltd", family: "industrial", sector: "FMCG", holding: true },
  { symbol: "LT", name: "Larsen & Toubro Ltd", family: "industrial", sector: "Capital Goods", holding: true },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries Ltd", family: "industrial", sector: "Pharma", holding: true },
  { symbol: "TITAN", name: "Titan Company Ltd", family: "industrial", sector: "Consumer Durables", holding: true },
  { symbol: "BAJFINANCE", name: "Bajaj Finance Ltd", family: "nbfc", sector: "NBFC", holding: true },
  { symbol: "MARUTI", name: "Maruti Suzuki India Ltd", family: "industrial", sector: "Auto", holding: true },
  { symbol: "TRENT", name: "Trent Ltd", family: "industrial", sector: "Retail", holding: true },
  { symbol: "ETERNAL", name: "Eternal Ltd", family: "industrial", sector: "Internet", holding: true },
  { symbol: "DIXON", name: "Dixon Technologies (India) Ltd", family: "industrial", sector: "Electronics Mfg", holding: true },
  { symbol: "POLYCAB", name: "Polycab India Ltd", family: "industrial", sector: "Cables & Wires", holding: true },
  { symbol: "PERSISTENT", name: "Persistent Systems Ltd", family: "industrial", sector: "IT Services", holding: true },
  { symbol: "ADANIPORTS", name: "Adani Ports and Special Economic Zone Ltd", family: "industrial", sector: "Ports", holding: true },
  { symbol: "ASTRAL", name: "Astral Ltd", family: "industrial", sector: "Building Materials", holding: false },
  { symbol: "PAGEIND", name: "Page Industries Ltd", family: "industrial", sector: "Apparel", holding: false },
  { symbol: "DEEPAKNTR", name: "Deepak Nitrite Ltd", family: "industrial", sector: "Chemicals", holding: false },
  { symbol: "CDSL", name: "Central Depository Services (India) Ltd", family: "industrial", sector: "Capital Markets", holding: false },
];

export const DEFAULT_ALERT_RULES = [
  { name: "Big daily move", definition: { type: "price_move", scope: { kind: "portfolio" }, direction: "either", thresholdPct: 5 } },
  { name: "Volume spike", definition: { type: "volume_spike", scope: { kind: "portfolio" }, multiple: 2 } },
  {
    name: "Material filings",
    definition: { type: "category", scope: { kind: "portfolio" }, categories: ["results", "m_and_a", "management_change", "credit_rating", "pledging"] },
  },
];

export async function seed(): Promise<void> {
  const sql = getDb({ max: 1 });
  for (const c of SEED_COMPANIES) {
    await sql`
      INSERT INTO companies (symbol, name, statement_family, sector, screener_slug)
      VALUES (${c.symbol}, ${c.name}, ${c.family}, ${c.sector}, ${c.symbol})
      ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, sector = EXCLUDED.sector, updated_at = now()`;
    if (c.holding) await sql`INSERT INTO holdings (symbol) VALUES (${c.symbol}) ON CONFLICT DO NOTHING`;
  }
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM alert_rules`;
  if (count === 0) {
    for (const r of DEFAULT_ALERT_RULES) {
      await sql`INSERT INTO alert_rules (name, definition) VALUES (${r.name}, ${sql.json(r.definition)})`;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => console.log(`Seeded ${SEED_COMPANIES.length} companies`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
