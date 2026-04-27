import { useState, useRef, useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Database,
  Calendar,
  ScrollText,
  Settings,
  ListOrdered,
  ChevronDown,
  Plus,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOrg } from '@/lib/orgContext'

const navItems = [
  { to: '/objects', label: 'Objects', icon: Database },
  { to: '/sync-order', label: 'Sync Order', icon: ListOrdered },
  { to: '/schedules', label: 'Schedules', icon: Calendar },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings },
]

function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrgId } = useOrg()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const label = activeOrg?.alias ?? activeOrg?.username ?? 'Pick an org'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-sm hover:bg-[var(--color-accent)] transition-colors"
      >
        <span className="font-medium text-[var(--color-foreground)]">{label}</span>
        {activeOrg && (
          <span className="text-[10px] font-mono text-[var(--color-muted-foreground)]">
            {activeOrg.orgId.slice(0, 8)}…
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] shadow-lg z-50">
          <div className="py-1 max-h-80 overflow-y-auto">
            {orgs.map((o) => (
              <button
                key={o.orgId}
                onClick={() => {
                  void setActiveOrgId(o.orgId)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-2 hover:bg-[var(--color-accent)] flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-foreground)] truncate">
                    {o.alias ?? o.username}
                  </p>
                  <p className="text-[10px] font-mono text-[var(--color-muted-foreground)] truncate">
                    {o.schemaName}
                  </p>
                </div>
                {o.orgId === activeOrg?.orgId && (
                  <Check className="h-3.5 w-3.5 text-[var(--color-primary)] flex-shrink-0" />
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--color-border)]">
            <button
              onClick={() => {
                setOpen(false)
                navigate('/onboarding')
              }}
              className="w-full text-left px-3 py-2 hover:bg-[var(--color-accent)] flex items-center gap-2 text-sm text-[var(--color-foreground)]"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another org
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] flex flex-col">
        <div className="px-4 py-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-[var(--color-primary)] flex items-center justify-center">
              <Database className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold text-sm text-[var(--color-foreground)]">sfetch</span>
          </div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]'
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-auto bg-[var(--color-background)]">
        <header className="sticky top-0 z-40 flex items-center justify-end gap-3 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 backdrop-blur px-6 py-2.5">
          <OrgSwitcher />
        </header>
        <Outlet />
      </main>
    </div>
  )
}
