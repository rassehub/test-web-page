/**
 * TASK-301 — /s/[slug] salon landing (DESIGN §2.1, §9; REQ-001).
 *
 * Render seam (tests/README.md decision 19): async Next 15 default export
 * (params is a Promise) delegating to the named SYNCHRONOUS
 * SalonLandingView, re-exported here for the fixed import path. Unknown
 * slug → notFound() (decision 20 — the framework's 404 digest, never a
 * hand-thrown error). Server component only, plain anchors — zero client
 * JS (REQ-001 Lighthouse DoD). Styles live in src/app/globals.css via the
 * root layout, so this module imports no CSS (renderToString-safe).
 */
import { notFound } from "next/navigation";
import { db } from "../../../../db/client";
import { createRepos, findSalonBySlug } from "../../../../repos";
import { SalonLandingView } from "./view";

export { SalonLandingView } from "./view";

export const dynamic = "force-dynamic";

export default async function SalonLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const salon = await findSalonBySlug(db, slug);
  if (!salon) notFound();

  const repos = createRepos(db, { salonId: salon.id });
  const [services, workingHours] = await Promise.all([
    repos.services.list({ active: true }),
    repos.workingHours.list(),
  ]);

  return (
    <SalonLandingView
      salon={{
        name: salon.name,
        slug: salon.slug,
        address: salon.address,
        phone: salon.phone,
        email: salon.email,
      }}
      services={services.map((service) => ({
        name: service.name,
        priceCents: service.priceCents,
        durationMinutes: service.durationMinutes,
      }))}
      workingHours={workingHours.map((hours) => ({
        isoWeekday: hours.isoWeekday,
        startMinute: hours.startMinute,
        endMinute: hours.endMinute,
      }))}
    />
  );
}
