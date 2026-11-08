import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts';
import { api, Lead } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Empty, Loading, PageHeader, ScoreRing, Stat, StatusChip } from '../components/ui';

const BUCKETS = ['0–19', '20–39', '40–59', '60–79', '80–100'];
const BUCKET_COLORS = ['var(--color-cold)', 'var(--color-cold)', 'var(--color-warm)', 'var(--color-hot)', 'var(--color-hot)'];

export default function Dashboard() {
  const { org } = useAuth();
  const stats = useQuery({ queryKey: ['lead-stats'], queryFn: async () => (await api.get('/leads/stats')).data });
  const email = useQuery({ queryKey: ['email-stats'], queryFn: async () => (await api.get('/emails/stats')).data });
  const hot = useQuery({ queryKey: ['leads', 'hot'], queryFn: async () => (await api.get('/leads', { params: { sort: '-score', minScore: 60, limit: 6 } })).data });
  const jobs = useQuery({ queryKey: ['searches'], queryFn: async () => (await api.get('/searches')).data });

  if (stats.isLoading) return <Loading />;
  const s = stats.data || { total: 0, analysed: 0, byStatus: {}, scoreBuckets: [0, 0, 0, 0, 0], daily: {} };
  const e = email.data || {};
  const setupMissing = !org?.sender?.postalAddress || !org?.services?.length;

  return (
    <>
      <PageHeader title={`Good to see you${org?.sender?.name ? `, ${org.sender.name.split(' ')[0]}` : ''}`} sub="Where your pipeline stands today." actions={<Link to="/search" className="btn-primary">Find businesses</Link>} />
      {setupMissing && (
        <div className="mb-6"><Alert tone="warn">Finish setup before outreach: add your services (used to match leads) and your business postal address (legally required in email footers). <Link to="/settings" className="font-semibold underline">Open settings</Link></Alert></div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Leads" value={s.total} hint={`${s.analysed} analysed`} />
        <Stat label="Qualified" value={(s.byStatus.qualified || 0) + (s.byStatus.contacted || 0) + (s.byStatus.replied || 0) + (s.byStatus.won || 0)} hint="Score 60+ or worked" />
        <Stat label="Awaiting your approval" value={e.pending ?? 0} hint="Drafts to review" />
        <Stat label="Emails sent" value={e.sent ?? 0} hint={e.sent ? `${Math.round(((e.opened || 0) / e.sent) * 100)}% opened, ${e.replied || 0} replied` : 'None yet'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="panel p-5">
          <h2 className="text-lg font-bold">Lead temperature</h2>
          <p className="text-sm text-ink-2">How your analysed leads are distributed by score.</p>
          <div className="mt-4 h-56">
            {s.analysed ? (
              <ResponsiveContainer>
                <BarChart data={s.scoreBuckets.map((v: number, i: number) => ({ b: BUCKETS[i], v }))} margin={{ left: -20 }}>
                  <XAxis dataKey="b" tickLine={false} axisLine={false} fontSize={12} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
                  <Tooltip cursor={{ fill: '#F3F5F8' }} formatter={(v) => [v, 'Leads']} />
                  <Bar dataKey="v" radius={[6, 6, 0, 0]}>{BUCKETS.map((_, i) => <Cell key={i} fill={BUCKET_COLORS[i]} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="grid h-full place-items-center text-sm text-ink-2">Analyse leads to see their scores here.</div>
            )}
          </div>
        </section>

        <section className="panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">Hottest leads</h2>
            <Link to="/leads?sort=-score" className="text-sm font-semibold text-brand hover:underline">All leads</Link>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {(hot.data?.items || []).map((l: Lead) => (
              <li key={l._id}>
                <Link to={`/leads/${l._id}`} className="flex items-center gap-3 py-2.5 hover:bg-mist/60">
                  <ScoreRing score={l.score} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{l.name}</div>
                    <div className="truncate text-xs text-ink-2">{l.opportunities?.[0]?.title || l.category} in {l.city}</div>
                  </div>
                  <StatusChip status={l.status} />
                </Link>
              </li>
            ))}
          </ul>
          {!hot.data?.items?.length && <p className="py-8 text-center text-sm text-ink-2">No leads scored 60+ yet.</p>}
        </section>
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-lg font-bold">Recent searches</h2>
        {jobs.data?.length ? (
          <div className="panel overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line"><tr><th className="th">Search</th><th className="th">Status</th><th className="th">New leads</th><th className="th">Duplicates skipped</th><th className="th">Credits</th></tr></thead>
              <tbody className="divide-y divide-line">
                {jobs.data.slice(0, 5).map((j: any) => (
                  <tr key={j._id}>
                    <td className="td"><Link className="font-semibold hover:underline" to={`/leads?searchJobId=${j._id}`}>{j.query.category}</Link> <span className="text-ink-2">in {j.query.city ? `${j.query.city}, ` : ''}{j.query.country}</span></td>
                    <td className="td"><StatusChip status={j.status} /></td>
                    <td className="td">{j.stats.created}</td>
                    <td className="td">{j.stats.duplicates}</td>
                    <td className="td">{j.stats.creditsUsed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No searches yet" action={<Link to="/search" className="btn-primary">Run your first search</Link>}>Pick a business category and a city. New businesses become leads; ones you already have are skipped.</Empty>
        )}
      </section>
    </>
  );
}
