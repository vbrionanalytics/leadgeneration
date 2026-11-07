import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Mail, Phone } from 'lucide-react';
import { api, COUNTRIES, errMsg } from '../lib/api';
import { Alert, Empty, Loading, PageHeader, ScoreRing, Stat, StatusChip, fmtDate } from '../components/ui';

export default function Marketplace() {
  const [tab, setTab] = useState<'buy' | 'purchases' | 'sell'>('buy');
  return (
    <>
      <PageHeader title="Lead marketplace" sub="Buy analysed leads from other teams or sell your own. Only the seller's research and contacts published on the business website change hands." />
      <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
        {([['buy', 'Browse'], ['purchases', 'My purchases'], ['sell', 'Selling']] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === id ? 'border-brand text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>{label}</button>
        ))}
      </div>
      {tab === 'buy' && <Browse />}
      {tab === 'purchases' && <Purchases />}
      {tab === 'sell' && <Selling />}
    </>
  );
}

function Browse() {
  const qc = useQueryClient();
  const [f, setF] = useState({ category: '', country: '', city: '', minScore: '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const q = useQuery({ queryKey: ['market', f], queryFn: async () => (await api.get('/marketplace/listings', { params: Object.fromEntries(Object.entries(f).filter(([, v]) => v)) })).data });
  const buy = useMutation({
    mutationFn: async (id: string) => (await api.post(`/marketplace/listings/${id}/purchase`)).data,
    onSuccess: (d) => { setMsg({ tone: 'success', text: `Bought. "${d.lead.name}" is now in your leads.` }); qc.invalidateQueries({ queryKey: ['market'] }); qc.invalidateQueries({ queryKey: ['balance'] }); },
    onError: (e) => setMsg({ tone: 'error', text: errMsg(e) })
  });
  return (
    <>
      <div className="panel mb-4 grid gap-3 p-3 sm:grid-cols-4">
        <input className="input" placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Category" />
        <select className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} aria-label="Country"><option value="">Any country</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
        <input className="input" placeholder="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} aria-label="City" />
        <select className="input" value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })} aria-label="Minimum score"><option value="">Any score</option><option value="70">Hot (70+)</option><option value="45">45+</option></select>
      </div>
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {q.isLoading ? <Loading /> : !q.data?.items?.length ? <Empty title="No listings match">Try another category or country.</Empty> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.items.map((l: any) => (
            <article key={l._id} className="panel flex flex-col p-4">
              <div className="flex items-start gap-3">
                <ScoreRing score={l.preview.score} size={48} />
                <div className="min-w-0">
                  <h3 className="font-bold leading-tight">{l.preview.title}</h3>
                  <p className="text-sm text-ink-2">{[l.preview.city, l.preview.country].filter(Boolean).join(', ')}</p>
                </div>
              </div>
              <ul className="mt-3 flex-1 space-y-1 text-sm text-ink-2">{l.preview.opportunities.map((o: string) => <li key={o}>{o}</li>)}</ul>
              <div className="mt-3 flex gap-3 text-ink-2">
                <span className={l.preview.hasWebsite ? 'text-ink' : 'opacity-30'} title="Website"><Globe className="h-4 w-4" /></span>
                <span className={l.preview.hasEmail ? 'text-ink' : 'opacity-30'} title="Email"><Mail className="h-4 w-4" /></span>
                <span className={l.preview.hasPhone ? 'text-ink' : 'opacity-30'} title="Phone"><Phone className="h-4 w-4" /></span>
                <span className="ml-auto text-xs">{l.exclusive ? 'Exclusive' : `${l.maxSales - l.salesCount} of ${l.maxSales} left`}</span>
              </div>
              <button className="btn-primary mt-4" disabled={l.purchased || buy.isPending} onClick={() => buy.mutate(l._id)}>{l.purchased ? 'Purchased' : `Buy for ${l.priceCredits} credits`}</button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function Purchases() {
  const q = useQuery({ queryKey: ['purchases'], queryFn: async () => (await api.get('/marketplace/purchases')).data });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <Empty title="No purchases yet">Leads you buy appear here and in your Leads list.</Empty>;
  return (
    <div className="panel divide-y divide-line">
      {q.data.map((p: any) => (
        <div key={p._id} className="flex items-center gap-3 p-4">
          <ScoreRing score={p.deliveredLeadId?.score} size={38} />
          <div className="flex-1"><Link to={`/leads/${p.deliveredLeadId?._id}`} className="font-semibold hover:underline">{p.deliveredLeadId?.name}</Link><div className="text-xs text-ink-2">{fmtDate(p.createdAt)}, {p.priceCredits} credits</div></div>
        </div>
      ))}
    </div>
  );
}

function Selling() {
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ['seller-stats'], queryFn: async () => (await api.get('/marketplace/seller-stats')).data });
  const q = useQuery({ queryKey: ['my-listings'], queryFn: async () => (await api.get('/marketplace/my-listings')).data, refetchInterval: (s) => ((s.state.data as any[])?.some((l) => l.status === 'pending_review') ? 3000 : false) });
  const withdraw = useMutation({ mutationFn: async (id: string) => api.post(`/marketplace/my-listings/${id}/withdraw`), onSuccess: () => qc.invalidateQueries({ queryKey: ['my-listings'] }) });
  return (
    <>
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Active listings" value={stats.data?.activeListings ?? 0} />
        <Stat label="Sales" value={stats.data?.sales ?? 0} />
        <Stat label="Credits earned" value={stats.data?.creditsEarned ?? 0} hint="After platform fee" />
      </div>
      <p className="mb-4 text-sm text-ink-2">To list a lead, open it and choose Sell. Leads must be analysed, have a contact published on the business website, and can't have been bought here. Selling needs the Growth plan.</p>
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="You haven't listed any leads" /> : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="border-b border-line"><tr><th className="th">Listing</th><th className="th">Status</th><th className="th">Price</th><th className="th">Sold</th><th className="th">Expires</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-line">
              {q.data.map((l: any) => (
                <tr key={l._id}>
                  <td className="td"><Link to={`/leads/${l.leadId}`} className="font-semibold hover:underline">{l.preview.title}</Link>{l.review?.issues?.length > 0 && <div className="text-xs text-red-700">{l.review.issues.join(' ')}</div>}</td>
                  <td className="td"><StatusChip status={l.status} /></td>
                  <td className="td">{l.priceCredits}</td>
                  <td className="td">{l.salesCount}/{l.maxSales}</td>
                  <td className="td">{fmtDate(l.expiresAt)}</td>
                  <td className="td text-right">{['active', 'pending_review'].includes(l.status) && <button className="btn-ghost" onClick={() => withdraw.mutate(l._id)}>Withdraw</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
