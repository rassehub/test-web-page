/**
 * TASK-302 — GET /api/public/salons/[slug]/services (DESIGN §2.3; REQ-002).
 *
 * Auth: none (public catalog — invoked in tests with no session and no
 * next/headers mock). Scope resolved from the unique slug; unknown slug → 404
 * (no existence leak, §2.3 rule). DTO pin (catalog-routes spec): items
 * EXACTLY { id, name, durationMinutes, priceCents } — active rows only,
 * sorted by name; no buffer fields, no timestamps.
 */
import { db } from "../../../../../../db/client";
import { createRepos, findSalonBySlug } from "../../../../../../repos";

export const dynamic = "force-dynamic";

interface ServiceDto {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const salon = await findSalonBySlug(db, slug);
  if (!salon) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

  const services = await createRepos(db, { salonId: salon.id }).services.list({ active: true });
  const body: ServiceDto[] = services
    .map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      priceCents: service.priceCents,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Response.json(body);
}
