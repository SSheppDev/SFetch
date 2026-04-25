import { NavLink, Outlet } from 'react-router-dom'
import {
  Database,
  Calendar,
  ScrollText,
  Settings,
  ListOrdered,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/objects', label: 'Objects', icon: Database },
  { to: '/sync-order', label: 'Sync Order', icon: ListOrdered },
  { to: '/schedules', label: 'Schedules', icon: Calendar },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
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

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-[var(--color-background)]">
        <Outlet />
      </main>
    </div>
  )
}
