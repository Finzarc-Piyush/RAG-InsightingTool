/**
 * Wave AD7 follow-up · horizontal tab strip mounted at the top of every
 * admin / superadmin page so the user can move between Overview, Sessions,
 * Dashboards, Costs, and Context Packs without going back to the landing.
 *
 * Active tab is computed from the current wouter location. Renders nothing
 * on routes that aren't admin pages so the component is safe to add to a
 * shared layout.
 */
import { useLocation } from "wouter";

interface NavItem {
  href: string;
  label: string;
  /** Match function — true if the current location belongs to this tab. */
  isActive: (loc: string) => boolean;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    href: "/superadmin",
    label: "Overview",
    isActive: (loc) =>
      loc === "/superadmin" ||
      loc === "/superadmin/" ||
      loc.startsWith("/superadmin?"),
  },
  {
    href: "/superadmin/sessions",
    label: "Sessions",
    isActive: (loc) => loc.startsWith("/superadmin/sessions"),
  },
  {
    href: "/superadmin/dashboards",
    label: "Dashboards",
    isActive: (loc) => loc.startsWith("/superadmin/dashboards"),
  },
  {
    href: "/admin/costs",
    label: "Costs",
    isActive: (loc) => loc.startsWith("/admin/costs"),
  },
  {
    href: "/admin/context-packs",
    label: "Context packs",
    isActive: (loc) => loc.startsWith("/admin/context-packs"),
  },
  {
    href: "/admin/semantic-models",
    label: "Semantic models",
    isActive: (loc) => loc.startsWith("/admin/semantic-models"),
  },
];

export function AdminNav() {
  const [location, setLocation] = useLocation();
  return (
    <div className="border-b border-border/60 bg-card/40">
      <nav
        className="container mx-auto px-4 sm:px-6 max-w-7xl flex items-center gap-1 overflow-x-auto"
        aria-label="Admin sections"
      >
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(location);
          return (
            <button
              key={item.href}
              type="button"
              onClick={() => setLocation(item.href)}
              className={
                active
                  ? "px-3 py-2.5 text-sm font-medium text-primary border-b-2 border-primary -mb-px whitespace-nowrap"
                  : "px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground border-b-2 border-transparent -mb-px whitespace-nowrap"
              }
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
