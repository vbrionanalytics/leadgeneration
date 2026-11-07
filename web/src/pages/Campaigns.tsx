import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Alert, Empty, Loading, Modal, PageHeader, StatusChip, fmtDate } from '../components/ui';

export default function Campaigns() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['campaigns'], queryFn: async () => (await api.get('/campaigns')).data });
  const upd = useMutation({ mutationFn: async ({ id, ...b }: any) => api.patch(`/campaigns/${id}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['campaigns'] }) });
  return (
    <>
      <PageHeader title="Campaigns" sub="Group outreach by goal and tone, then track opens and replies per campaign." actions={<button className="btn-primary" onClick={() => setOpen(true)}>New campaign</button>} />
      {q.isLoading ? <Loading /> : !q.data?.length ? (
        <Empty title="No campaigns yet" action={<button className="btn-primary" onClick={() => setOpen(true)}>Create a campaign</button>}>A campaign tells the AI what you're offering and how to sound, for example "Website redesign for clinics, friendly tone".</Empty>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="border-b border-line"><tr><th className="th">Campaign</th><th className="th">Status</th><th className="th">Drafts to approve</th><th className="th">Sent</th><th className="th">Open rate</th><th className="th">Replies</th><th className="th"></th></tr></thead>
            <tbody className="divide-y divide-line">
              {q.data.map((c: any) => (
                <tr key={c._id}>
                  <td className="td"><div className="font-semibold">{c.name}</div><div className="text-xs text-ink-2">{c.tone}, created {fmtDate(c.createdAt)}</div></td>
                  <td className="td"><StatusChip status={c.status} /></td>
                  <td className="td">{c.stats.pending}</td>
                  <td className="td">{c.stats.sent}</td>
                  <td className="td">{c.stats.sent ? `${Math.round((c.stats.opened / c.stats.sent) * 100)}%` : '–'}</td>
                  <td className="td">{c.stats.replied}</td>
                  <td className="td text-right">
                    <select className="input w-32" value={c.status} onChange={(e) => upd.mutate({ id: c._id, status: e.target.value })} aria-label="Campaign status">
                      {['draft', 'active', 'paused', 'completed'].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-sm text-ink-2">To write emails for a campaign, select leads on the <Link to="/leads" className="font-semibold text-brand underline">Leads</Link> page and choose Write emails.</p>
      <NewCampaign open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NewCampaign({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', goal: '', tone: 'professional' });
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: async () => api.post('/campaigns', f), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); onClose(); setF({ name: '', goal: '', tone: 'professional' }); }, onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal open={open} onClose={onClose} title="New campaign">
      <form className="space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        {err && <Alert>{err}</Alert>}
        <div><label className="label" htmlFor="cn">Name</label><input id="cn" className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor="cg">Goal</label><textarea id="cg" className="input" placeholder="e.g. Book 15-minute calls with clinics that need a mobile-friendly site" value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} /></div>
        <div><label className="label" htmlFor="ct">Tone</label><select id="ct" className="input" value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}>{['professional', 'friendly', 'concise', 'consultative'].map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>Create campaign</button></div>
      </form>
    </Modal>
  );
}
