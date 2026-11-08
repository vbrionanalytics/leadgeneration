import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Mail, Sparkles, Globe } from 'lucide-react';
import { api, COUNTRIES, errMsg, Lead } from '../lib/api';
import { Alert, Empty, Loading, PageHeader, ScoreRing, Spinner, StatusChip } from '../components/ui';

const STATUSES = ['new', 'qualified', 'contacted', 'replied', 'won', 'lost', 'do_not_contact'];

export default function LeadsPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const filters = Object.fromEntries(params.entries());
  const page = Number(filters.page || 1);

  const q = useQuery({ queryKey: ['leads', filters], queryFn: async () => (await api.get('/leads', { params: { ...filters, limit: 25 } })).data, refetchInterval: (s) => ((s.state.data as any)?.items?.some((l: Lead) => ['queued', 'running'].includes(l.analysisStatus)) ? 3000 : false) });
  const setF = (k: string, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); p.delete('page'); setParams(p); setSelected([]); };
  const done = (text: string) => { setMsg({ tone: 'success', text }); setSelected([]); qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['balance'] }); };
  const fail = (e: unknown) => setMsg({ tone: 'error', text: errMsg(e) });

  const analyse = useMutation({ mutationFn: async () => (await api.post('/leads/analyze', { leadIds: selected })).data, onSuccess: (d) => done(`${d.queued} lead(s) queued for website analysis and scoring.`), onError: fail });
  const draft = useMutation({
    mutationFn: async () => (await api.post('/emails/generate', { leadIds: selected })).data,
    onSuccess: (d) => {
      const ok = d.results.filter((r: any) => r.emailId).length;
      const skipped = d.results.filter((r: any) => r.error);
      done(`${ok} email draft(s) are waiting for your approval in Outreach.${skipped.length ? ` ${skipped.length} skipped: ${skipped[0].error}` : ''}`);
    },
    onError: fail
  });
  const bulk = useMutation({ mutationFn: async (body: any) => (await api.post('/leads/bulk', { leadIds: selected, ...body })).data, onSuccess: (d) => done(`${d.affected} lead(s) updated.`), onError: fail });

  const exportXlsx = async () => {
    try {
      const { page: _p, ...rest } = filters;
      const r = await api.get('/leads/export', { params: rest, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `leads-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { fail(e); }
  };

  const items: Lead[] = q.data?.items || [];
  const allSel = items.length > 0 && items.every((l) => selected.includes(l._id));
  const busy = analyse.isPending || draft.isPending || bulk.isPending;

  return (
    <>
      <PageHeader title="Leads" sub={q.data ? `${q.data.total} lead${q.data.total === 1 ? '' : 's'} match these filters.` : undefined} actions={<button className="btn-outline" onClick={exportXlsx}><Download className="h-4 w-4" /> Export to Excel</button>} />

      <div className="panel mb-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
        <input className="input lg:col-span-2" placeholder="Search by business name" defaultValue={filters.q} onKeyDown={(e) => e.key === 'Enter' && setF('q', (e.target as HTMLInputElement).value)} onBlur={(e) => setF('q', e.target.value)} aria-label="Search by name" />
        <select className="input" value={filters.status || ''} onChange={(e) => setF('status', e.target.value)} aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select>
        <select className="input" value={filters.minScore || ''} onChange={(e) => setF('minScore', e.target.value)} aria-label="Minimum score"><option value="">Any score</option><option value="70">Hot (70+)</option><option value="45">Warm or hotter (45+)</option></select>
        <select className="input" value={filters.country || ''} onChange={(e) => setF('country', e.target.value)} aria-label="Country"><option value="">Any country</option>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
        <select className="input" value={filters.hasEmail || ''} onChange={(e) => setF('hasEmail', e.target.value)} aria-label="Has email"><option value="">Email: any</option><option value="true">Has public email</option><option value="false">No email</option></select>
        <input className="input" placeholder="City" defaultValue={filters.city} onBlur={(e) => setF('city', e.target.value)} aria-label="City" />
        <input className="input" placeholder="Category" defaultValue={filters.category} onBlur={(e) => setF('category', e.target.value)} aria-label="Category" />
        <select className="input" value={filters.hasWebsite || ''} onChange={(e) => setF('hasWebsite', e.target.value)} aria-label="Has website"><option value="">Website: any</option><option value="true">Has website</option><option value="false">No website</option></select>
        <select className="input" value={filters.sort || '-createdAt'} onChange={(e) => setF('sort', e.target.value)} aria-label="Sort"><option value="-createdAt">Newest first</option><option value="-score">Highest score</option><option value="name">Name A–Z</option></select>
        {Object.keys(filters).length > 0 && <button className="btn-ghost" onClick={() => setParams({})}>Clear filters</button>}
      </div>

      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      {selected.length > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-white shadow-lg">
          <span className="mr-2 text-sm font-semibold">{selected.length} selected</span>
          <button className="btn bg-white/10 text-white hover:bg-white/20" disabled={busy} onClick={() => analyse.mutate()}><Sparkles className="h-4 w-4" /> Analyse and score</button>
          <button className="btn bg-white/10 text-white hover:bg-white/20" disabled={busy} onClick={() => draft.mutate()}><Mail className="h-4 w-4" /> Write emails</button>
          <select className="rounded-lg bg-white/10 px-2 py-2 text-sm" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', status: e.target.value })} aria-label="Set status">
            <option value="">Set status…</option>{STATUSES.map((s) => <option key={s} value={s} className="text-ink">{s.replace(/_/g, ' ')}</option>)}
          </select>
          <button className="btn ml-auto bg-transparent text-red-200 hover:bg-white/10" disabled={busy} onClick={() => confirm(`Delete ${selected.length} lead(s)? This cannot be undone.`) && bulk.mutate({ action: 'delete' })}>Delete</button>
          {busy && <Spinner />}
        </div>
      )}

      {q.isLoading ? <Loading /> : !items.length ? (
        <Empty title="No leads here yet" action={<Link className="btn-primary" to="/search">Find businesses</Link>}>Run a search to discover businesses, or loosen the filters above.</Empty>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead className="border-b border-line bg-mist/50">
              <tr>
                <th className="th w-10"><input type="checkbox" aria-label="Select all" className="h-4 w-4" checked={allSel} onChange={() => setSelected(allSel ? [] : items.map((l) => l._id))} /></th>
                <th className="th">Business</th><th className="th">Score</th><th className="th">Top opportunity</th><th className="th">Reach</th><th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((l) => {
                const hasEmail = l.contacts?.some((c) => c.type === 'email');
                return (
                  <tr key={l._id} className={selected.includes(l._id) ? 'bg-teal-50/40' : 'hover:bg-mist/40'}>
                    <td className="td"><input type="checkbox" className="h-4 w-4" aria-label={`Select ${l.name}`} checked={selected.includes(l._id)} onChange={() => setSelected((s) => (s.includes(l._id) ? s.filter((x) => x !== l._id) : [...s, l._id]))} /></td>
                    <td className="td">
                      <Link to={`/leads/${l._id}`} className="font-semibold hover:text-brand hover:underline">{l.name}</Link>
                      <div className="text-xs text-ink-2">{[l.category, l.city, l.country].filter(Boolean).join(', ')}</div>
                    </td>
                    <td className="td">
                      {l.analysisStatus === 'queued' || l.analysisStatus === 'running' ? <span className="flex items-center gap-1.5 text-xs text-ink-2"><Spinner /> Analysing</span> : <ScoreRing score={l.score} size={38} />}
                    </td>
                    <td className="td max-w-[260px]"><span className="line-clamp-2 text-ink-2">{l.opportunities?.[0]?.title || (l.analysisStatus === 'failed' ? 'Analysis failed' : '–')}</span></td>
                    <td className="td">
                      <div className="flex gap-1.5 text-ink-2">
                        <span title={l.website ? 'Has website' : 'No website'} className={l.website ? 'text-ink' : 'opacity-30'}><Globe className="h-4 w-4" /></span>
                        <span title={hasEmail ? 'Public email found' : 'No email found'} className={hasEmail ? 'text-ink' : 'opacity-30'}><Mail className="h-4 w-4" /></span>
                      </div>
                    </td>
                    <td className="td"><StatusChip status={l.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {q.data.pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
              <span className="text-ink-2">Page {page} of {q.data.pages}</span>
              <div className="flex gap-2">
                <button className="btn-outline" disabled={page <= 1} onClick={() => { const p = new URLSearchParams(params); p.set('page', String(page - 1)); setParams(p); }}>Previous</button>
                <button className="btn-outline" disabled={page >= q.data.pages} onClick={() => { const p = new URLSearchParams(params); p.set('page', String(page + 1)); setParams(p); }}>Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
