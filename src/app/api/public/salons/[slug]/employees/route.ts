/**
 * TASK-302 — GET /api/public/salons/[slug]/employees (DESIGN §2.3; REQ-003).
 *
 * Auth: none (public catalog). Scope resolved from the unique slug; unknown
 * slug → 404 (no existence leak, §2.3 rule). DTO pin (catalog-routes spec):
 * items EXACTLY { id, displayName, title } — active rows only, sorted by
 * displayName; title round-trips null when unset (§3.4 nullable column).
 */
import { db } from "../../../../../../db/client";
import { createRepos, findSalonBySlug } from "../../../../../../repos";

export const dynamic = "force-dynamic";

interface EmployeeDto {
  id: string;
  displayName: string;
  title: string | null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const salon = await findSalonBySlug(db, slug);
  if (!salon) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

  const employees = await createRepos(db, { salonId: salon.id }).employees.list({ active: true });
  const body: EmployeeDto[] = employees
    .map((employee) => ({
      id: employee.id,
      displayName: employee.displayName,
      title: employee.title,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return Response.json(body);
}
