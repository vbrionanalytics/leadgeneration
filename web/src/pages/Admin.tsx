import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Loading, PageHeader, Stat, StatusChip, fmtDate, fmtTime } from '../components/ui';

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'orgs' | 'jobs' | 'listings' | 'audit'>('orgs');
  const ov = useQuery({ queryKey: ['admin-overview'], queryFn: async () => (await api.get('/admin/overview')).data, enabled: !!user?.isPlatformAdmin });
  if (!user?.isPlatformAdmin) return <Navigate to="/" replace />;
  const o = ov.data;
  return (
    <>
      <PageHeader title="Platform admin" sub={o ? `Automation runs in ${o.automationMode === 'n8n' ? 'n8n' : 'direct (in-process)'} mode.` : undefined} />
      {o && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Organisations" value={o.orgs} hint={Object.entries(o.plans).map(([p, n]) => `${n} ${p}`).join(', ')} />
          <Stat label="List-price MRR" value={`₹${o.mrrInr.toLocaleString('en-IN')}`} />
          <Stat label="Leads" value={o.leads} hint={`${o.searches} searches`} />
          <Stat label="Emails sent" value={o.emailsSent} hint={`${o.failedJobs} failed background jobs`} />
        </div>
      )}
      <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
        {([['orgs', 'Organisations'], ['jobs', 'Background jobs'], ['listings', 'Marketplace'], ['audit', 'Audit log']] as const).map(([id, l]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === id ? 'border-brand' : 'border-transparent text-ink-2'}`}>{l}</button>
        ))}
      </div>
      {tab === 'orgs' && <Orgs />}
      {tab === 'jobs' && <Jobs />}
      {tab === 'listings' && <Listings />}
      {tab === 'audit' && <Audit />}
    </>
  );
}

function Orgs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-orgs'], queryFn: async () => (await api.get('/admin/organizations')).data });
  const [err, setErr] = useState('');
  const upd = useMutation({ mutationFn: async ({ id, ...b }: any) => api.patch(`/admin/organizations/${id}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-orgs'] }), onError: (e) => setErr(errMsg(e)) });
  const credits = useMutation({ mutationFn: async ({ id, amount }: any) => api.post(`/admin/organizations/${id}/credits`, { amount, reason: 'Manual adjustment' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-orgs'] }), onError: (e) => setErr(errMsg(e)) });
  if (q.isLoading) return <Loading />;
  return (
    <>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[820px]">
          <thead className="border-b border-line"><tr><th className="th">Organisation</th><th className="th">Plan</th><th className="th">Credits</th><th className="th">Leads</th><th className="th">Status</th><th className="th">Created</th></tr></thead>
          <tbody className="divide-y divide-line">
            {q.data.map((o: any) => (
              <tr key={o._id}>
                <td className="td font-semibold">{o.name}<div className="text-xs font-normal text-ink-2">{o.sender?.email}</div></td>
                <td className="td"><select className="input w-28" value={o.plan} onChange={(e) => upd.mutate({ id: o._id, plan: e.target.value })} aria-label="Plan">{['free', 'starter', 'growth', 'agency'].map((p) => <option key={p}>{p}</option>)}</select></td>
                <td className="td"><div className="flex items-center gap-2">{o.credits}<button className="btn-ghost px-2 py-1" onClick={() => { const v = Number(prompt('Credits to add (negative to remove)')); if (v) credits.mutate({ id: o._id, amount: v }); }}>Adjust</button></div></td>
                <td className="td">{o.leadCount}</td>
                <td className="td"><button className={o.status === 'active' ? 'btn-ghost px-2 py-1' : 'btn-danger px-2 py-1'} onClick={() => upd.mutate({ id: o._id, status: o.status === 'active' ? 'suspended' : 'active' })}>{o.status === 'active' ? 'Active, suspend' : 'Suspended, restore'}</button></td>
                <td className="td text-ink-2">{fmtDate(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Jobs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-jobs'], queryFn: async () => (await api.get('/admin/jobs')).data, refetchInterval: 5000 });
  const retry = useMutation({ mutationFn: async (id: string) => api.post(`/admin/jobs/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-jobs'] }) });
  if (q.isLoading) return <Loading />;
  if (!q.data.length) return <p className="panel p-6 text-sm text-ink-2">The queue is empty and nothing has failed.</p>;
  return (
    <div className="panel divide-y divide-line">
      {q.data.map((j: any) => (
        <div key={j._id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <StatusChip status={j.status} /><b>{j.type}</b><span className="text-ink-2">attempt {j.attempts}/{j.maxAttempts}, {fmtTime(j.updatedAt)}</span>
          {j.lastError && <span className="w-full text-red-700">{j.lastError}</span>}
          {j.status === 'failed' && <button className="btn-outline ml-auto" onClick={() => retry.mutate(j._id)}>Retry</button>}
        </div>
      ))}
    </div>
  );
}

function Listings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-listings'], queryFn: async () => (await api.get('/admin/listings')).data });
  const review = useMutation({ mutationFn: async ({ id, passed }: any) => api.post(`/admin/listings/${id}/review`, { passed, issues: passed ? [] : ['Rejected by platform admin'] }), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-listings'] }) });
  if (q.isLoading) return <Loading />;
  return (
    <div className="panel divide-y divide-line">
      {q.data.map((l: any) => (
        <div key={l._id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <StatusChip status={l.status} /><b>{l.preview.title}</b><span className="text-ink-2">{l.priceCredits} credits, sold {l.salesCount}/{l.maxSales}</span>
          {l.status === 'pending_review' && <div className="ml-auto flex gap-2"><button className="btn-outline" onClick={() => review.mutate({ id: l._id, passed: true })}>Approve</button><button className="btn-danger" onClick={() => review.mutate({ id: l._id, passed: false })}>Reject</button></div>}
        </div>
      ))}
      {!q.data.length && <p className="p-6 text-sm text-ink-2">No listings yet.</p>}
    </div>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ['admin-audit'], queryFn: async () => (await api.get('/admin/audit')).data });
  if (q.isLoading) return <Loading />;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead className="border-b border-line"><tr><th className="th">When</th><th className="th">Action</th><th className="th">Target</th><th className="th">IP</th></tr></thead>
        <tbody className="divide-y divide-line">
          {q.data.map((a: any) => <tr key={a._id}><td className="td whitespace-nowrap text-ink-2">{fmtTime(a.createdAt)}</td><td className="td font-semibold">{a.action}</td><td className="td text-ink-2">{a.target || '–'}</td><td className="td text-ink-2">{a.ip || '–'}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
