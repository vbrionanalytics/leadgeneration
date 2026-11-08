import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, EmailMsg, errMsg } from '../lib/api';
import { Alert, Empty, Loading, PageHeader, ScoreRing, Spinner, Stat, StatusChip, fmtTime } from '../components/ui';

const TABS = [
  { id: 'pending_approval,generating', label: 'Needs approval' },
  { id: 'queued,sent', label: 'Sent' },
  { id: 'failed,blocked,rejected', label: 'Not sent' }
];

export default function Outreach() {
  const [tab, setTab] = useState(TABS[0].id);
  const [activeId, setActiveId] = useState<string | null>(null);
  const qc = useQueryClient();
  const stats = useQuery({ queryKey: ['email-stats'], queryFn: async () => (await api.get('/emails/stats')).data });
  const list = useQuery({
    queryKey: ['emails', tab],
    queryFn: async () => (await api.get('/emails', { params: { status: tab } })).data,
    refetchInterval: (q) => ((q.state.data as any)?.items?.some((e: EmailMsg) => ['generating', 'queued'].includes(e.status)) ? 3000 : false)
  });
  const items: EmailMsg[] = list.data?.items || [];
  const active = items.find((e) => e._id === activeId) || items.find((e) => e.status === 'pending_approval') || items[0];
  const s = stats.data || {};

  return (
    <>
      <PageHeader title="Outreach" sub="Drafts are written for you from each lead’s evidence. Nothing is sent until you read and approve each one. Every email carries your address and a working unsubscribe link." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="To approve" value={s.pending ?? 0} />
        <Stat label="Sent" value={s.sent ?? 0} />
        <Stat label="Opened" value={s.opened ?? 0} hint="Image tracking undercounts" />
        <Stat label="Replied" value={s.replied ?? 0} />
        <Stat label="Blocked by compliance" value={s.blocked ?? 0} />
      </div>
      <div role="tablist" className="mb-4 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); setActiveId(null); }} className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.id ? 'border-brand text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}>{t.label}</button>
        ))}
      </div>
      {list.isLoading ? <Loading /> : !items.length ? (
        <Empty title={tab.startsWith('pending') ? 'Nothing waiting for approval' : 'Nothing here yet'} action={<Link to="/leads?hasEmail=true" className="btn-primary">Pick leads to email</Link>}>
          Select leads with a public email on the Leads page and choose Write emails.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <ul className="panel max-h-[70vh] divide-y divide-line overflow-auto">
            {items.map((e) => (
              <li key={e._id}>
                <button onClick={() => setActiveId(e._id)} className={`flex w-full items-center gap-3 px-3 py-3 text-left ${active?._id === e._id ? 'bg-teal-50/60' : 'hover:bg-mist/50'}`}>
                  <ScoreRing score={e.leadId?.score} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{e.leadId?.name}</div>
                    <div className="truncate text-xs text-ink-2">{e.status === 'generating' ? 'Writing draft…' : e.subject}</div>
                  </div>
                  {e.compliance && !e.compliance.allowed && e.status === 'pending_approval' && <ShieldAlert className="h-4 w-4 text-hot" aria-label="Compliance issue" />}
                </button>
              </li>
            ))}
          </ul>
          {active && <EmailEditor key={active._id + active.status} email={active} onChange={() => { qc.invalidateQueries({ queryKey: ['emails'] }); qc.invalidateQueries({ queryKey: ['email-stats'] }); }} />}
        </div>
      )}
    </>
  );
}

function EmailEditor({ email, onChange }: { email: EmailMsg; onChange: () => void }) {
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body);
  const [err, setErr] = useState('');
  useEffect(() => { setSubject(email.subject); setBody(email.body); }, [email.subject, email.body]);
  const approve = useMutation({ mutationFn: async () => api.post(`/emails/${email._id}/approve`, { subject, body }), onSuccess: onChange, onError: (e) => setErr(errMsg(e)) });
  const reject = useMutation({ mutationFn: async () => api.post(`/emails/${email._id}/reject`, {}), onSuccess: onChange, onError: (e) => setErr(errMsg(e)) });
  const replied = useMutation({ mutationFn: async () => api.post(`/emails/${email._id}/mark-replied`), onSuccess: onChange });
  const editable = email.status === 'pending_approval';
  const words = body.trim().split(/\s+/).length;

  return (
    <section className="panel p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to={`/leads/${email.leadId?._id}`} className="text-lg font-bold hover:underline">{email.leadId?.name}</Link>
          <div className="text-sm text-ink-2">To {email.to}</div>
        </div>
        <StatusChip status={email.status} />
      </div>
      {err && <div className="mb-3"><Alert>{err}</Alert></div>}
      {email.compliance && (
        <div className={`mb-4 flex gap-2 rounded-lg px-3 py-2 text-sm ${email.compliance.allowed ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'}`}>
          {email.compliance.allowed ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <ShieldAlert className="h-4 w-4 shrink-0" />}
          <div>
            {email.compliance.allowed ? `Meets ${email.compliance.law} checks for ${email.compliance.country}.` : <>Can't be sent yet under {email.compliance.law}: {email.compliance.reasons.join(' ')}</>}
            {!email.compliance.allowed && <> <Link to="/settings" className="font-semibold underline">Fix in settings</Link></>}
          </div>
        </div>
      )}
      {email.status === 'generating' ? (
        <p className="flex items-center gap-2 py-10 text-ink-2"><Spinner /> Writing this draft from the lead's evidence…</p>
      ) : (
        <>
          <label className="label" htmlFor="subj">Subject</label>
          <input id="subj" className="input mb-3" disabled={!editable} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <label className="label" htmlFor="body">Message</label>
          <textarea id="body" className="input min-h-64 leading-relaxed" disabled={!editable} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="mt-1 text-xs text-ink-2">
            {words} words.{email.generatedBy === 'template' ? ' Written from this lead’s evidence using a template; edit it freely before approving.' : ''} Your signature, business address and an unsubscribe link are added automatically.
          </p>
          {email.error && <p className="mt-2 text-sm text-red-700">{email.error}</p>}
          {email.status === 'sent' && (
            <p className="mt-3 text-sm text-ink-2">Sent {fmtTime(email.sentAt)}. Opened {email.opens} time(s).{email.repliedAt ? ' Replied.' : ''}</p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {editable && <button className="btn-danger" disabled={reject.isPending} onClick={() => reject.mutate()}>Reject</button>}
            {editable && <button className="btn-primary" disabled={approve.isPending || subject.length < 3} onClick={() => approve.mutate()}>{approve.isPending && <Spinner />} Approve and send</button>}
            {email.status === 'sent' && !email.repliedAt && <button className="btn-outline" onClick={() => replied.mutate()}>Mark as replied</button>}
          </div>
        </>
      )}
    </section>
  );
}
