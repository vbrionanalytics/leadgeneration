import { FormEvent, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, COUNTRIES, errMsg, Org } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Loading, PageHeader, Spinner, fmtDate } from '../components/ui';

const TABS = [['profile', 'Business profile'], ['services', 'Your services'], ['compliance', 'Compliance'], ['team', 'Team'], ['api', 'API keys'], ['suppression', 'Do-not-contact list']] as const;

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'profile';
  const org = useQuery({ queryKey: ['org'], queryFn: async () => (await api.get('/org')).data as Org });
  return (
    <>
      <PageHeader title="Settings" />
      {params.get('welcome') && <div className="mb-4"><Alert tone="info">Welcome! Add your sender details and the services you sell. They are used to score leads and are legally required in outreach emails.</Alert></div>}
      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setParams({ tab: id })} className={`whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-semibold ${tab === id ? 'bg-white text-ink shadow-sm' : 'text-ink-2 hover:bg-white/60'}`}>{label}</button>
          ))}
        </nav>
        <div className="min-w-0">
          {org.isLoading ? <Loading /> : (
            <>
              {tab === 'profile' && <Profile org={org.data!} />}
              {tab === 'services' && <Services org={org.data!} />}
              {tab === 'compliance' && <Compliance org={org.data!} />}
              {tab === 'team' && <Team />}
              {tab === 'api' && <ApiKeys org={org.data!} />}
              {tab === 'suppression' && <Suppression />}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function useSaveOrg() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [state, setState] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const m = useMutation({
    mutationFn: async (b: any) => api.patch('/org', b),
    onSuccess: () => { setState({ tone: 'success', text: 'Saved.' }); qc.invalidateQueries({ queryKey: ['org'] }); refresh(); },
    onError: (e) => setState({ tone: 'error', text: errMsg(e) })
  });
  return { save: m.mutate, saving: m.isPending, state };
}

function Profile({ org }: { org: Org }) {
  const { save, saving, state } = useSaveOrg();
  const [f, setF] = useState({ name: org.name, defaultCountry: org.defaultCountry, ...{ sname: org.sender?.name || '', email: org.sender?.email || '', companyName: org.sender?.companyName || '', postalAddress: org.sender?.postalAddress || '', website: org.sender?.website || '', signature: org.sender?.signature || '' } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save({ name: f.name, defaultCountry: f.defaultCountry, sender: { name: f.sname, email: f.email, companyName: f.companyName, postalAddress: f.postalAddress, website: f.website, signature: f.signature } });
  };
  const fld = (k: keyof typeof f, label: string, props: any = {}) => (
    <div><label className="label" htmlFor={k}>{label}</label><input id={k} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></div>
  );
  return (
    <form onSubmit={submit} className="panel space-y-4 p-5">
      {state && <Alert tone={state.tone}>{state.text}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {fld('name', 'Workspace name', { required: true })}
        <div><label className="label" htmlFor="dc">Main market</label><select id="dc" className="input" value={f.defaultCountry} onChange={(e) => setF({ ...f, defaultCountry: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
      </div>
      <h2 className="pt-2 text-lg font-bold">Who emails come from</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {fld('sname', 'Sender name', { required: true })}
        {fld('email', 'Sender email', { type: 'email', required: true })}
        {fld('companyName', 'Company legal name')}
        {fld('website', 'Company website', { type: 'url', placeholder: 'https://' })}
      </div>
      <div><label className="label" htmlFor="pa">Business postal address</label><textarea id="pa" className="input" required value={f.postalAddress} onChange={(e) => setF({ ...f, postalAddress: e.target.value })} /><p className="mt-1 text-xs text-ink-2">Required by CAN-SPAM, UK PECR and similar laws. Shown in every email footer.</p></div>
      <div><label className="label" htmlFor="sig">Signature</label><textarea id="sig" className="input" placeholder={'Prawin Kumar\nDealpost Private Limited\n+91 …'} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></div>
      <div className="flex justify-end"><button className="btn-primary" disabled={saving}>{saving && <Spinner />} Save changes</button></div>
    </form>
  );
}

function Services({ org }: { org: Org }) {
  const { save, saving, state } = useSaveOrg();
  const [list, setList] = useState(org.services?.length ? org.services : [{ name: '', description: '', priceHint: '' }]);
  const upd = (i: number, k: string, v: string) => setList(list.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  return (
    <form className="panel space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save({ services: list.filter((s) => s.name.trim()) }); }}>
      {state && <Alert tone={state.tone}>{state.text}</Alert>}
      <p className="text-sm text-ink-2">Lead scores measure how much each business needs what you sell, and the AI only recommends services from this list.</p>
      {list.map((s, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_2fr_140px_auto]">
          <input className="input" placeholder="Service, e.g. Website redesign" value={s.name} onChange={(e) => upd(i, 'name', e.target.value)} aria-label="Service name" />
          <input className="input" placeholder="Short description" value={s.description || ''} onChange={(e) => upd(i, 'description', e.target.value)} aria-label="Description" />
          <input className="input" placeholder="Price hint" value={s.priceHint || ''} onChange={(e) => upd(i, 'priceHint', e.target.value)} aria-label="Price hint" />
          <button type="button" className="btn-ghost" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove service"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      <div className="flex justify-between">
        <button type="button" className="btn-outline" onClick={() => setList([...list, { name: '', description: '', priceHint: '' }])}><Plus className="h-4 w-4" /> Add service</button>
        <button className="btn-primary" disabled={saving}>{saving && <Spinner />} Save services</button>
      </div>
    </form>
  );
}

function Compliance({ org }: { org: Org }) {
  const { save, saving, state } = useSaveOrg();
  const rules = useQuery({ queryKey: ['rules'], queryFn: async () => (await api.get('/org/compliance-rules')).data });
  const [li, setLi] = useState(!!org.compliance?.legitimateInterestAssessed);
  const [url, setUrl] = useState(org.compliance?.privacyNoticeUrl || '');
  return (
    <div className="space-y-6">
      <form className="panel space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save({ compliance: { legitimateInterestAssessed: li, privacyNoticeUrl: url } }); }}>
        {state && <Alert tone={state.tone}>{state.text}</Alert>}
        <label className="flex gap-3 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={li} onChange={(e) => setLi(e.target.checked)} />
          <span><b>We have documented a legitimate interest assessment.</b><br /><span className="text-ink-2">Needed before emailing generic business addresses in the UK and EU. Only tick this if you have actually written one.</span></span>
        </label>
        <div><label className="label" htmlFor="pn">Privacy notice URL</label><input id="pn" type="url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourcompany.com/privacy" /></div>
        <div className="flex justify-end"><button className="btn-primary" disabled={saving}>Save</button></div>
      </form>
      <section className="panel p-5">
        <h2 className="text-lg font-bold">Rules applied before every send</h2>
        <p className="mt-1 text-sm text-ink-2">{rules.data?.disclaimer} Have a lawyer review these for the countries you target.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line"><tr><th className="th">Country</th><th className="th">Law</th><th className="th">Generic business email</th><th className="th">Named person</th><th className="th">Opt-out within</th></tr></thead>
            <tbody className="divide-y divide-line">
              {(rules.data?.rules || []).filter((r: any) => r.name.length > 2).map((r: any) => (
                <tr key={r.code} title={r.notes}>
                  <td className="td font-semibold">{r.name}</td><td className="td">{r.law}</td>
                  <td className="td">{r.coldEmailBasis.generic_business.replace(/_/g, ' ')}</td>
                  <td className="td">{r.coldEmailBasis.personal_named.replace(/_/g, ' ')}</td>
                  <td className="td">{r.unsubscribeHonorDays} day(s)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Team() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const members = useQuery({ queryKey: ['members'], queryFn: async () => (await api.get('/org/members')).data });
  const [f, setF] = useState({ name: '', email: '', role: 'member' });
  const [out, setOut] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const add = useMutation({
    mutationFn: async () => (await api.post('/org/members', f)).data,
    onSuccess: (d) => { setOut({ tone: 'success', text: `Added. Share this temporary password privately; they should change it after signing in: ${d.tempPassword}` }); setF({ name: '', email: '', role: 'member' }); qc.invalidateQueries({ queryKey: ['members'] }); },
    onError: (e) => setOut({ tone: 'error', text: errMsg(e) })
  });
  const del = useMutation({ mutationFn: async (id: string) => api.delete(`/org/members/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }), onError: (e) => setOut({ tone: 'error', text: errMsg(e) }) });
  return (
    <div className="space-y-4">
      {out && <Alert tone={out.tone}>{out.text}</Alert>}
      <div className="panel divide-y divide-line">
        {(members.data || []).map((m: any) => (
          <div key={m.id} className="flex items-center justify-between p-4">
            <div><div className="font-semibold">{m.name}{m.id === user?.id && ' (you)'}</div><div className="text-sm text-ink-2">{m.email}, {m.role}</div></div>
            {m.role !== 'owner' && m.id !== user?.id && <button className="btn-ghost" onClick={() => confirm(`Remove ${m.name}?`) && del.mutate(m.id)}>Remove</button>}
          </div>
        ))}
      </div>
      {['owner', 'admin'].includes(user?.role || '') && (
        <form className="panel grid gap-3 p-4 sm:grid-cols-[1fr_1fr_130px_auto]" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input className="input" placeholder="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" />
          <input className="input" placeholder="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Email" />
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
          <button className="btn-primary" disabled={add.isPending}>Add member</button>
        </form>
      )}
    </div>
  );
}

function ApiKeys({ org }: { org: Org }) {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['keys'], queryFn: async () => (await api.get('/org/api-keys')).data });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['leads:read']);
  const [created, setCreated] = useState('');
  const [err, setErr] = useState('');
  const add = useMutation({ mutationFn: async () => (await api.post('/org/api-keys', { name, scopes })).data, onSuccess: (d) => { setCreated(d.key); setName(''); qc.invalidateQueries({ queryKey: ['keys'] }); }, onError: (e) => setErr(errMsg(e)) });
  const revoke = useMutation({ mutationFn: async (id: string) => api.delete(`/org/api-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }) });
  const allowed = ['growth', 'agency'].includes(org.plan);
  useEffect(() => setErr(''), [name]);
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">Use API keys to pull leads into your CRM or start searches from your own tools. Send the key in the <code className="rounded bg-white px-1">X-API-Key</code> header. Keys can't approve or send emails.</p>
      {!allowed && <Alert tone="info">API access is included in the Growth and Agency plans.</Alert>}
      {created && <Alert tone="success">Copy this key now. It won't be shown again: <code className="break-all font-semibold">{created}</code></Alert>}
      {err && <Alert>{err}</Alert>}
      {allowed && (
        <form className="panel flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="min-w-48 flex-1"><label className="label" htmlFor="kn">Key name</label><input id="kn" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. HubSpot sync" /></div>
          <fieldset className="flex gap-3 text-sm">
            <legend className="sr-only">Permissions</legend>
            {['leads:read', 'leads:write', 'search:write'].map((s) => (
              <label key={s} className="flex items-center gap-1.5"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />{s}</label>
            ))}
          </fieldset>
          <button className="btn-primary" disabled={add.isPending || !scopes.length}>Create key</button>
        </form>
      )}
      <div className="panel divide-y divide-line">
        {(keys.data || []).map((k: any) => (
          <div key={k._id} className="flex items-center justify-between p-4">
            <div><div className="font-semibold">{k.name}</div><div className="text-xs text-ink-2">{k.prefix}…, {k.scopes.join(', ')}, last used {k.lastUsedAt ? fmtDate(k.lastUsedAt) : 'never'}</div></div>
            <button className="btn-danger" onClick={() => revoke.mutate(k._id)}>Revoke</button>
          </div>
        ))}
        {!keys.data?.length && <p className="p-4 text-sm text-ink-2">No active keys.</p>}
      </div>
    </div>
  );
}

function Suppression() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['suppressions'], queryFn: async () => (await api.get('/org/suppressions')).data });
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const add = useMutation({ mutationFn: async () => api.post('/org/suppressions', { value, reason: 'manual' }), onSuccess: () => { setValue(''); qc.invalidateQueries({ queryKey: ['suppressions'] }); }, onError: (e) => setErr(errMsg(e)) });
  const del = useMutation({ mutationFn: async (id: string) => api.delete(`/org/suppressions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['suppressions'] }), onError: (e) => setErr(errMsg(e)) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">Addresses here are never emailed. People who unsubscribe are added automatically and can't be removed.</p>
      {err && <Alert>{err}</Alert>}
      <form className="panel flex gap-3 p-4" onSubmit={(e) => { e.preventDefault(); setErr(''); add.mutate(); }}>
        <input className="input" placeholder="name@company.com or @company.com" required value={value} onChange={(e) => setValue(e.target.value)} aria-label="Email or domain" />
        <button className="btn-primary whitespace-nowrap" disabled={add.isPending}>Add</button>
      </form>
      <div className="panel divide-y divide-line">
        {(list.data || []).map((s: any) => (
          <div key={s._id} className="flex items-center justify-between px-4 py-3 text-sm">
            <div><span className="font-semibold">{s.value}</span> <span className="text-ink-2">{s.reason.replace(/_/g, ' ')}, {fmtDate(s.createdAt)}</span></div>
            {!['unsubscribed', 'complaint'].includes(s.reason) && <button className="btn-ghost" onClick={() => del.mutate(s._id)}>Remove</button>}
          </div>
        ))}
        {!list.data?.length && <p className="p-4 text-sm text-ink-2">The list is empty.</p>}
      </div>
    </div>
  );
}
