import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, COUNTRIES, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, PageHeader, Spinner, StatusChip, fmtTime } from '../components/ui';

const SUGGESTIONS = ['Dental clinics', 'Restaurants', 'Boutique hotels', 'Real estate agents', 'Gyms', 'Interior designers', 'Schools', 'Hospitals', 'CA firms', 'Textile shops'];

export default function SearchPage() {
  const { org } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({ category: '', country: org?.defaultCountry || 'IN', city: '', keywords: '', maxResults: 20, autoAnalyze: false });
  const jobs = useQuery({
    queryKey: ['searches'],
    queryFn: async () => (await api.get('/searches')).data,
    refetchInterval: (q) => ((q.state.data as any[])?.some((j) => ['queued', 'running'].includes(j.status)) ? 2500 : false)
  });
  const run = useMutation({
    mutationFn: async () => (await api.post('/searches', { ...f, city: f.city || undefined, keywords: f.keywords || undefined })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['searches'] }); qc.invalidateQueries({ queryKey: ['balance'] }); }
  });
  const cancel = useMutation({ mutationFn: async (id: string) => api.post(`/searches/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['searches'] }) });
  const maxAllowed = org?.planDetails?.maxResultsPerSearch ?? 20;
  const estimate = f.maxResults + (f.autoAnalyze ? f.maxResults * 2 : 0);

  const submit = (e: FormEvent) => { e.preventDefault(); run.mutate(); };

  return (
    <>
      <PageHeader title="Find businesses" sub="Searches run in the background using Google Places. Businesses you already have are detected and skipped, and you are only charged for new leads." />
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <form onSubmit={submit} className="panel h-fit space-y-4 p-5">
          {run.isError && <Alert>{errMsg(run.error)}</Alert>}
          {run.isSuccess && <Alert tone="success">Search started. Results appear below as they arrive.</Alert>}
          <div>
            <label className="label" htmlFor="cat">What kind of business?</label>
            <input id="cat" className="input" required placeholder="e.g. dental clinics" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => setF({ ...f, category: s })} className="chip border border-line bg-white text-ink-2 hover:border-ink-2">{s}</button>)}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="country">Country</label>
              <select id="country" className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
            <div><label className="label" htmlFor="city">City</label><input id="city" className="input" placeholder="e.g. Coimbatore" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></div>
          </div>
          <div><label className="label" htmlFor="kw">Extra keywords <span className="font-normal text-ink-2">(optional)</span></label><input id="kw" className="input" placeholder="e.g. orthodontist" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} /></div>
          <div>
            <label className="label" htmlFor="max">How many businesses? <span className="font-normal text-ink-2">(up to {maxAllowed} on your plan)</span></label>
            <input id="max" type="number" className="input" min={1} max={maxAllowed} value={f.maxResults} onChange={(e) => setF({ ...f, maxResults: Math.max(1, Math.min(maxAllowed, Number(e.target.value))) })} />
          </div>
          <label className="flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={f.autoAnalyze} onChange={(e) => setF({ ...f, autoAnalyze: e.target.checked })} />
            <span>Analyse websites and score each new lead automatically <span className="text-ink-2">(2 credits per lead)</span></span>
          </label>
          <div className="rounded-lg bg-mist px-3 py-2 text-sm text-ink-2">Uses up to <b className="text-ink">{estimate}</b> credits. You have {org?.credits ?? 0}.</div>
          <button className="btn-primary w-full" disabled={run.isPending || !f.category}>{run.isPending && <Spinner />} Start search</button>
          <p className="text-xs text-ink-2">Only information that businesses publish publicly is collected. Google listing details are refreshed or removed after 30 days, as Google's terms require.</p>
        </form>

        <section>
          <h2 className="mb-3 text-lg font-bold">Your searches</h2>
          <div className="space-y-3">
            {(jobs.data || []).map((j: any) => {
              const live = ['queued', 'running'].includes(j.status);
              return (
                <div key={j._id} className="panel p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">{j.query.category} <span className="font-normal text-ink-2">in {j.query.city ? `${j.query.city}, ` : ''}{j.query.country}</span></div>
                      <div className="text-xs text-ink-2">{fmtTime(j.createdAt)}, up to {j.query.maxResults} results{j.autoAnalyze ? ', auto-analyse on' : ''}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {live && <Spinner className="text-brand" />}
                      <StatusChip status={j.status} />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span><b>{j.stats.found}</b> found</span>
                    <span><b>{j.stats.created}</b> new leads</span>
                    <span><b>{j.stats.duplicates}</b> duplicates skipped</span>
                    <span><b>{j.stats.creditsUsed}</b> credits</span>
                  </div>
                  {j.error && <p className="mt-2 text-sm text-red-700">{j.error}</p>}
                  <div className="mt-3 flex gap-2">
                    {j.stats.created > 0 && <Link to={`/leads?searchJobId=${j._id}`} className="btn-outline">View leads</Link>}
                    {live && <button className="btn-ghost" onClick={() => cancel.mutate(j._id)}>Cancel</button>}
                  </div>
                </div>
              );
            })}
            {!jobs.data?.length && <p className="panel p-8 text-center text-sm text-ink-2">Searches you start will show their progress here.</p>}
          </div>
        </section>
      </div>
    </>
  );
}
