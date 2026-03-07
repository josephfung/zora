import { useState, useEffect } from 'react';

interface TLCISnapshot {
  todayStepsByTier: { code: number; slm: number; frontier: number };
  todaySavingsUSD: number;
  todayCostUSD: number;
  last100StepsTierDistribution: { code: number; slm: number; frontier: number };
  planCacheHitRate: number;
  allTimeSavingsUSD: number;
  allTimeExecutions: number;
  vsAllLLMMessage: string;
}

function TierBar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-neutral-400">{label}</span>
      <div className="flex-1 bg-neutral-700 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-neutral-300">{pct}%</span>
    </div>
  );
}

export function TLCIPanel() {
  const [snapshot, setSnapshot] = useState<TLCISnapshot | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    // Don't poll once disabled — stops unnecessary background requests
    if (!enabled) return;

    const fetchStats = async () => {
      try {
        const res = await fetch('/api/tlci-stats');
        // Hide panel if TLCI not enabled (503) or auth not configured for this route (401/403)
        if (res.status === 503 || res.status === 401 || res.status === 403) { setEnabled(false); return; }
        if (!res.ok) return;
        setSnapshot(await res.json() as TLCISnapshot);
      } catch {
        // network error — ignore, retry next interval
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, [enabled]);

  if (!enabled) return null;

  if (!snapshot) return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-4 text-neutral-500 text-xs">
      Loading TLCI stats...
    </div>
  );

  const total = snapshot.last100StepsTierDistribution.code +
    snapshot.last100StepsTierDistribution.slm +
    snapshot.last100StepsTierDistribution.frontier;
  // No steps yet — show 0% for all tiers. Compute each independently to avoid negative
  // values when rounding causes codePct + slmPct to exceed 100.
  const codePct = total === 0 ? 0 : Math.round((snapshot.last100StepsTierDistribution.code / total) * 100);
  const slmPct = total === 0 ? 0 : Math.round((snapshot.last100StepsTierDistribution.slm / total) * 100);
  const frontierPct = total === 0 ? 0 : Math.round((snapshot.last100StepsTierDistribution.frontier / total) * 100);

  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-200">TLCI Cost Tracker</h3>
        <span className="text-xs text-emerald-400 font-medium">{snapshot.vsAllLLMMessage}</span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400">
        <span>Today: <span className="text-neutral-200">${snapshot.todayCostUSD.toFixed(4)}</span></span>
        <span>Saved today: <span className="text-emerald-400">${snapshot.todaySavingsUSD.toFixed(4)}</span></span>
        <span>Cache: <span className="text-neutral-200">{Math.round(snapshot.planCacheHitRate * 100)}%</span></span>
        <span>All-time: <span className="text-emerald-400">${snapshot.allTimeSavingsUSD.toFixed(2)} saved</span></span>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-neutral-500">Step distribution (last 100)</p>
        <TierBar label="Code" pct={codePct} color="bg-blue-500" />
        <TierBar label="SLM" pct={slmPct} color="bg-purple-500" />
        <TierBar label="Frontier" pct={frontierPct} color="bg-amber-500" />
      </div>
    </div>
  );
}
