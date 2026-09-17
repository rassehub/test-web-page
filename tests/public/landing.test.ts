/**
 * TASK-300 — Landing page render-contract specs (RED-first).
 *
 * Design ref: docs/DESIGN.md §2.1 (/s/[slug] Page — "Salon landing: services,
 * prices, hours", Sprint 3, REQ-001), §9 (path FIXED:
 * src/app/(public)/s/[slug]/page.tsx), §3.5 (working_hours weekday union).
 * REQ-001 AC: "landing renders its service list, prices, hours".
 *
 * RENDER-CONTRACT SEAM (spec decision — see tests/README.md Sprint 3
 * decisions; document for TASK-301):
 *   src/app/(public)/s/[slug]/page.tsx MUST export
 *     - default: async Next 15 Page, props { params: Promise<{ slug }> };
 *       unknown slug ⇒ calls notFound() from next/navigation.
 *     - SalonLandingView (named): SYNCHRONOUS presentational component,
 *       props { salon: { name, slug },
 *               services: Array<{ name, priceCents }>,
 *               workingHours: Array<{ isoWeekday, startMinute, endMinute }> }
 *       renderable via react-dom/server renderToString OUTSIDE any Next
 *       request context — therefore a plain <a href> for the booking link,
 *       NOT next/link (Link requires app-router context and would throw).
 *   The async default loads data (repos by slug-scope, §4) and delegates to
 *   SalonLandingView. A re-export (`export { SalonLandingView } from "./view"`)
 *   from page.tsx also satisfies this contract — the import path is fixed.
 *
 * NOT-FOUND IDIOM (choice documented): assert the thrown notFound() digest
 * "NEXT_HTTP_ERROR_FALLBACK;404" — the framework-set marker Next 15's
 * not-found boundary keys on. The implementer MUST produce it by calling
 * notFound(), never by hand-throwing a matching error. [CONF: MED]
 * [SRC: DOC — Next.js internal error digest contract]
 *
 * FORMAT PINS (binding for TASK-301): price = Intl.NumberFormat("fi-FI",
 * { style: "currency", currency: "EUR" }).format(priceCents / 100); weekday
 * labels = English long form via Intl.DateTimeFormat("en", { weekday: "long" })
 * (i18n out of scope, DESIGN §10).
 *
 * Rendering needs NO database — the view takes props (the DB-gated describe
 * below covers only the unknown-slug leg through the async default export).
 * RED at import until TASK-301 lands the page. NO new devDep: react-dom
 * (runtime dep) ships renderToString; the spec stays a plain .ts file using
 * createElement because vitest only picks up .test.ts files.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import LandingPage, { SalonLandingView } from "../../src/app/(public)/s/[slug]/page";
import type { Pool } from "pg";
import { getDbStatus, makePool } from "../helpers/db";

const status = await getDbStatus();
const pool: Pool | null = status.ready ? makePool() : null;

afterAll(async () => {
  await pool?.end();
});

// --- view seam types + helpers -----------------------------------------------

interface ViewProps {
  salon: { name: string; slug: string };
  services: Array<{ name: string; priceCents: number }>;
  workingHours: Array<{ isoWeekday: number; startMinute: number; endMinute: number }>;
}

/** REQ-001 price pin: fi-FI EUR formatting of integer cents. */
const eur = (cents: number): string =>
  new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR" }).format(cents / 100);

/** REQ-001 weekday-label pin: English long labels; 2024-01-01 is an ISO Monday. */
const weekdayLabel = (isoWeekday: number): string =>
  new Intl.DateTimeFormat("en", { weekday: "long" }).format(new Date(Date.UTC(2024, 0, 1 + (isoWeekday - 1))));

function renderView(props: ViewProps): string {
  return renderToString(createElement(SalonLandingView as ComponentType<ViewProps>, props));
}

const PROPS: ViewProps = {
  salon: { name: "Kampaamo Helmi", slug: "helmi" },
  services: [
    { name: "Cut & Style", priceCents: 4_500 },
    { name: "Beard Trim", priceCents: 2_500 },
  ],
  workingHours: [
    { isoWeekday: 1, startMinute: 540, endMinute: 1020 }, // Monday
    { isoWeekday: 3, startMinute: 600, endMinute: 1080 }, // Wednesday
  ],
};

describe("SalonLandingView render contract (§2.1, §9; REQ-001) — no DB needed", () => {
  // Behavior: the SSR output names the salon and carries a link to the
  // booking wizard at /s/[slug]/book (plain anchor href — REQ-001 landing is
  // the wizard entry point).
  it("REQ-001/§2.1: rendered HTML contains the salon name and an href to /s/helmi/book", () => {
    const html = renderView(PROPS);
    expect(html).toContain("Kampaamo Helmi");
    expect(html).toContain('href="/s/helmi/book"');
  });

  // Behavior: every service name and its fi-FI-EUR-formatted price (integer
  // cents) appears in the SSR output (REQ-001 AC: "service list, prices").
  it("REQ-001/§2.1: every service name renders with its formatted price (fi-FI EUR from cents)", () => {
    const html = renderView(PROPS);
    expect(html).toContain("Cut &" + "amp; Style"); // SSR-escaped entity form (react-dom escapes &)
    expect(html).toContain(eur(4_500)); // "45,00 €"
    expect(html).toContain("Beard Trim");
    expect(html).toContain(eur(2_500)); // "25,00 €"
  });

  // Behavior: the opening-hours summary covers exactly the weekday union of
  // the provided working_hours — Monday and Wednesday labels present, a
  // weekday with no entries (Tuesday) absent (REQ-001 AC: "hours"; §3.5
  // union, not per-employee rows).
  it("REQ-001/§3.5: weekday labels render for the working_hours union only — Monday/Wednesday in, Tuesday out", () => {
    const html = renderView(PROPS);
    expect(html).toContain(weekdayLabel(1)); // Monday
    expect(html).toContain(weekdayLabel(3)); // Wednesday
    expect(html).not.toContain(weekdayLabel(2)); // Tuesday — no entries seeded
  });
});

describe.skipIf(!status.ready)("unknown slug → notFound (§2.1; REQ-001)", () => {
  // Behavior: the async default export signals Next's 404 boundary for an
  // unknown slug by rejecting with the notFound() digest marker.
  it("REQ-001/§2.1: default export for unknown slug rejects with digest 'NEXT_HTTP_ERROR_FALLBACK;404'", async () => {
    const page = LandingPage as unknown as (p: { params: Promise<{ slug: string }> }) => Promise<unknown>;
    const ghost = `ghost-${randomUUID()}`;
    await expect(page({ params: Promise.resolve({ slug: ghost }) })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});
