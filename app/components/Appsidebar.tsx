// app/components/Appsidebar.tsx   (replaces the game sidebar)
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import {
  Home,
  ListMusic,
  Loader2,
  Music2,
  PlusCircle,
  Settings,
  Star,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSongList } from "@/hooks/useSongs";

const NAV_ITEMS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/songs/new", label: "New song", icon: PlusCircle },
  { href: "/songs", label: "My songs", icon: ListMusic },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

const CUT =
  "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))";

function GroupLabel({ children }: { children: string }) {
  return (
    <SidebarGroupLabel className="font-mono text-[10px] uppercase tracking-[0.3em] text-fuchsia-400/90">
      {children}
    </SidebarGroupLabel>
  );
}

function Note({ children }: { children: string }) {
  return (
    <p className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-white/40">
      {children}
    </p>
  );
}

export function AppSidebar() {
  const { user, isSignedIn } = useUser();
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const songs = useSongList();

  if (!isSignedIn) return null;

  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const recent = songs?.slice(0, 8) ?? [];

  return (
    <Sidebar>
      <SidebarHeader className="relative overflow-hidden border-b border-cyan-400/20 p-0">
        <div aria-hidden className="cyber-noise" />
        <div aria-hidden className="cyber-scanlines" />
        <div aria-hidden className="cyber-beam" />
        <div className="relative z-10 flex items-center gap-3 px-4 py-4">
          <Music2 className="size-8 text-cyan-300 drop-shadow-[0_0_10px_var(--accent-400)]" />
          <div>
            <p className="text-sm font-black uppercase leading-tight tracking-wide">
              <span
                className="text-cyan-300"
                style={{ textShadow: "0 0 8px currentColor" }}
              >
                Song
              </span>{" "}
              <span
                className="text-fuchsia-400"
                style={{ textShadow: "0 0 8px currentColor" }}
              >
                Writer
              </span>
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/50">
              Chords + lyrics
            </p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="bg-transparent">
        <SidebarGroup>
          <GroupLabel>Menu</GroupLabel>
          <SidebarMenu>
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === href}
                  className="cyber-nav"
                >
                  <Link href={href} onClick={closeOnMobile}>
                    <Icon size={16} />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <GroupLabel>Recent songs</GroupLabel>
          <SidebarMenu>
            {songs === undefined && <Note>Loading…</Note>}
            {songs !== undefined && recent.length === 0 && (
              <Note>No songs yet</Note>
            )}
            {recent.map((s) => (
              <SidebarMenuItem key={s._id}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === `/songs/${s._id}`}
                  className="cyber-nav"
                >
                  <Link href={`/songs/${s._id}`} onClick={closeOnMobile}>
                    {s.status === "generating" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : s.isFavorite ? (
                      <Star
                        size={16}
                        className="fill-current text-yellow-400"
                      />
                    ) : (
                      <Music2 size={16} />
                    )}
                    <span className="truncate">{s.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        {user && (
          <div
            style={{ clipPath: CUT }}
            className="relative flex items-center gap-3 border border-fuchsia-400/40 bg-black/60 px-3 py-2"
          >
            <div aria-hidden className="cyber-scanlines" />
            <div className="relative min-w-0">
              <p className="truncate text-xs font-bold uppercase tracking-wide text-white">
                {user.fullName ?? user.username}
              </p>
              <p className="truncate font-mono text-[10px] text-cyan-300/70">
                {user.primaryEmailAddress?.emailAddress}
              </p>
            </div>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
