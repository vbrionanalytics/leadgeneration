import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Loading, PageHeader, fmtTime } from '../components/ui';

declare global { interface Window { Razorpay?: any } }

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load the payment window'));
    document.body.appendChild(s);
  });
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export default function Billing() {
  const { org, user, refresh } = useAuth();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => (await api.get('/billing/plans')).data });
  const bal = useQuery({ queryKey: ['balance'], queryFn: async () => (await api.get('/billing/balance')).data });
  const txns = useQuery({ queryKey: ['txns'], queryFn: async () => (await api.get('/billing/transactions')).data });

  const checkout = useMutation({
    mutationFn: async (b: { kind: string; itemId: string }) => {
      const { data } = await api.post('/billing/checkout', b);
      await loadRazorpay();
      await new Promise<void>((resolve, reject) => {
        const rz = new window.Razorpay({
          key: data.keyId, order_id: data.orderId, amount: data.amount, currency: 'INR', name: 'AI LeadGen',
          prefill: { name: user?.name, email: user?.email }, theme: { color: '#0E6E6E' },
          handler: () => resolve(), modal: { ondismiss: () => reject(new Error('Payment cancelled')) }
        });
        rz.open();
      });
    },
    onSuccess: () => {
      setMsg({ tone: 'success', text: 'Payment received. Credits appear as soon as the payment is confirmed, usually within a minute.' });
      setTimeout(() => { qc.invalidateQueries(); refresh(); }, 4000);
    },
    onError: (e) => setMsg({ tone: 'error', text: errMsg(e) })
  });

  if (plans.isLoading) return <Loading />;
  const p = plans.data;
  const current = bal.data?.plan || org?.plan;

  return (
    <>
      <PageHeader title="Plan & credits" sub={`You have ${bal.data?.credits ?? 0} credits on the ${current} plan.`} />
      {msg && <div className="mb-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {!p.paymentsEnabled && <div className="mb-4"><Alert tone="info">Online payments aren't switched on for this workspace yet. Contact the platform team to change plans or add credits.</Alert></div>}

      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-2">
        <span>New lead from search: <b className="text-ink">{p.costs.discoveredLead} credit</b></span>
        <span>Website analysis and score: <b className="text-ink">{p.costs.analysis} credits</b></span>
        <span>Email draft: <b className="text-ink">{p.costs.emailDraft ? `${p.costs.emailDraft} credit` : 'free'}</b></span>
        <span>Duplicates and sending: <b className="text-ink">free</b></span>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {p.plans.map((pl: any) => {
          const isCurrent = pl.id === current;
          return (
            <section key={pl.id} className={`panel flex flex-col p-5 ${isCurrent ? 'border-brand ring-1 ring-brand' : ''}`}>
              <h2 className="text-lg font-bold">{pl.name}</h2>
              <div className="mt-2"><span className="font-display text-3xl font-bold">{pl.priceInrMonthly ? inr(pl.priceInrMonthly) : 'Free'}</span>{pl.priceInrMonthly > 0 && <span className="text-sm text-ink-2"> /month</span>}</div>
              <p className="mt-1 text-sm text-ink-2">{pl.monthlyCredits.toLocaleString('en-IN')} credits, {pl.seats} seat{pl.seats > 1 ? 's' : ''}, up to {pl.maxResultsPerSearch} results per search</p>
              <ul className="mt-4 flex-1 space-y-1.5 text-sm">{pl.features.map((f: string) => <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />{f}</li>)}</ul>
              <button className={isCurrent ? 'btn-outline mt-5' : 'btn-primary mt-5'} disabled={isCurrent || !pl.priceInrMonthly || !p.paymentsEnabled || checkout.isPending} onClick={() => checkout.mutate({ kind: 'plan', itemId: pl.id })}>
                {isCurrent ? 'Current plan' : pl.priceInrMonthly ? `Switch to ${pl.name}` : 'Free'}
              </button>
            </section>
          );
        })}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold">Top up credits</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {p.packs.map((k: any) => (
          <div key={k.id} className="panel flex items-center justify-between p-4">
            <div><div className="font-display text-xl font-bold">{k.credits.toLocaleString('en-IN')} credits</div><div className="text-sm text-ink-2">{inr(k.priceInr)}, never expire</div></div>
            <button className="btn-outline" disabled={!p.paymentsEnabled || checkout.isPending} onClick={() => checkout.mutate({ kind: 'credit_pack', itemId: k.id })}>Buy</button>
          </div>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold">Credit history</h2>
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead className="border-b border-line"><tr><th className="th">When</th><th className="th">What</th><th className="th text-right">Credits</th><th className="th text-right">Balance</th></tr></thead>
          <tbody className="divide-y divide-line">
            {(txns.data || []).map((t: any) => (
              <tr key={t._id}><td className="td whitespace-nowrap text-ink-2">{fmtTime(t.createdAt)}</td><td className="td">{t.reason}</td><td className={`td text-right font-semibold ${t.amount > 0 ? 'text-emerald-700' : ''}`}>{t.amount > 0 ? '+' : ''}{t.amount}</td><td className="td text-right text-ink-2">{t.balanceAfter ?? '–'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
