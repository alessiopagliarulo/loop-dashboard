"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Info } from "lucide-react";
import { NAV_ITEMS, PROJECT_NAV, GLOBAL_NAV, type NavItem } from "@/lib/nav";
import { useProject } from "@/components/project-context";
import ProjectSwitcher from "@/components/map/project-switcher";
// From lib/demo/world.ts, not lib/public-access.ts: this is a Client Component,
// and public-access imports lib/auth.ts. See the constant's comment for why.
import { DEMO_SNAPSHOT_LABEL } from "@/lib/demo/world";

/**
 * App shell: a fixed left sidebar on desktop, a fixed bottom tab bar on mobile.
 * The global project switcher sits at the top of the sidebar; the nav is split
 * into a "This project" group (scoped) and a "Global" group (shared). Active
 * section is derived from the current pathname.
 *
 * `demoMode` comes from the server layout (`isPublicViewer()` — see
 * lib/demo/viewer.ts) and never changes client-side. When true this renders
 * the anonymous-visitor experience: a banner explaining the data is a frozen
 * snapshot of two real public repositories rather than the owner's live
 * private repos, and a
 * "Sign in" link wherever "Sign out" would otherwise be — signing out of a
 * session the visitor never had would just be confusing.
 */
export default function AppShell({
  children,
  demoMode,
}: {
  children: React.ReactNode;
  demoMode: boolean;
}) {
  const pathname = usePathname();
  const { project, setProject, refreshProjects } = useProject();

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + "/");
  }

  function onSelect(key: string) {
    setProject(key);
    // Keep the registry fresh (e.g. right after adding a new project).
    void refreshProjects();
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-zinc-800 bg-zinc-900 md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-zinc-800 px-5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            Loop Dashboard
          </span>
        </div>

        <div className="border-b border-zinc-800 p-3">
          <ProjectSwitcher selected={project} onSelect={onSelect} />
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          <NavGroup label="This project" dot="bg-emerald-500" items={PROJECT_NAV} isActive={isActive} />
          <NavGroup label="Global" dot="bg-violet-400" items={GLOBAL_NAV} isActive={isActive} />
        </nav>

        <div className="border-t border-zinc-800 p-3">
          {demoMode ? <SignInLink /> : <LogoutButton />}
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/95 px-4 backdrop-blur md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
          <ProjectSwitcher selected={project} onSelect={onSelect} />
        </div>
        {demoMode ? <SignInLink compact /> : <LogoutButton compact />}
      </header>

      {/* Content */}
      <main className="md:pl-60">
        <div className="mx-auto max-w-5xl px-4 pb-24 pt-6 md:px-8 md:pb-10">
          {demoMode && <DemoBanner />}
          {children}
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-zinc-800 bg-zinc-900/95 backdrop-blur md:hidden">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-1 py-2 text-[10px] font-medium transition ${
              isActive(href)
                ? "text-emerald-400"
                : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            <Icon className="h-5 w-5" />
            <span className="truncate px-0.5">{shortLabel(label)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

function NavGroup({
  label,
  dot,
  items,
  isActive,
}: {
  label: string;
  dot: string;
  items: NavItem[];
  isActive: (href: string) => boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </p>
      {items.map(({ href, label: itemLabel, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
            isActive(href)
              ? "bg-emerald-500/10 text-emerald-400"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          }`}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {itemLabel}
        </Link>
      ))}
    </div>
  );
}

function shortLabel(label: string) {
  // Bottom tab bar is tight — use the first word.
  return label.split(" ")[0];
}

function LogoutButton({ compact = false }: { compact?: boolean }) {
  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    // A full page load, not a client-side push: signing out must drop every
    // piece of client state, and `replace` keeps Back from reopening the app.
    window.location.replace("/login");
  }
  return (
    <button
      onClick={logout}
      className={`text-zinc-400 transition hover:text-zinc-100 ${
        compact
          ? "shrink-0 text-xs"
          : "w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-800"
      }`}
    >
      Sign out
    </button>
  );
}

/**
 * Replaces `LogoutButton` for anonymous demo visitors. It's a real link (not a
 * button that calls /api/logout) — there is no session to clear, just a page
 * to send the visitor to.
 */
function SignInLink({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href="/login"
      className={`text-zinc-400 transition hover:text-zinc-100 ${
        compact
          ? "shrink-0 text-xs"
          : "block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-800"
      }`}
    >
      Sign in
    </Link>
  );
}

/**
 * Persistent, dismissable-by-navigation-only notice shown at the top of every
 * page for anonymous visitors. `role="status"` makes it an assistive-tech
 * landmark without the interruption of `alert` — this isn't an error, it's
 * context the visitor should have before trusting anything below it.
 *
 * Amber rather than red on purpose: nothing is wrong. The data really is a
 * frozen snapshot — real issues, pull requests, audits and metrics from the
 * owner's two public repos, captured on a fixed date and baked in, because the
 * public deployment deliberately holds no GitHub token (see lib/demo/world.ts).
 */
function DemoBanner() {
  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 sm:items-center sm:text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400 sm:mt-0" />
      <p>
        You&apos;re viewing a read-only demo of a real system. Everything below is a
        frozen snapshot of the owner&apos;s actual loop, taken from the public repos{" "}
        <code className="rounded bg-amber-500/15 px-1">alessiopagliarulo/content-generation-platform</code>{" "}
        and <code className="rounded bg-amber-500/15 px-1">alessiopagliarulo/supply-chain-optimizer</code> —
        real issues, pull requests and agent audits, not live data. {DEMO_SNAPSHOT_LABEL}.{" "}
        <Link href="/login" className="font-medium text-amber-100 underline underline-offset-2 hover:text-white">
          Sign in
        </Link>{" "}
        to use live data.
      </p>
    </div>
  );
}
