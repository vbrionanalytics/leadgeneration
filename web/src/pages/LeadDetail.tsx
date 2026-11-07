import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Mail, Sparkles, Store, Trash2 } from 'lucide-react';
import { api, errMsg, Lead } from '../lib/api';
import { Alert, Loading, Modal, ScoreRing, Spinner, StatusChip, TempChip, fmtDate } from '../components/ui';

const BREAKDOWN_LABELS: Record<string, string> = { need: 'Need for your services', ability_to_pay: 'Ability to pay', reachability: 'Reachability', fit: 'Fit with your offer' };
const SOURCE_LABELS: Record<string, string> = { website_public: 'Published on their website', google_places: 'Google listing', manual: 'Added manually', consent_form: 'Consent on record', marketplace: 'Bought on marketplace' };

export default function LeadDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [contactOpen, setContactOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const q = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => (await api.get(`/leads/${id}`)).data as Lead,
    refetchInterval: (s) => (['queued', 'running'].includes((s.state.data as Lead)?.analysisStatus) ? 2500 : false)
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['lead', id] }); qc.invalidateQueries({ queryKey: ['balance'] }); };
  const patch = useMutation({ mutationFn: async (b: any) => api.patch(`/leads/${id}`, b), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const analyse = useMutation({ mutationFn: async () => api.post('/leads/analyze', { leadIds: [id] }), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const draft = useMutation({
    mutationFn: async () => (await api.post('/emails/generate', { leadIds: [id] })).data,
    onSuccess: (d) => { const r = d.results[0]; r.error ? setErr(r.error) : setOk('Draft is being written. Review and approve it in Outreach.'); refresh(); },
    onError: (e) => setErr(errMsg(e))
  });
  const delContact = useMutation({ mutationFn: async (cid: string) => api.delete(`/leads/${id}/contacts/${cid}`), onSuccess: refresh });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <Alert>Lead not found.</Alert>;
  const l = q.data;
  const a = l.website_analysis;
  const analysing = ['queued', 'running'].includes(l.analysisStatus);

  return (
    <>
      <Link to="/leads" className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-ink-2 hover:text-ink"><ArrowLeft className="h-4 w-4" /> Leads</Link>
      <div className="mb-6 flex flex-wrap items-start gap-5">
        <ScoreRing score={l.score} size={76} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold sm:text-3xl">{l.name}</h1><TempChip score={l.score} /></div>
          <p className="mt-1 text-ink-2">{[l.category, l.address || l.city, l.country].filter(Boolean).join(', ')}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {l.website && <a href={l.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">Website <ExternalLink className="h-3.5 w-3.5" /></a>}
            {l.googleMapsUrl && <a href={l.googleMapsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">Google Maps <ExternalLink className="h-3.5 w-3.5" /></a>}
            {l.rating != null && <span className="text-ink-2">{l.rating} stars from {l.reviewCount} reviews</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline" disabled={analysing || analyse.isPending} onClick={() => analyse.mutate()}>{analysing ? <Spinner /> : <Sparkles className="h-4 w-4" />} {l.analysisStatus === 'done' ? 'Re-analyse' : 'Analyse'}</button>
          <button className="btn-primary" disabled={draft.isPending} onClick={() => draft.mutate()}>{draft.isPending ? <Spinner /> : <Mail className="h-4 w-4" />} Write email</button>
          <button className="btn-ghost" onClick={() => setListOpen(true)}><Store className="h-4 w-4" /> Sell</button>
        </div>
      </div>
      <div className="mb-4 space-y-2">{err && <Alert>{err}</Alert>}{ok && <Alert tone="success">{ok}</Alert>}</div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <section className="panel p-5">
            <h2 className="text-lg font-bold">Why this score</h2>
            {analysing && <p className="mt-2 flex items-center gap-2 text-sm text-ink-2"><Spinner /> Reading their website and scoring. This usually takes under a minute.</p>}
            {l.analysisStatus === 'none' && <p className="mt-2 text-sm text-ink-2">Not analysed yet. Analysis reads their public website and scores the lead for 2 credits.</p>}
            {l.analysisStatus === 'failed' && <Alert>Analysis failed: {a?.error || 'unknown error'}. Try again.</Alert>}
            {l.scoreSummary && <p className="mt-2 text-ink">{l.scoreSummary}</p>}
            {l.scoreBreakdown && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {Object.entries(l.scoreBreakdown).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between text-sm"><span>{BREAKDOWN_LABELS[k] || k}</span><b>{v}</b></div>
                    <div className="mt-1 h-1.5 rounded-full bg-mist"><div className="h-full rounded-full bg-ink" style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
            {!!l.evidence?.length && (
              <ul className="mt-5 divide-y divide-line border-t border-line">
                {l.evidence.map((e, i) => (
                  <li key={i} className="flex gap-3 py-2.5 text-sm">
                    <span className={`w-10 shrink-0 text-right font-display font-bold ${e.impact > 0 ? 'text-hot' : e.impact < 0 ? 'text-cold' : 'text-ink-2'}`}>{e.impact > 0 ? '+' : ''}{e.impact}</span>
                    <div><b>{e.signal}</b> <span className="text-ink-2">{e.detail}</span><div className="text-xs text-ink-2">Source: {e.source === 'google_places' ? 'Google listing' : e.source === 'website' ? 'their website' : 'derived from the above'}</div></div>
                  </li>
                ))}
              </ul>
            )}
            {l.scoredBy && <p className="mt-3 text-xs text-ink-2">{l.scoredBy === 'claude' ? 'Scored by Claude from the signals above.' : 'Scored with transparent rules (AI was unavailable).'}</p>}
          </section>

          {!!l.opportunities?.length && (
            <section className="panel p-5">
              <h2 className="text-lg font-bold">Opportunities</h2>
              <ul className="mt-3 space-y-3">
                {l.opportunities.map((o, i) => (
                  <li key={i} className="flex gap-3">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${o.priority === 'high' ? 'bg-hot' : o.priority === 'medium' ? 'bg-warm' : 'bg-cold'}`} title={`${o.priority} priority`} />
                    <div><div className="font-semibold">{o.title}</div><div className="text-sm text-ink-2">{o.description}</div></div>
                  </li>
                ))}
              </ul>
              {!!l.recommendedServices?.length && (
                <div className="mt-5 border-t border-line pt-4">
                  <h3 className="text-sm font-semibold">Services to pitch</h3>
                  <div className="mt-2 flex flex-wrap gap-2">{l.recommendedServices.map((s) => <span key={s.name} className="chip bg-teal-50 text-teal-800" title={s.reason}>{s.name}</span>)}</div>
                </div>
              )}
            </section>
          )}

          {a?.ok && (
            <section className="panel p-5">
              <h2 className="text-lg font-bold">Website check</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {[
                  ['HTTPS', a.https ? 'Yes' : 'No'], ['Mobile-ready', a.has_viewport ? 'Yes' : 'No'], ['Load time', `${(a.load_ms / 1000).toFixed(1)} s`],
                  ['Analytics', a.has_analytics ? 'Yes' : 'None found'], ['Online booking', a.has_booking ? 'Yes' : 'No'], ['Contact form', a.has_contact_form ? 'Yes' : 'No'],
                  ['Built with', a.technologies?.join(', ') || 'Unknown'], ['Copyright year', a.copyright_year || '–'], ['Pages checked', a.pages_checked?.length]
                ].map(([k, v]) => <div key={String(k)}><dt className="text-ink-2">{k}</dt><dd className="font-semibold">{String(v)}</dd></div>)}
              </dl>
              {!!a.seo_issues?.length && <p className="mt-3 text-sm"><b>SEO issues:</b> <span className="text-ink-2">{a.seo_issues.join('; ')}</span></p>}
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <section className="panel p-5">
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold">Contacts</h2><button className="text-sm font-semibold text-brand hover:underline" onClick={() => setContactOpen(true)}>Add</button></div>
            <p className="mt-1 text-xs text-ink-2">Only contacts with a known source are stored. Nothing is guessed.</p>
            <ul className="mt-3 space-y-3">
              {l.contacts.map((c) => (
                <li key={c._id} className="group text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{c.value}</span>
                    <button className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => delContact.mutate(c._id)} aria-label={`Remove ${c.value}`}><Trash2 className="h-3.5 w-3.5 text-ink-2" /></button>
                  </div>
                  <div className="text-xs text-ink-2">
                    {c.type}, {SOURCE_LABELS[c.source] || c.source}
                    {c.sourceUrl && <> (<a className="underline" href={c.sourceUrl} target="_blank" rel="noreferrer">page</a>)</>}
                    {c.type === 'email' && `, ${c.kind === 'generic_business' ? 'generic business address' : 'named person'}`}
                  </div>
                </li>
              ))}
              {!l.contacts.length && <li className="text-sm text-ink-2">No contacts yet. Analysing the website finds published emails.</li>}
            </ul>
          </section>
          <section className="panel space-y-3 p-5">
            <h2 className="text-lg font-bold">Pipeline</h2>
            <div><label className="label" htmlFor="st">Status</label>
              <select id="st" className="input" value={l.status} onChange={(e) => patch.mutate({ status: e.target.value })}>
                {['new', 'qualified', 'contacted', 'replied', 'won', 'lost', 'do_not_contact'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="notes">Notes</label><textarea id="notes" className="input min-h-24" defaultValue={l.notes} onBlur={(e) => e.target.value !== (l.notes || '') && patch.mutate({ notes: e.target.value })} /></div>
            <p className="text-xs text-ink-2">Added {fmtDate(l.createdAt)} from {l.source.replace('_', ' ')}. <StatusChip status={l.analysisStatus} /></p>
          </section>
        </aside>
      </div>

      <AddContact open={contactOpen} onClose={() => setContactOpen(false)} leadId={l._id} onDone={refresh} />
      <ListLead open={listOpen} onClose={() => setListOpen(false)} leadId={l._id} />
    </>
  );
}

function AddContact({ open, onClose, leadId, onDone }: { open: boolean; onClose: () => void; leadId: string; onDone: () => void }) {
  const [f, setF] = useState({ type: 'email', value: '', source: 'website_public', sourceUrl: '', consentConfirmed: false });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: async () => api.post(`/leads/${leadId}/contacts`, { ...f, sourceUrl: f.sourceUrl || undefined }),
    onSuccess: () => { onDone(); onClose(); setF({ ...f, value: '', sourceUrl: '' }); },
    onError: (e) => setErr(errMsg(e))
  });
  return (
    <Modal open={open} onClose={onClose} title="Add a contact">
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); setErr(''); m.mutate(); }}>
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Type"><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">WhatsApp</option><option value="linkedin">LinkedIn</option></select>
          <input className="input" required placeholder="Contact" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} aria-label="Value" />
        </div>
        <div><label className="label" htmlFor="src">Where did it come from?</label>
          <select id="src" className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="website_public">Published on their website</option><option value="consent_form">They gave consent (form, event, call)</option><option value="manual">Other / direct relationship</option>
          </select></div>
        {f.source === 'website_public' && <div><label className="label" htmlFor="url">Page URL where it's published</label><input id="url" className="input" type="url" required value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} /></div>}
        {f.source === 'consent_form' && <label className="flex gap-2 text-sm"><input type="checkbox" checked={f.consentConfirmed} onChange={(e) => setF({ ...f, consentConfirmed: e.target.checked })} /> I hold a record of this person's consent to be contacted.</label>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>Add contact</button></div>
      </form>
    </Modal>
  );
}

function ListLead({ open, onClose, leadId }: { open: boolean; onClose: () => void; leadId: string }) {
  const [price, setPrice] = useState(10);
  const [exclusive, setExclusive] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const elig = useQuery({ queryKey: ['elig', leadId], enabled: open, queryFn: async () => (await api.get(`/marketplace/eligibility/${leadId}`)).data });
  const m = useMutation({ mutationFn: async () => api.post('/marketplace/my-listings', { leadId, priceCredits: price, exclusive }), onSuccess: () => setDone(true), onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal open={open} onClose={onClose} title="Sell on the marketplace">
      {done ? <Alert tone="success">Listed. It goes live after an automatic compliance review.</Alert> : elig.isLoading ? <Loading /> : !elig.data?.eligible ? (
        <div className="space-y-2"><p className="text-sm">This lead can't be listed yet:</p><ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">{elig.data?.issues.map((i: string) => <li key={i}>{i}</li>)}</ul></div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          {err && <Alert>{err}</Alert>}
          <p className="text-sm text-ink-2">Buyers see only the category, city, score and opportunity titles. They receive the website, your analysis and contacts found on the business website. Google listing data is never resold.</p>
          <div><label className="label" htmlFor="pr">Price in credits</label><input id="pr" type="number" className="input" min={1} max={1000} value={price} onChange={(e) => setPrice(Number(e.target.value))} /></div>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> Exclusive (sell to one buyer only)</label>
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>List lead</button></div>
        </form>
      )}
    </Modal>
  );
}
