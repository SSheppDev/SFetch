import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { SessionExpiredBanner } from './components/SessionExpiredBanner'
import { Toaster } from './components/ui/toaster'
import { OrgProvider, useOrg } from './lib/orgContext'

import Onboarding from './pages/Onboarding'
import Objects from './pages/Objects'
import Fields from './pages/Fields'
import Schedules from './pages/Schedules'
import Logs from './pages/Logs'
import SettingsPage from './pages/Settings'
import SyncOrder from './pages/SyncOrder'

function OrgGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const { orgs, loading } = useOrg()

  useEffect(() => {
    if (!loading && orgs.length === 0) {
      navigate('/onboarding', { replace: true })
    }
  }, [loading, orgs, navigate])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      </div>
    )
  }

  if (orgs.length === 0) return null

  return <>{children}</>
}

export default function App() {
  return (
    <OrgProvider>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route
          element={
            <OrgGuard>
              <Layout />
            </OrgGuard>
          }
        >
          <Route index element={<Navigate to="/objects" replace />} />
          <Route path="/objects" element={<Objects />} />
          <Route path="/objects/:name/fields" element={<Fields />} />
          <Route path="/sync-order" element={<SyncOrder />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      <SessionExpiredBanner />
      <Toaster />
    </OrgProvider>
  )
}
