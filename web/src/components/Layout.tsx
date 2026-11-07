import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, Search, Users, Mail, Megaphone, Store, CreditCard, Settings, Shield, LogOut, Menu, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/search', label: 'Find businesses', icon: Search },
  { to: '/leads', label: 'Leads', icon: Users },
  { to: '/outreach', label: 'Outreach', icon: Mail },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/marketplace', label: 'Marketplace', icon: Store },
  { to: '/billing', label: 'Plan & credits', icon: CreditCard },
  { to: '/settings', label: 'Settings', icon: Settings }
];

export default function Layout() {
  const { user, org, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: bal } = useQuery({ queryKey: ['balance'], queryFn: async () => (await api.get('/billing/balance')).data, refetchInterval: 20000 });
  const { data: pending } = useQuery({ queryKey: ['email-stats'], queryFn: async () => (await api.get('/emails/stats')).data, refetchInterval: 30000 });

  const sidebar = (
    <nav className="flex h-full flex-col bg-ink px-3 py-5 text-slate-300">
      <div className="mb-7 flex items-center gap-2.5 px-2">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <div>
          <div className="font-display text-[17px] font-bold leading-none text-white">AI LeadGen</div>
          <div className="mt-1 max-w-[150px] truncate text-xs text-slate-400">{org?.name}</div>
        </div>
      </div>
      <ul className="space-y-0.5">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) => `flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1">{label}</span>
              {to === '/outreach' && pending?.pending > 0 && <span className="rounded-full bg-warm px-1.5 text-xs font-bold text-ink">{pending.pending}</span>}
            </NavLink>
          </li>
        ))}
        {user?.isPlatformAdmin && (
          <li>
            <NavLink to="/admin" onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium ${isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 hover:text-white'}`}>
              <Shield className="h-4 w-4" /> Platform admin
            </NavLink>
          </li>
        )}
      </ul>
      <div className="mt-auto space-y-3 px-2">
        <button onClick={() => nav('/billing')} className="w-full rounded-lg bg-white/5 p-3 text-left hover:bg-white/10">
          <div className="text-xs text-slate-400">Credits left</div>
          <div className="font-display text-xl font-bold text-white">{bal?.credits ?? org?.credits ?? '–'}</div>
          <div className="text-xs capitalize text-slate-400">{bal?.plan ?? org?.plan} plan</div>
        </button>
        <div className="flex items-center justify-between text-sm">
          <span className="truncate" title={user?.email}>{user?.name}</span>
          <button onClick={() => { logout(); nav('/login'); }} className="rounded p-1.5 hover:bg-white/10" aria-label="Sign out" title="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="sticky top-0 hidden h-screen lg:block">{sidebar}</aside>
      <div className="flex items-center justify-between border-b border-line bg-white px-4 py-3 lg:hidden">
        <span className="font-display font-bold">AI LeadGen</span>
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="btn-ghost p-1.5"><Menu className="h-5 w-5" /></button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">{sidebar}</div>
          <button onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded bg-white p-1.5" aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>
      )}
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
