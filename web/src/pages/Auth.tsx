import { FormEvent, ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, COUNTRIES, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, ScoreRing, Spinner } from '../components/ui';

function Shell({ children, title, sub }: { children: ReactNode; title: string; sub: string }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_480px]">
      <section className="relative hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <span className="font-display text-xl font-bold">AI LeadGen</span>
        </div>
        <div className="max-w-lg">
          <h1 className="font-display text-5xl font-bold leading-[1.05]">Know which businesses are ready to buy before you write a word.</h1>
          <p className="mt-5 text-lg text-slate-300">Discover businesses, read their websites, and score every lead with the evidence behind it. Nothing is sent until you approve it.</p>
        </div>
        <div className="flex gap-6">
          {[
            { s: 86, n: 'Dental clinic, Coimbatore', why: 'No mobile site, 240 reviews' },
            { s: 58, n: 'Boutique hotel, Kochi', why: 'Slow homepage, no booking' },
            { s: 31, n: 'Law firm, Pune', why: 'Modern site, low fit' }
          ].map((x) => (
            <div key={x.n} className="flex items-center gap-3 rounded-xl bg-white/5 p-3 pr-5">
              <div className="rounded-full bg-white p-0.5 text-ink"><ScoreRing score={x.s} size={46} /></div>
              <div className="text-sm"><div className="font-semibold">{x.n}</div><div className="text-slate-400">{x.why}</div></div>
            </div>
          ))}
        </div>
      </section>
      <section className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold">{title}</h2>
          <p className="mt-1 text-sm text-ink-2">{sub}</p>
          <div className="mt-6">{children}</div>
        </div>
      </section>
    </div>
  );
}

export function LoginPage() {
  const { user, setSession } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const { data } = await api.post('/auth/login', { email, password });
      setSession(data.token, data.user, data.organization);
      nav('/');
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Shell title="Sign in" sub="Welcome back.">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <div><label className="label" htmlFor="email">Work email</label><input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label" htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />} Sign in</button>
        <p className="text-center text-sm text-ink-2">New here? <Link className="font-semibold text-brand hover:underline" to="/register">Create an account</Link></p>
      </form>
    </Shell>
  );
}

export function RegisterPage() {
  const { user, setSession } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', organization: '', country: 'IN' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const { data } = await api.post('/auth/register', f);
      setSession(data.token, data.user, data.organization);
      nav('/settings?welcome=1');
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Shell title="Create your workspace" sub="Free plan includes 50 credits. No card needed.">
      <form onSubmit={submit} className="space-y-4">
        {err && <Alert>{err}</Alert>}
        <div><label className="label" htmlFor="n">Your name</label><input id="n" className="input" required value={f.name} onChange={set('name')} /></div>
        <div><label className="label" htmlFor="o">Company</label><input id="o" className="input" required value={f.organization} onChange={set('organization')} /></div>
        <div><label className="label" htmlFor="e">Work email</label><input id="e" className="input" type="email" required value={f.email} onChange={set('email')} /></div>
        <div><label className="label" htmlFor="p">Password</label><input id="p" className="input" type="password" required minLength={8} value={f.password} onChange={set('password')} /><p className="mt-1 text-xs text-ink-2">At least 8 characters with a letter and a number.</p></div>
        <div><label className="label" htmlFor="c">Main market</label>
          <select id="c" className="input" value={f.country} onChange={set('country')}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></div>
        <button className="btn-primary w-full" disabled={busy}>{busy && <Spinner />} Create account</button>
        <p className="text-center text-sm text-ink-2">Have an account? <Link className="font-semibold text-brand hover:underline" to="/login">Sign in</Link></p>
      </form>
    </Shell>
  );
}
